const sql = require("mssql");

/**
 * Normalizes Busy's Tran1/Tran2/Master1 voucher AND master data into the
 * EXACT shapes `POST /tally/import`'s `VoucherIn`/`MasterIn` expect
 * (backend/app/routers/tally_router.py) — the deliberate goal per the Sync
 * Ledger plan (Folio 02): once these shapes match, every one of Tally
 * Mode's ~40 insight endpoints can run over Busy-sourced rows without their
 * own code changing, only which rows get UNIONed in.
 *
 * Voucher shape (one object per voucher):
 *   { guid, vch_type, vch_no, date: "YYYY-MM-DD", party_name, amount,
 *     lines: { items: [{stockItemName, amount, quantity, unit, rate, discount, stockGroup, itemAlias}],
 *              ledger: [{ledgerName, amount, drCr}] },
 *     is_optional, source: "BUSY" }
 *
 * Master shape (one object per Ledger Group / Ledger / Stock Group / Stock
 * Item — mirrors tally_sync.py's MASTER_TYPE_BY_TARGET_NAME labels exactly,
 * "GROUP"/"LEDGER"/"STOCK_GROUP"/"STOCK_ITEM", so Busy-sourced masters are
 * indistinguishable in shape from Tally-sourced ones downstream):
 *   { guid, master_type, name, dealer_code: null, brand_category, fields }
 *
 * Confirmed facts this relies on (see FINDINGS.md — nothing here is
 * guessed):
 *   - Master1.MasterType: 1=Ledger Group, 2=Ledger, 5=Stock Group, 6=Stock Item.
 *   - Tran2.RecType: 1 = ledger leg, 2 = stock-item leg.
 *   - Tran2.Value1 sign IS a true double-entry Dr(-)/Cr(+) per line (unlike
 *     Tally, where the sign is one direction for the WHOLE voucher) —
 *     confirmed on a real Sales voucher: party leg negative, Sales/tax legs
 *     positive, which is standard accounting sign, not a Tally-style quirk.
 *   - Tran1.VchSalePurcAmt is the ex-tax GOODS subtotal, NOT the true
 *     invoice total — confirmed by comparing it (6508.32) against the same
 *     voucher's ledger-leg-reconciled total (7680.00, matching what a human
 *     would call "the invoice amount"). `amount` here is ALWAYS computed via
 *     the ledger-leg max(ΣCr, ΣDr) reconciliation, mirroring Tally's own
 *     `totalFromLedger()` — never Tran1.VchSalePurcAmt directly.
 *   - Item leg D-column decode (confirmed by exact arithmetic match across
 *     6 real lines on one invoice, not eyeballed): D9 = discount %
 *     (whole number), D4 = MRP / list price (incl-tax, PRE-discount),
 *     D2 = D3 = post-discount incl-tax rate (D4 * (1 - D9/100), verified
 *     exact to the paisa), D6 = post-discount EX-tax rate (D6 * qty =
 *     abs(Value3), the ex-tax line value already pulled off Tran2 directly).
 *     `rate` sent to the app is still always DERIVED (amount/quantity, i.e.
 *     from D6), never trusted from a raw column, same rule Tally's own sync
 *     applies to its RATE tag — D2/D4 exist only to derive `discount`.
 *   - Stock Group DOES nest in this dealer's real data (2 of 5 groups: e.g.
 *     "18-Honda-Running"/"18-Honda-Others" both parent to top-level "Honda")
 *     — so an item's `stockGroup` must be the TOPMOST Stock Group in the
 *     chain, exactly like Tally's own STOCK_GROUP.Parent walk
 *     (tally_sync.py::_top_level_stock_group) — a Busy Stock Group's
 *     terminal sentinel is ParentGrp=0 (vs. Tally's literal "Primary"
 *     string), everything else about the walk is identical.
 *   - Tran1.VchType: confirmed against the FULL live Tran1 table (not a
 *     sampled window) that only 7 codes exist AT ALL in this database's
 *     whole history: 2,3,5,9,12,14,16 (see VCH_TYPE_MAP). Receipt never
 *     appears — genuinely absent from this dealer's data (cash sales are
 *     evidently never booked as a separate Receipt voucher here), not an
 *     extraction gap. No code needs to guess at a Receipt mapping.
 *   - **VchType codes are NOT a fixed global Busy convention — confirmed
 *     per-company (Folio 07)**: a second, genuinely different company's
 *     database used 8 codes this first company's data never produced at
 *     all (8,10,13,15,17,18,19,61), while this first company's own 12
 *     (Sales Order) and 5 (Stock Journal) didn't appear in the second
 *     company's data either. VCH_TYPE_MAP below is the UNION across every
 *     company confirmed so far, not a single universal table — a NEW
 *     company's data can still surface a code neither company has used yet,
 *     and every code's real identity must be sampled fresh (VchNo prefix +
 *     Tran2 ledger/item legs), never assumed from another company's mapping.
 *   - Sales Order (VchType 12) is a non-accounting voucher — it never posts
 *     to Tran2 at all (confirmed: zero Tran2 rows for every sampled SO
 *     VchCode), which is why an earlier version of this extractor returned
 *     empty `lines` for every Sales Order. Its line items instead live in
 *     **Tran3**, filtered to RecType=4 (confirmed against 2 real Sales
 *     Orders, 22 and 5 lines respectively — Qty*Rate reconciles exactly to
 *     NewRefAmount on every line). Column mapping for a Tran3/RecType=4 row:
 *     MasterCode1=item (join Master1 MasterType=6, same as a Tran2 item
 *     leg), ItemSrNo=line sequence, Value1(=Value2)=quantity, Value3=rate,
 *     NewRefAmount=line amount (Qty*Rate). No D-column-style MRP/discount
 *     breakdown exists on this table (no D2/D4/D9 columns at all) — an SO
 *     line's `discount` is always null here, unlike a real Tran2 item leg.
 *     MasterCode2 is a constant-per-voucher party-ledger reference (same
 *     party as the Tran1 header), not a UOM — deliberately unused.
 *
 *   - Folio1.D1/D3 = a Stock Item's opening qty/value (MasterType=6) — same
 *     table/join as a Ledger's own opening balance, no sign flip needed
 *     here (see extractMasters()'s own comment for the live cross-check).
 *
 * Still null/unresolved on every extracted line, on purpose (documented
 * gap, not silently wrong): `unit` (no confirmed column — Busy's own Unit
 * master, MasterType candidates unconfirmed, likely lives on the Stock
 * Item's own master record like Tally's $BaseUnits rather than per-line).
 *
 * `guid` is synthesized (vouchers: `BUSY-<database>-<VchCode>`; masters:
 * `BUSY-<database>-M-<Code>`, "M" keeps the master-Code namespace visibly
 * separate from the voucher-VchCode one even though they're different
 * tables) since Busy rows carry no GUID of their own — stable and unique
 * per source database, which is what cross-firm identity actually needs.
 */

const VCH_TYPE_MAP = {
  2: "Purchase",
  3: "Credit Note",
  5: "Stock Journal",
  8: "Stock Journal", // second company's own code for the same zero-amount, item-legs-only, no-ledger-legs pattern as code 5 — see Folio 07
  9: "Sales",
  10: "Debit Note", // stock-linked Purchase Return, VchNo "DN/..", posts party+Purchase legs — see Folio 07
  12: "Sales Order",
  13: "Sales Order", // a THIRD company's own code — confirmed live (Folio 08) against ALL 9 real vouchers across both its synced FY databases: zero Tran2 ledger legs on every one, party+item data only via Tran3/RecType=4, same non-accounting shape as code 12. A short separate VchNo series ("2", not "SO/26-27/..") so it may be a differently-named document in Busy's own UI (Estimate/Quotation?) — labeled "Sales Order" here only because it behaves IDENTICALLY for extraction/classification purposes (no ledger impact either way), not because the real-world name is confirmed. IMPORTANT: this is NOT the same code 13 Folio 07 already saw on a different (second) company — that one posted nothing at all (same empty-stub pattern as code 61 below); this one carries real party/item/amount data. Codes are confirmed per-company, never assumed — a 4th company's own code 13 could still mean something else again.
  14: "Payment",
  15: "Contra", // pure bank-to-bank fund transfer (two bank ledgers, no party/items) — deliberately unclassified by _classify_vch_type/_ext, matching real Contra semantics — see Folio 07
  16: "Journal",
  17: "Credit Note", // ledger-only adjustment posting to a nominal "CREDIT NOTE" ledger, no stock items — see Folio 07
  18: "Debit Note", // ledger-only adjustment posting to a nominal "DEBIT NOTE" ledger, no stock items (a different Busy voucher type than code 10, same real-world nature) — see Folio 07
  19: "Payment", // second company's own Cash/Petty-Cash payment series, VchNo "PC/..", separate from code 14's bank payments but same PAYMENT nature — see Folio 07
};

const MASTER_TYPE_MAP = {
  1: "GROUP", // Ledger Group — Busy's chart-of-accounts group, same label Tally's own Group master uses
  2: "LEDGER",
  5: "STOCK_GROUP",
  6: "STOCK_ITEM",
};

function vchTypeLabel(code) {
  return VCH_TYPE_MAP[code] || `UNKNOWN_${code}`;
}

function toIsoDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

async function connect(cfg) {
  let server = cfg.server;
  let instanceName;
  if (server && server.includes("\\")) [server, instanceName] = server.split("\\");

  const config = {
    server,
    database: cfg.database || undefined,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    // A wide legs-for-many-vouchers pull (now 3 batch queries: Tran2 legs,
    // Tran3 order legs, headers) can exceed mssql's 15s default on a
    // full-history extraction, badly enough on a big single-FY database
    // (confirmed: a 15,618-voucher FY database's own legs query alone
    // exceeded 180000ms) that 180s isn't a safe universal default either —
    // overridable per call via cfg.requestTimeout.
    requestTimeout: cfg.requestTimeout || 180000,
    options: {
      trustServerCertificate: true,
      encrypt: cfg.encrypt !== false,
      ...(instanceName ? { instanceName } : {}),
    },
  };
  if (!instanceName) config.port = cfg.port || 1433;
  return sql.connect(config);
}

// ---------------------------------------------------------------------------
// Masters — Ledger Groups, Ledgers, Stock Groups, Stock Items
// ---------------------------------------------------------------------------

/**
 * lowercased STOCK_GROUP name -> (raw Name, raw parent Stock Group name).
 * Mirrors tally_sync.py::_stock_group_parent_chain_map exactly, just built
 * off Busy's own MasterType=5 rows instead of Tally's STOCK_GROUP XML.
 */
function stockGroupParentChainMap(masters) {
  const out = {};
  for (const m of masters) {
    if (m.master_type !== "STOCK_GROUP") continue;
    const name = String(m.name || "").trim();
    if (!name) continue;
    const parent = String((m.fields || {}).Parent || "").trim();
    out[name.toLowerCase()] = { name, parent };
  }
  return out;
}

/**
 * Walks groupMap from startGroup up to its topmost ancestor Stock Group
 * name — mirrors tally_sync.py::_top_level_stock_group. Busy's terminal
 * sentinel is simply an empty/zero Parent (ParentGrp=0 -> "" once resolved
 * to a name by the SQL join below) — no "Primary"-style literal string to
 * special-case the way Tally's own walk must.
 */
function topLevelStockGroup(startGroup, groupMap, maxDepth = 30) {
  let cur = String(startGroup || "").trim();
  if (!cur) return cur;
  const visited = new Set();
  for (let i = 0; i < maxDepth; i++) {
    const key = cur.toLowerCase();
    if (visited.has(key)) return cur;
    visited.add(key);
    const entry = groupMap[key];
    if (!entry) return cur;
    if (!entry.parent) return entry.name;
    cur = entry.parent;
  }
  return cur;
}

function stockItemGroupLookup(masters) {
  const out = {};
  for (const m of masters) {
    if (m.master_type === "STOCK_ITEM" && m.brand_category) out[m.name] = m.brand_category;
  }
  return out;
}

function stockItemAliasLookup(masters) {
  const out = {};
  for (const m of masters) {
    if (m.master_type === "STOCK_ITEM" && m.fields && m.fields.Alias) out[m.name] = m.fields.Alias;
  }
  return out;
}

/**
 * Pulls every Ledger Group / Ledger / Stock Group / Stock Item row from
 * Master1, normalized to MasterIn shape. A Stock Item's `brand_category` is
 * already walked to the TOPMOST Stock Group before this returns (same
 * "denormalize once at write time" reasoning tally_sync.py documents) —
 * callers extracting vouchers afterward should use stockItemGroupLookup()/
 * stockItemAliasLookup() on this same return value, not re-derive it.
 */
function quoteDbName(name) {
  // Bracket-escape for a 3-part SQL identifier ([Database].dbo.Table) --
  // database names here always come from our own listFiscalYearDatabases()
  // discovery (sys.databases), never user input, but escape defensively
  // anyway rather than trust that invariant forever.
  return `[${String(name).replace(/]/g, "]]")}]`;
}

async function extractMasters(cfg, { limit, openingBalanceDatabase } = {}) {
  const pool = await connect(cfg);
  try {
    const req = pool.request();
    if (limit) req.input("limit", sql.Int, limit);
    // Folio1 (MasterCode -> Master1.Code, one row per master) carries the
    // real opening balance in D1 -- confirmed against Busy's own "List of
    // Accounts" export across many real ledgers (not guessed): D1<0 = Debit
    // opening, D1>0 = Credit opening, D1=0 = genuinely zero. This is a
    // SEPARATE table from Master1 itself (Master1's own D1-D26 are always 0
    // for a ledger -- confirmed exhaustively, see FINDINGS.md) and was
    // missed entirely by every earlier investigation pass, including a
    // whole-database blind value search, until directly queried by name.
    // LEFT JOIN, never INNER -- a master with no Folio1 row (or a genuinely
    // zero D1) must still come through with OpeningBalance="0", not be
    // silently dropped. For MasterType=6 (Stock Item), D1 = opening qty and
    // D3 = opening value (both in the SAME sign Busy's own Item Master
    // screen shows, no Dr/Cr flip needed) -- confirmed live against a real
    // item's "Op. Stock (Qty.)"/"Op. Stock (Value)" fields plus a
    // company-wide cross-check (SUM(D3) across every Stock Item in the
    // oldest FY database matches the "Stock-in-hand" ledger's own D1 to the
    // cent), see the STOCK_ITEM branch below. D2..D150 and every other
    // MasterType's own Folio1 meaning beyond D1/D3 (and D2, confirmed but
    // unused -- identical to D1 on every sampled Stock Item) remains
    // unconfirmed, not applied here.
    //
    // Opening balance is a GENESIS value, entered once (by hand, in this
    // dealer's case) in whichever FY database was current when the ledger
    // was first created -- confirmed it is NOT carried forward into later
    // years' own Folio1 rows (this dealer hasn't rolled it forward; a
    // ledger created in FY2025-26 shows D1=0 in FY2026-27's own database).
    // Since this app's multi-year sync already merges every synced FY's
    // vouchers into one continuous history (see import-to-app.js), the
    // OpeningBalance that belongs on the merged result is the ledger's
    // TRUE genesis value -- i.e. read from the OLDEST synced FY database,
    // not whichever one `cfg` itself points at (normally the current FY,
    // which would otherwise always show 0 for an existing ledger). Passing
    // `openingBalanceDatabase` (a sibling database name on the SAME SQL
    // Server instance) cross-database-joins Folio1 from there instead,
    // leaving every other master field sourced from `cfg`'s own database
    // as before. Omit it to read Folio1 from cfg's own database (e.g. when
    // cfg already points at the oldest database itself).
    //
    // Join must ALSO match MasterType, not Code alone -- real bug, caught
    // live (Folio 10): `Code` is NOT type-scoped -- it's reused across
    // MasterTypes (a Ledger and a Stock Group can share the same Code
    // number) AND independently across sibling FY databases for anything
    // created after that database's own rollover point (this dealer's
    // db12026 and db12025 each kept allocating new Codes on their own from
    // there, so a Code created fresh in db12026 after 2026-04-01 can
    // numerically collide with an UNRELATED, pre-existing master in
    // db12025). Confirmed live: a Ledger "Example Dealer C"
    // (Code 14324, created 2026-04-04, genuinely has zero real activity
    // before that date) was silently attributed a -4,870/-830,696.02
    // "opening balance" pulled from db12025's OWN Code 14324 -- a
    // completely unrelated STOCK_GROUP named "Others" that happened to
    // reuse that number in the older database. `f.MasterType = m.MasterType`
    // is the minimal fix restoring Folio1's true composite key
    // (MasterCode, MasterType) rather than treating MasterCode alone as
    // unique. A same-TYPE Code collision across sibling databases (e.g.
    // two unrelated Ledgers sharing a Code) remains a theoretical residual
    // risk this doesn't fully rule out, not yet observed in practice.
    const folio1Ref = openingBalanceDatabase ? `${quoteDbName(openingBalanceDatabase)}.dbo.Folio1` : "Folio1";
    const rowsSql = `
      SELECT ${limit ? "TOP (@limit)" : ""}
        m.Code, m.MasterType, m.Name, m.Alias, m.PrintName, m.ParentGrp,
        pg.Name AS ParentGrpName, f.D1 AS OpeningBalanceRaw, f.D3 AS OpeningStockValueRaw
      FROM Master1 m
      LEFT JOIN Master1 pg ON pg.Code = m.ParentGrp
      LEFT JOIN ${folio1Ref} f ON f.MasterCode = m.Code AND f.MasterType = m.MasterType
      WHERE m.MasterType IN (1, 2, 5, 6)
      ORDER BY m.MasterType, m.Code
    `;
    const rows = (await req.query(rowsSql)).recordset;

    const masters = rows.map((r) => {
      const masterType = MASTER_TYPE_MAP[r.MasterType];
      const name = (r.Name || "").trim();
      const fields = {
        Code: r.Code,
        Name: name,
        Alias: r.Alias || null,
        PrintName: r.PrintName || null,
        Parent: r.ParentGrpName || "", // raw IMMEDIATE parent — the walk below resolves STOCK_ITEM's brand_category to the TOP; STOCK_GROUP rows keep this raw so stockGroupParentChainMap can walk it
      };
      if (masterType === "LEDGER") {
        // Busy's own sign convention (negative=Debit, positive=Credit) is
        // the OPPOSITE of this app's dr_positive convention, so flip here
        // at the source rather than teaching the backend a second sign
        // rule — OpeningBalance/OpeningBalanceIsDebit downstream (
        // _ledger_opening_balance_dr_positive) already expects the SAME
        // shape Tally's own $OpeningBalance+$$IsDebit:$OpeningBalance pair
        // uses: a plain unsigned magnitude plus an explicit Yes/No flag.
        const raw = r.OpeningBalanceRaw;
        const val = raw == null ? 0 : Number(raw);
        fields.OpeningBalance = String(Math.abs(val));
        fields.OpeningBalanceIsDebit = val < 0 ? "Yes" : "No";
      } else if (masterType === "STOCK_ITEM") {
        // Folio1.D1 = opening qty, Folio1.D3 = opening value -- confirmed
        // live against a real Busy Item Master screen (item "44820KTE911":
        // "Op. Stock (Qty.)" -577, "Op. Stock (Value)" -19,305.92, exact
        // match to Folio1.D1/D2(=D1)/D3 in the OLDEST synced FY database,
        // db12025 -- the current FY's own db12026 shows different/zeroed
        // figures, same "genesis value, not carried forward" behavior
        // already confirmed for a Ledger's own D1, see the comment above).
        // Cross-checked company-wide too, not just one item: SUM(D3) across
        // all 10,823 stock items in db12025 = 20,060,548.89, matching the
        // "Stock" (Stock-in-hand) ledger's own Folio1.D1 (-20,060,548.89)
        // to the cent. Unlike the Ledger case, NO sign flip is needed here
        // -- D1/D3 already carry the exact same sign Busy's own screen
        // shows. Formatted as qty/rate TEXT (not a plain number) to match
        // the exact shape tally_sync.py's own STOCK_ITEM OpeningBalance/
        // OpeningRate fields carry -- _parse_tally_stock_qty/
        // _parse_tally_stock_rate (tally_router.py) only ever read the
        // leading numeric token and ignore everything after it, so no real
        // unit suffix is required (this extractor doesn't resolve Busy's
        // own Unit master yet, see the module docstring's `unit` caveat).
        const qtyRaw = r.OpeningBalanceRaw; // Folio1.D1
        const valRaw = r.OpeningStockValueRaw; // Folio1.D3
        const qty = qtyRaw == null ? 0 : Number(qtyRaw);
        const val = valRaw == null ? null : Number(valRaw);
        fields.OpeningBalance = String(qty);
        if (val !== null && qty !== 0) fields.OpeningRate = String(val / qty);
      }
      return {
        guid: `BUSY-${cfg.database}-M-${r.Code}`,
        master_type: masterType,
        name,
        dealer_code: null, // no Busy equivalent identified yet — Tally sync leaves this null too, see tally_sync.py
        brand_category: masterType === "STOCK_ITEM" ? (r.ParentGrpName || null) : null,
        fields,
      };
    });

    const groupMap = stockGroupParentChainMap(masters);
    for (const m of masters) {
      if (m.master_type === "STOCK_ITEM" && m.brand_category) {
        m.brand_category = topLevelStockGroup(m.brand_category, groupMap);
      }
    }
    return masters;
  } finally {
    await pool.close();
  }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/**
 * Pulls voucher headers + all their legs in exactly 2 round trips (not one
 * query per voucher) — headers first, then every leg for that whole batch of
 * VchCodes at once, grouped in JS. Read-only: SELECT only, same as every
 * other script in this POC.
 *
 * `stockItemGroupLookup`/`stockItemAliasLookup` (from extractMasters()'s
 * return value, see functions above) are optional — pass them so item
 * lines' stockGroup/itemAlias come from the masters-derived, walked-to-top
 * lookup (the confirmed-correct convention, matching tally_sync.py exactly)
 * instead of this query's own immediate-ParentGrp join, which is kept only
 * as a fallback for a quick voucher-only extraction with no masters pulled.
 */
async function extractVouchers(cfg, { vchType, dateFrom, dateTo, limit = 100, stockItemGroupLookup: groupLookup, stockItemAliasLookup: aliasLookup } = {}) {
  const pool = await connect(cfg);
  try {
    const req = pool.request();
    const where = [];
    if (vchType !== undefined) {
      req.input("vchType", sql.SmallInt, vchType);
      where.push("t1.VchType = @vchType");
    }
    if (dateFrom) {
      req.input("dateFrom", sql.Date, dateFrom);
      where.push("t1.Date >= @dateFrom");
    }
    if (dateTo) {
      req.input("dateTo", sql.Date, dateTo);
      where.push("t1.Date <= @dateTo");
    }
    req.input("limit", sql.Int, limit);

    const headerSql = `
      SELECT TOP (@limit)
        t1.VchCode, t1.VchType, t1.VchNo, t1.Date, t1.VchSalePurcAmt, t1.VchAmtBaseCur,
        t1.MasterCode1, m1.Name AS PartyName
      FROM Tran1 t1
      LEFT JOIN Master1 m1 ON m1.Code = t1.MasterCode1 AND m1.MasterType = 2
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t1.VchCode DESC
    `;
    const headers = (await req.query(headerSql)).recordset;
    if (!headers.length) return [];

    const vchCodes = headers.map((h) => h.VchCode);
    const legsReq = pool.request();
    const legsSql = `
      SELECT
        t2.VchCode, t2.RecType, t2.MasterCode1, t2.Value1, t2.Value2, t2.Value3,
        t2.D2, t2.D4, t2.D9,
        m.Name AS MasterName, m.MasterType, m.Alias, m.ParentGrp,
        pg.Name AS ParentGrpName
      FROM Tran2 t2
      LEFT JOIN Master1 m ON m.Code = t2.MasterCode1
      -- m.ParentGrp's own MasterType depends on what m itself is: MasterType=1
      -- (Ledger Group) for a Ledger's parent, MasterType=5 (Stock Group,
      -- confirmed in FINDINGS.md) for a Stock Item's parent. Joining on Code
      -- alone (not restricting pg.MasterType) covers both without guessing
      -- which one applies per row.
      LEFT JOIN Master1 pg ON pg.Code = m.ParentGrp
      WHERE t2.VchCode IN (${vchCodes.join(",")})
      ORDER BY t2.VchCode, t2.RecType, t2.SrNo
    `;
    // vchCodes are ints straight from our own prior query result, never
    // external input, so inlining them (no IN-clause array param support in
    // mssql) doesn't reopen the injection question raw string concat usually
    // would.
    const legs = (await legsReq.query(legsSql)).recordset;

    const legsByVch = new Map();
    for (const leg of legs) {
      if (!legsByVch.has(leg.VchCode)) legsByVch.set(leg.VchCode, []);
      legsByVch.get(leg.VchCode).push(leg);
    }

    // Sales Order (VchType 12) posts no Tran2 rows at all — its line items
    // live in Tran3/RecType=4 instead (see module docstring). Pulled as a
    // second batch query, same 2-round-trips-total shape as the Tran2 pull
    // above, and only actually returns rows for the VchCode subset that are
    // Sales Orders (a no-op extra round trip otherwise, cheap enough not to
    // bother conditioning on whether any VchType=12 headers are present).
    const orderLegsReq = pool.request();
    const orderLegsSql = `
      SELECT
        t3.VchCode, t3.MasterCode1, t3.Value1, t3.Value3, t3.NewRefAmount, t3.ItemSrNo,
        m.Name AS MasterName, m.MasterType, m.Alias, m.ParentGrp,
        pg.Name AS ParentGrpName
      FROM Tran3 t3
      LEFT JOIN Master1 m ON m.Code = t3.MasterCode1
      LEFT JOIN Master1 pg ON pg.Code = m.ParentGrp
      WHERE t3.RecType = 4 AND t3.VchCode IN (${vchCodes.join(",")})
      ORDER BY t3.VchCode, t3.ItemSrNo
    `;
    const orderLegs = (await orderLegsReq.query(orderLegsSql)).recordset;

    const orderLegsByVch = new Map();
    for (const leg of orderLegs) {
      if (!orderLegsByVch.has(leg.VchCode)) orderLegsByVch.set(leg.VchCode, []);
      orderLegsByVch.get(leg.VchCode).push(leg);
    }

    // A Sales Order line's rate/amount (Tran3) is ex-tax and has no GST rate
    // of its own (Sales Order posts no GST at all — see module docstring).
    // Best-effort recover each item's GST% from its own most recent REAL
    // posting (VchGSTSumItemWise, a Tax Invoice/Purchase's actual filed GST
    // split) — confirmed TaxRate+TaxRate1 always sums to a stable rate
    // (e.g. 18 = 9+9 intra-state or 18+0 inter-state) per item/HSN in this
    // dealer's data. This is "best available" history, not a stored fact on
    // the Sales Order itself — a brand-new item never yet invoiced yields
    // no rate (taxRatePct stays null, no gross-up attempted).
    let gstRateByItemCode = new Map();
    const orderItemCodes = [...new Set(orderLegs.map((l) => l.MasterCode1).filter((c) => c != null))];
    if (orderItemCodes.length) {
      const gstReq = pool.request();
      const gstSql = `
        WITH ranked AS (
          SELECT ItemCode, TaxRate, TaxRate1,
                 ROW_NUMBER() OVER (PARTITION BY ItemCode ORDER BY VchDate DESC) AS rn
          FROM VchGSTSumItemWise
          WHERE ItemCode IN (${orderItemCodes.join(",")})
        )
        SELECT ItemCode, TaxRate, TaxRate1 FROM ranked WHERE rn = 1
      `;
      const gstRows = (await gstReq.query(gstSql)).recordset;
      gstRateByItemCode = new Map(gstRows.map((r) => [r.ItemCode, (r.TaxRate || 0) + (r.TaxRate1 || 0)]));
    }

    // The real discount % IS recoverable, exactly (confirmed to the paisa
    // against Busy's own displayed "Disc." column) — Master1.D3 is the
    // item's current tax-inclusive list price; comparing it against Tran3's
    // already-discounted ex-tax rate (converted through the GST% above)
    // backs out the discount that was actually applied. No Scheme/Price-
    // List master exists with any configured rows in this install (checked
    // exhaustively — every `%Price%`/%Scheme%`/`%Disc%` table is either
    // absent or 0 rows, and the party carries no assigned price level), so
    // this back-derivation against D3 is the only available source, not a
    // fallback we chose over a better one. KNOWN CAVEAT: `D3` is the item's
    // CURRENT master list price, not a per-voucher snapshot — if the item's
    // list price is edited in Busy after this Sales Order's date, a re-sync
    // will silently recompute a different discount % for this same old
    // voucher. Acceptable for Sales Orders specifically since they're
    // inherently near-term/still-pending documents, not settled history.
    let listPriceByItemCode = new Map();
    if (orderItemCodes.length) {
      const priceReq = pool.request();
      const priceSql = `SELECT Code, D3 FROM Master1 WHERE MasterType = 6 AND Code IN (${orderItemCodes.join(",")})`;
      const priceRows = (await priceReq.query(priceSql)).recordset;
      listPriceByItemCode = new Map(priceRows.map((r) => [r.Code, r.D3]));
    }

    return headers.map((h) =>
      normalizeVoucher(h, legsByVch.get(h.VchCode) || [], cfg, {
        groupLookup,
        aliasLookup,
        orderLegs: orderLegsByVch.get(h.VchCode) || [],
        gstRateByItemCode,
        listPriceByItemCode,
      })
    );
  } finally {
    await pool.close();
  }
}

function normalizeVoucher(header, legs, cfg, { groupLookup, aliasLookup, orderLegs = [], gstRateByItemCode = new Map(), listPriceByItemCode = new Map() } = {}) {
  const ledgerLegs = legs.filter((l) => l.RecType === 1);
  const itemLegs = legs.filter((l) => l.RecType === 2);

  const ledger = ledgerLegs.map((l) => ({
    ledgerName: l.MasterName || `UNRESOLVED_MASTER_${l.MasterCode1}`,
    amount: Math.abs(l.Value1),
    drCr: l.Value1 < 0 ? "Dr" : "Cr",
  }));

  // True invoice total = ledger-leg reconciliation, never the header's own
  // VchSalePurcAmt (confirmed to be the ex-tax goods subtotal only). A
  // voucher with no ledger legs at all (e.g. a Sales Order, which posts
  // none) falls back to Tran1.VchAmtBaseCur — confirmed exact against a
  // real voucher's own displayed Total Amount (Busy stores this as the
  // voucher's own tax-inclusive total even for a non-accounting type that
  // never posts GST) — VchSalePurcAmt (ex-tax goods subtotal) is only the
  // last-resort fallback if even that's somehow null.
  let posSum = 0;
  let negSum = 0;
  for (const l of ledgerLegs) {
    if (l.Value1 > 0) posSum += l.Value1;
    else negSum += -l.Value1;
  }
  const amount = ledgerLegs.length
    ? Math.max(posSum, negSum)
    : (header.VchAmtBaseCur != null ? header.VchAmtBaseCur : header.VchSalePurcAmt);

  const items = itemLegs.map((l) => {
    const quantity = Math.abs(l.Value1);
    const lineAmount = Math.abs(l.Value3); // ex-tax, straight off Tran2 — never derived from D2/D4 (incl-tax)
    const itemName = l.MasterName || `UNRESOLVED_MASTER_${l.MasterCode1}`;
    return {
      stockItemName: itemName,
      amount: lineAmount,
      quantity,
      unit: null, // unconfirmed — see module docstring
      rate: quantity ? lineAmount / quantity : null, // derived, never a trusted raw column
      discount: l.D9 != null ? l.D9 : null, // confirmed: D4 * (1 - D9/100) === D2 exactly across every sampled line
      stockGroup: (groupLookup && groupLookup[itemName]) || l.ParentGrpName || null, // prefer the masters-derived, walked-to-top lookup; fall back to this query's own immediate parent only when no masters were pulled
      itemAlias: (aliasLookup && aliasLookup[itemName]) || l.Alias || null,
    };
  });

  // Sales Order lines (Tran3/RecType=4, see module docstring) — a non-empty
  // itemLegs would mean this voucher genuinely has real Tran2 item legs too
  // (not observed for VchType 12 in practice, but items.length checked
  // rather than assumed so a real Tran2 item leg is never silently dropped).
  if (!items.length && orderLegs.length) {
    for (const l of orderLegs) {
      const quantity = Math.abs(l.Value1);
      const lineAmount = Math.abs(l.NewRefAmount);
      const rate = quantity ? lineAmount / quantity : Math.abs(l.Value3) || null; // derived; falls back to Tran3's own Value3 rate only if qty is somehow 0
      const itemName = l.MasterName || `UNRESOLVED_MASTER_${l.MasterCode1}`;
      // Best-effort GST% recovered from this item's own most recent REAL
      // filed posting (see gstRateByItemCode above) — grosses up the
      // otherwise-ex-tax rate/amount so they can be checked directly
      // against Busy's own tax-inclusive voucher-entry screen. `null` (not
      // 0) when no history exists for this item yet, so a caller can tell
      // "known 0% GST" (never actually happens here) apart from "unknown".
      const taxRatePct = gstRateByItemCode.has(l.MasterCode1) ? gstRateByItemCode.get(l.MasterCode1) : null;
      const grossUp = taxRatePct != null ? 1 + taxRatePct / 100 : null;
      // Real discount %, back-derived against the item's CURRENT master
      // list price (Master1.D3, tax-inclusive) — see the caveat comment
      // above listPriceByItemCode's own query. Needs both D3 and the GST%
      // (to convert D3 down to the same ex-tax basis `rate` is already on)
      // — null (never a guessed 0) when either is unavailable.
      const listPriceInclTax = listPriceByItemCode.has(l.MasterCode1) ? listPriceByItemCode.get(l.MasterCode1) : null;
      let discount = null;
      if (listPriceInclTax != null && grossUp != null && rate != null && listPriceInclTax > 0) {
        const exTaxListPrice = listPriceInclTax / grossUp;
        if (exTaxListPrice > 0) discount = Math.round((1 - rate / exTaxListPrice) * 10000) / 100;
      }
      items.push({
        stockItemName: itemName,
        amount: lineAmount,
        quantity,
        unit: null, // unconfirmed — see module docstring
        rate,
        discount,
        stockGroup: (groupLookup && groupLookup[itemName]) || l.ParentGrpName || null,
        itemAlias: (aliasLookup && aliasLookup[itemName]) || l.Alias || null,
        taxRatePct,
        amountInclTaxEst: grossUp != null ? lineAmount * grossUp : null,
        rateInclTaxEst: grossUp != null && rate != null ? rate * grossUp : null,
      });
    }
  }

  return {
    guid: `BUSY-${cfg.database}-${header.VchCode}`,
    vch_type: vchTypeLabel(header.VchType),
    vch_no: (header.VchNo || "").trim() || null,
    date: toIsoDate(header.Date),
    party_name: header.PartyName || null,
    amount,
    lines: { items, ledger },
    is_optional: false, // Busy has no confirmed equivalent flag yet
    source: "BUSY", // informational only on this side — /tally/import derives the real DB `source` from the target Firm's own source_system, never a client-supplied field
  };
}

module.exports = {
  connect,
  extractVouchers,
  extractMasters,
  normalizeVoucher,
  vchTypeLabel,
  VCH_TYPE_MAP,
  MASTER_TYPE_MAP,
  stockGroupParentChainMap,
  topLevelStockGroup,
  stockItemGroupLookup,
  stockItemAliasLookup,
};
