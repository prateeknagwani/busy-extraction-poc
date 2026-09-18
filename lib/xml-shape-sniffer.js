const { XMLParser, XMLBuilder } = require("fast-xml-parser");

/**
 * Generic "what does this XML actually look like" tool — walks the parsed tree
 * and reports, for every element name seen anywhere, how many times it repeats
 * as a sibling and what child field names it carries. This is how a NEW Busy
 * export (Ledgers, Stock Items, Sales/Purchase/Receipt/Payment vouchers — none
 * of which is confirmed yet, unlike <SaleOrder>) gets its shape discovered
 * instead of guessed. Point it at a real Busy export and read output/*.json.
 */
function sniffShape(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Busy's confirmed SaleOrder export can have exactly one <SaleOrder> at the
    // root for a single-voucher export — without this, fast-xml-parser would
    // give that single element as a plain object instead of a 1-element array,
    // making "is this repeating" detection inconsistent between exports.
    isArray: () => false,
  });

  const parsed = parser.parse(xmlString);
  const shapeByTag = {};

  function walk(node, tagName) {
    if (node === null || typeof node !== "object") return;

    if (!shapeByTag[tagName]) {
      shapeByTag[tagName] = { seenCount: 0, childFields: new Set(), sampleValues: {} };
    }
    const entry = shapeByTag[tagName];
    entry.seenCount += 1;

    for (const [key, value] of Object.entries(node)) {
      entry.childFields.add(key);
      if (value !== null && typeof value === "object") {
        // A repeated child element becomes an array under fast-xml-parser's default
        // heuristics once >1 sibling appears — walk each occurrence separately so
        // the count reflects real repetition, not just "seen once as a container".
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) walk(child, key);
      } else if (entry.sampleValues[key] === undefined) {
        entry.sampleValues[key] = value;
      }
    }
  }

  walk(parsed, "#root");

  const report = {};
  for (const [tag, entry] of Object.entries(shapeByTag)) {
    report[tag] = {
      occurrences: entry.seenCount,
      childFields: Array.from(entry.childFields),
      sampleValues: entry.sampleValues,
    };
  }
  return report;
}

/**
 * Targeted parser for the ONE Busy export shape already confirmed against real
 * production data (backend/app/services/xml_parser.py::parse_so_xml) — reused
 * here as a known-good baseline: if this doesn't parse a real export cleanly,
 * something more fundamental (encoding, wrapper structure) is wrong before
 * even getting to the unconfirmed voucher/ledger types.
 */
function parseConfirmedSaleOrderShape(xmlString) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xmlString);

  function findAll(node, tagName, results = []) {
    if (node === null || typeof node !== "object") return results;
    for (const [key, value] of Object.entries(node)) {
      if (key === tagName) {
        const items = Array.isArray(value) ? value : [value];
        results.push(...items);
      } else if (typeof value === "object") {
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) findAll(child, tagName, results);
      }
    }
    return results;
  }

  const items = findAll(parsed, "Item");
  const aliasMap = {};
  for (const item of items) {
    if (item.Name) aliasMap[item.Name] = item.Alias || "";
  }

  const saleOrders = findAll(parsed, "SaleOrder");
  return saleOrders.map((so) => {
    const itemDetails = findAll(so, "ItemDetail");
    return {
      soNumber: so.VchNo,
      seriesName: so.VchSeriesName,
      partyName: so.MasterName1,
      busyTotal: so.tmpTotalAmt,
      items: itemDetails.map((d) => ({
        sku: d.ItemName,
        alias: aliasMap[d.ItemName] || "",
        qty: d.Qty,
        mrp: d.ItemMRP || d.ListPrice,
      })),
    };
  });
}

module.exports = { sniffShape, parseConfirmedSaleOrderShape };
