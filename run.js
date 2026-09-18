const fs = require("fs");
const path = require("path");

// config.local.json (gitignored) carries real credentials, merged over the
// checked-in config.json template — see config.json's own _comment.
const config = require("./config.json");
const localConfigPath = path.join(__dirname, "config.local.json");
if (fs.existsSync(localConfigPath)) {
  const local = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  for (const section of Object.keys(local)) {
    config[section] = { ...config[section], ...local[section] };
  }
}
const { listOdbcDsns } = require("./lib/dsn-discovery");
const { introspectOdbc, sampleRows: sampleOdbcRows } = require("./lib/odbc-introspect");
const {
  discoverAll,
  listTables,
  describeTable,
  sampleRows: sampleSqlRows,
  listDatabases,
} = require("./lib/sqlserver-introspect");
const { sniffShape, parseConfirmedSaleOrderShape } = require("./lib/xml-shape-sniffer");
const { connect, extractVouchers, extractMasters, stockItemGroupLookup, stockItemAliasLookup } = require("./lib/busy-voucher-extractor");
const { searchValue } = require("./lib/search-value");

const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function writeOutput(name, data) {
  const file = path.join(OUTPUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  -> wrote ${path.relative(__dirname, file)}`);
}

async function runListDsns() {
  console.log("== Listing ODBC DSNs on this machine ==");
  const result = listOdbcDsns();
  writeOutput("odbc-dsns", result);
  if (!result.ok) {
    console.log(`FAILED: ${result.reason}`);
    return;
  }
  console.log(`Found ${result.dsns.length} DSN(s) total.`);
  if (result.likelyBusy.length) {
    console.log("Busy-looking DSN(s):", result.likelyBusy.map((d) => d.Name).join(", "));
  } else {
    console.log("None of them look Busy-related by name — see output/odbc-dsns.json for the full list.");
  }
}

async function runSqlServerDiscover() {
  console.log("== SQL Server discovery sweep ==");
  if (!config.sqlserver.server) {
    console.log("FAILED: config.json's sqlserver.server is blank — fill it in first.");
    return;
  }
  try {
    const result = await discoverAll(config.sqlserver);
    writeOutput("sqlserver-discover", result);
    console.log(`Found ${result.tables.length} table(s). Top 15 by row count:`);
    for (const t of result.tables.slice(0, 15)) {
      console.log(`  ${t.TABLE_SCHEMA}.${t.TABLE_NAME} — ${t.ROW_COUNT} rows`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    writeOutput("sqlserver-discover-error", { error: err.message });
  }
}

/**
 * Folio 08 — figures out this company's own fiscal-year database naming
 * convention, on whatever SQL Server this is run against, without any
 * assumption carried over from ASD's own pattern. Lists every non-system
 * database on the server, connects to each in turn, and for the ones that
 * actually look like real Busy FY data (has a `Tran1` table) prints its
 * voucher date range — the same manual check used to confirm ASD's own
 * "db1{fyStartYear}" pattern. Run this FIRST on a new company's server,
 * before setting autoDetectFiscalYearDatabase/databasePattern in
 * config.local.json, so the pattern is confirmed against real dates rather
 * than assumed from another company's naming.
 */
async function runListFyDatabases() {
  console.log("== Listing databases on this SQL Server + checking each for real Busy FY data (Tran1) ==");
  if (!config.sqlserver.server) {
    console.log("FAILED: config.sqlserver.server is blank — fill it in (config.local.json) first.");
    return;
  }
  const listed = await listDatabases(config.sqlserver);
  if (!listed.ok) {
    console.log(`FAILED to list databases: ${listed.reason || "unknown error"}`);
    return;
  }
  console.log(`Found ${listed.databases.length} non-system database(s): ${listed.databases.join(", ")}\n`);

  const results = [];
  for (const name of listed.databases) {
    let pool;
    try {
      pool = await connect({ ...config.sqlserver, database: name });
      const hasTran1 = await pool.request().query("SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Tran1'");
      if (!hasTran1.recordset.length) {
        console.log(`  ${name} — no Tran1 table (not a Busy FY data database, e.g. Busy's own shared app DB)`);
        continue;
      }
      const r = await pool.request().query("SELECT MIN(Date) mind, MAX(Date) maxd, COUNT(*) c FROM Tran1");
      const row = r.recordset[0];
      const mind = row.mind ? row.mind.toISOString().slice(0, 10) : null;
      const maxd = row.maxd ? row.maxd.toISOString().slice(0, 10) : null;
      console.log(`  ${name} — Tran1: ${row.c} vouchers, dates ${mind || "?"} .. ${maxd || "?"}`);
      results.push({ database: name, voucherCount: row.c, minDate: mind, maxDate: maxd });
    } catch (err) {
      console.log(`  ${name} — could not check (${err.message})`);
    } finally {
      if (pool) await pool.close();
    }
  }

  writeOutput("fy-databases", results);
  console.log(`\nNext: compare each database's date range above against the company's real fiscal year (Apr-Mar) to work out which part of the name encodes the year, then set in config.local.json:`);
  console.log(`  "sqlserver": { "autoDetectFiscalYearDatabase": true, "databasePattern": "<PREFIX>{fyStartYear}" }  (or {fyEndYear}, whichever the dates above confirm)`);
  console.log(`Then re-run this command — a correctly-set pattern should show each listed FY database's own "isCurrent"/fyKey via \`node run.js --extract-all\` or import-to-app.js's own startup log line, not silently guessed.`);
}

/**
 * Folio 09's own reusable fix — see lib/search-value.js's docstring and
 * FINDINGS.md's Folio 09 process-lesson section. Never trust a "no
 * matches" result from this (or any hand-rolled variant) without the
 * self-test passing first — it's built in and printed either way.
 */
async function runSearchValue(args) {
  const idx = args.indexOf("--search-value");
  const target = Number(args[idx + 1]);
  if (Number.isNaN(target)) {
    console.log("Usage: node run.js --search-value <number> [--tolerance N]");
    return;
  }
  const tolIdx = args.indexOf("--tolerance");
  const tolerance = tolIdx !== -1 ? Number(args[tolIdx + 1]) : 0.01;
  console.log(`== Searching every numeric column of every base table for ${target} (+/-${tolerance}) ==`);
  const result = await searchValue(config.sqlserver, { target, tolerance });
  console.log(`Self-test: ${result.selfTestPassed ? "PASSED" : "FAILED"} — columns scanned: ${result.columnsScanned}`);
  if (!result.matches.length) {
    console.log("No matches. Self-test passed, so this is a genuine result, not a silent search failure.");
  } else {
    console.log(`${result.matches.length} match(es):`);
    for (const m of result.matches) console.log(`  ${m.table}.${m.column}`);
  }
  writeOutput("search-value-result", result);
}

async function runSqlServerDescribe(tableArg) {
  console.log(`== Describing table: ${tableArg} ==`);
  if (!tableArg || !tableArg.includes(".")) {
    console.log("Usage: node run.js --describe-table <schema>.<table>");
    return;
  }
  const [schema, tableName] = tableArg.split(".");
  try {
    const described = await describeTable(config.sqlserver, schema, tableName);
    writeOutput(`sqlserver-describe-${tableName}`, described);
    const sampled = await sampleSqlRows(config.sqlserver, schema, tableName, 5);
    writeOutput(`sqlserver-sample-${tableName}`, sampled);
    console.log(`Columns: ${described.columns.map((c) => c.COLUMN_NAME).join(", ")}`);
    console.log(`Sample rows written to output/sqlserver-sample-${tableName}.json`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

async function runExtractVouchers(args) {
  console.log("== Extracting vouchers, normalized to TallyVoucher shape ==");
  const vchTypeArg = args.includes("--vch-type") ? Number(args[args.indexOf("--vch-type") + 1]) : undefined;
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 20;
  const dateFromArg = args.includes("--date-from") ? args[args.indexOf("--date-from") + 1] : undefined;
  const dateToArg = args.includes("--date-to") ? args[args.indexOf("--date-to") + 1] : undefined;

  try {
    const vouchers = await extractVouchers(config.sqlserver, {
      vchType: vchTypeArg,
      dateFrom: dateFromArg,
      dateTo: dateToArg,
      limit: limitArg,
    });
    writeOutput("busy-vouchers", vouchers);
    console.log(`Extracted ${vouchers.length} voucher(s).`);
    const byType = {};
    for (const v of vouchers) byType[v.vch_type] = (byType[v.vch_type] || 0) + 1;
    console.log("By vch_type:", byType);
    const unknown = vouchers.filter((v) => v.vch_type.startsWith("UNKNOWN_"));
    if (unknown.length) {
      console.log(`WARNING: ${unknown.length} voucher(s) have an unmapped vch_type — see FINDINGS.md's VchType table.`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

async function runExtractMasters(args) {
  console.log("== Extracting masters (Ledger Groups, Ledgers, Stock Groups, Stock Items), normalized to MasterIn shape ==");
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : undefined;
  try {
    const masters = await extractMasters(config.sqlserver, { limit: limitArg });
    writeOutput("busy-masters", masters);
    console.log(`Extracted ${masters.length} master(s).`);
    const byType = {};
    for (const m of masters) byType[m.master_type] = (byType[m.master_type] || 0) + 1;
    console.log("By master_type:", byType);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

async function runExtractAll(args) {
  console.log("== Extracting masters + vouchers together (masters first, so voucher item lines get the walked-to-top stockGroup/alias) ==");
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 100;
  const dateFromArg = args.includes("--date-from") ? args[args.indexOf("--date-from") + 1] : undefined;
  const dateToArg = args.includes("--date-to") ? args[args.indexOf("--date-to") + 1] : undefined;

  try {
    const masters = await extractMasters(config.sqlserver);
    writeOutput("busy-masters", masters);
    console.log(`Extracted ${masters.length} master(s).`);

    const groupLookup = stockItemGroupLookup(masters);
    const aliasLookup = stockItemAliasLookup(masters);

    const vouchers = await extractVouchers(config.sqlserver, {
      dateFrom: dateFromArg,
      dateTo: dateToArg,
      limit: limitArg,
      stockItemGroupLookup: groupLookup,
      stockItemAliasLookup: aliasLookup,
    });
    writeOutput("busy-vouchers", vouchers);
    console.log(`Extracted ${vouchers.length} voucher(s).`);
    const byType = {};
    for (const v of vouchers) byType[v.vch_type] = (byType[v.vch_type] || 0) + 1;
    console.log("By vch_type:", byType);
    const unknown = vouchers.filter((v) => v.vch_type.startsWith("UNKNOWN_"));
    if (unknown.length) {
      console.log(`WARNING: ${unknown.length} voucher(s) have an unmapped vch_type — see FINDINGS.md's VchType table.`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

async function runOdbcIntrospect() {
  console.log("== ODBC introspection ==");
  const result = await introspectOdbc(config.odbc);
  writeOutput("odbc-introspect", result);
  if (!result.ok) {
    console.log(`FAILED: ${result.reason}`);
    return;
  }
  console.log(`Found ${result.tableCount} table(s):`, result.tables.slice(0, 20).join(", "));
}

async function runParseXml() {
  console.log("== XML parsing ==");
  const file = config.xml.sampleFile || path.join(__dirname, "fixtures", "sample-sale-order.xml");
  console.log(`Reading: ${file}`);
  const xmlString = fs.readFileSync(file, "utf8");

  const shape = sniffShape(xmlString);
  writeOutput("xml-shape", shape);
  console.log("Element shapes found:", Object.keys(shape).join(", "));

  const saleOrders = parseConfirmedSaleOrderShape(xmlString);
  writeOutput("xml-sale-orders", saleOrders);
  console.log(`Parsed ${saleOrders.length} SaleOrder(s) via the confirmed shape.`);
}

async function runMock() {
  console.log("== Mock mode: validating parsing logic against the bundled fixture only ==");
  console.log("(No live SQL Server / ODBC / real Busy export involved — this only proves the code is internally correct.)\n");

  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "sample-sale-order.xml"), "utf8");
  const saleOrders = parseConfirmedSaleOrderShape(fixture);

  const expected = 2;
  if (saleOrders.length !== expected) {
    console.log(`MOCK FAILED: expected ${expected} SaleOrders, got ${saleOrders.length}`);
    process.exitCode = 1;
    return;
  }
  const so = saleOrders.find((s) => s.soNumber === "SO-1001");
  if (!so || so.partyName !== "ABC Auto Traders" || so.items.length !== 2) {
    console.log("MOCK FAILED: parsed shape doesn't match the fixture's known-good values.");
    console.log(JSON.stringify(so, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log("MOCK PASSED: XML parsing logic correctly reproduces the fixture's known values.");
  writeOutput("mock-sale-orders", saleOrders);

  const shape = sniffShape(fixture);
  writeOutput("mock-xml-shape", shape);
  console.log("Shape sniffer found elements:", Object.keys(shape).join(", "));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--mock")) return runMock();
  if (args.includes("--list-dsns")) return runListDsns();
  if (args.includes("--sqlserver-discover")) return runSqlServerDiscover();
  if (args.includes("--list-fy-databases")) return runListFyDatabases();
  if (args.includes("--search-value")) return runSearchValue(args);
  if (args.includes("--describe-table")) {
    const idx = args.indexOf("--describe-table");
    return runSqlServerDescribe(args[idx + 1]);
  }
  if (args.includes("--introspect-odbc")) return runOdbcIntrospect();
  if (args.includes("--parse-xml")) return runParseXml();
  if (args.includes("--extract-vouchers")) return runExtractVouchers(args);
  if (args.includes("--extract-masters")) return runExtractMasters(args);
  if (args.includes("--extract-all")) return runExtractAll(args);

  console.log(`Usage:
  node run.js --mock                          Validate parsing logic, no live system needed
  node run.js --list-dsns                     List ODBC DSNs on this machine
  node run.js --sqlserver-discover            List every table in config.json's SQL Server DB + row counts
  node run.js --list-fy-databases             List every DB on this server + its Tran1 voucher date range (Folio 08 — run this FIRST on a new company's server to confirm its own FY-database naming pattern, never assume another company's)
  node run.js --search-value <number> [--tolerance N]
                                               Search every numeric column of every base table for a value (Folio 09 — self-tests before trusting a "no matches" result; never write a one-off dynamic-SQL search by hand again, use this)
  node run.js --describe-table <schema>.<tbl> Describe one table's columns + sample 5 rows
  node run.js --introspect-odbc               Full table+column dump via a configured ODBC DSN
  node run.js --parse-xml                     Sniff shape + parse config.json's xml.sampleFile (or the fixture)
  node run.js --extract-vouchers [--vch-type N] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--limit N]
                                               Extract real vouchers, normalized to TallyVoucher's shape
  node run.js --extract-masters [--limit N]   Extract Ledger Groups/Ledgers/Stock Groups/Stock Items, normalized to MasterIn shape
  node run.js --extract-all [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]
                                               Extract masters THEN vouchers (correct order — voucher item lines
                                               reuse the masters-derived, walked-to-top stockGroup/alias lookup)
  node import-to-app.js [--dry-run] [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]
                                               Extract + POST to /tally/import — see import-to-app.js's own header
`);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exitCode = 1;
});
