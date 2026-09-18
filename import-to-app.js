/**
 * Folio 02 (Sync Ledger) — the Busy import job.
 *
 * Extracts masters + vouchers from the live Busy SQL Server (see
 * lib/busy-voucher-extractor.js) and POSTs them to the warehouse-system
 * backend's `POST /tally/import` — the SAME endpoint Tally's own sync
 * already uses, authenticated the same way (shared-secret `X-Tally-Key`
 * header, `TALLY_IMPORT_KEY`). No new backend endpoint was needed for this
 * — `_apply_tally_import()` already derives `source` from whichever
 * `firm_id` the payload is scoped to (see tally_router.py), so a BUSY-
 * sourced firm just works once its row exists.
 *
 * IMPORTANT — this always sends the COMPLETE current snapshot, never an
 * incremental delta: the backend's `_apply_tally_import()` truncates and
 * reloads a firm's ENTIRE tally_masters/tally_vouchers rows on every call
 * (see CLAUDE.md's Tally Mode section). Passing --date-from/--date-to
 * narrows what gets pulled FROM BUSY, but whatever you send still wholesale
 * REPLACES that firm's stored data — a narrow date range on a recurring job
 * would silently delete everything outside that window on every run. Only
 * use a date range for a one-off investigative dry run, never for the
 * actual recurring sync (see scheduled-sync.js, which always pulls full
 * history for exactly this reason).
 *
 * This file exports `runImport()` so scheduled-sync.js can call it directly
 * without spawning a subprocess; run standalone via the CLI below for a
 * manual/one-off run.
 *
 * Usage:
 *   node import-to-app.js --dry-run [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]
 *     Extract + write output/busy-import-payload.json, POST nothing.
 *   node import-to-app.js [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]
 *     Extract + actually POST to config.backend.baseUrl.
 *   Flags: --allow-empty (post even if extraction returned 0 rows — see
 *   the empty-payload guard below), --allow-unknown-types (post even if
 *   some vouchers have an unmapped vch_type instead of blocking).
 *
 * With no --date-from/--date-to/--limit, pulls the full history (every
 * Sales/Purchase/etc. voucher this dealer's Busy database has ever
 * recorded) — start with a small --limit or a narrow date range for the
 * first real DRY RUN (Folio 02 step 8), not the full load, and never pass
 * a narrow range to a real (non-dry-run) import — see the note above.
 */
const fs = require("fs");
const path = require("path");

const config = require("./config.json");
const localConfigPath = path.join(__dirname, "config.local.json");
if (fs.existsSync(localConfigPath)) {
  const local = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  for (const section of Object.keys(local)) {
    config[section] = { ...config[section], ...local[section] };
  }
}

const { connect, extractMasters, extractVouchers, stockItemGroupLookup, stockItemAliasLookup } = require("./lib/busy-voucher-extractor");
const { listFiscalYearDatabases } = require("./lib/busy-fy-database");

const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
const SYNC_LOG_PATH = path.join(OUTPUT_DIR, "sync-log.jsonl");

function parseArg(args, flag, fallback) {
  const idx = args.indexOf(flag);
  return idx === -1 ? fallback : args[idx + 1];
}

function appendSyncLog(entry) {
  try {
    fs.appendFileSync(SYNC_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.error("Could not append to sync log:", e.message);
  }
}

async function postWithRetry(url, options, { attempts = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      // Only a network-level failure (fetch itself throwing) is worth
      // retrying — a real HTTP error response (4xx/5xx) comes back as a
      // resolved Response, not a thrown error, and retrying THAT would
      // just repeat e.g. a 400 for a genuinely malformed payload.
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        console.log(`  POST failed (${err.message}), retrying in ${delay}ms (attempt ${i + 2}/${attempts})...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Runs one extract-and-post cycle. Returns a result object; never throws
 * for an expected/handled failure (blocked by a safety guard, HTTP error,
 * network exhaustion) — those come back as {ok:false, reason, ...}, so a
 * caller (the CLI below, or scheduled-sync.js) can decide its own exit
 * code/logging without a try/catch around every failure mode.
 */
async function runImport({
  dryRun = false, dateFrom, dateTo, limit = 100000,
  allowEmpty = false, allowUnknownTypes = false,
} = {}) {
  if (!dryRun && !config.backend.tallyImportKey) {
    return { ok: false, reason: "MISSING_IMPORT_KEY", message: "config.backend.tallyImportKey is blank — set it in config.local.json (must match the backend's TALLY_IMPORT_KEY env var), or pass dryRun to extract without posting." };
  }

  // Busy keeps one whole SQL Server database PER FISCAL YEAR (Folio 02's
  // "3-fiscal-year-copy discovery" — really 2 real per-FY data databases
  // plus Busy's own shared application DB, see listFiscalYearDatabases'
  // own docstring). A party's true running balance (and any FY-over-FY
  // report) needs voucher history pulled from EVERY sibling FY database,
  // not just whichever one is "current" for today — see CLAUDE.md's Tally
  // Mode section / the Sync Ledger design notes on this. Masters (Ledger/
  // Group/Stock Item) still come from the CURRENT database only — a
  // ledger's Parent/category classification should reflect its current
  // state, and merging same-name master duplicates across years would make
  // the app's own name-keyed grouping ambiguous about which one "wins".
  let fyDbs;
  try {
    fyDbs = await listFiscalYearDatabases(config.sqlserver, { connect });
  } catch (e) {
    return { ok: false, reason: "DATABASE_RESOLUTION_FAILED", message: e.message };
  }
  const current = fyDbs.databases.find((d) => d.isCurrent);
  console.log(`== Database: ${current.database} (current${fyDbs.multiYear ? `, ${fyDbs.databases.length} FY database(s) total: ${fyDbs.databases.map((d) => d.database).join(", ")}` : ", MANUAL/single-database mode — set autoDetectFiscalYearDatabase+databasePattern to pull prior fiscal years too"}) ==`);
  // 180s (the extractor's own default) was seen to time out pulling a
  // single 15,618-voucher FY database's legs when run right after another
  // DB's own extraction in the same process (the same pull completed in
  // ~28s run in isolation — likely connection/resource contention from
  // back-to-back SQL Server connections on this dev box, not the query
  // itself being that slow) — a multi-FY-database run now does several of
  // these back to back, so it needs real headroom, not the single-DB
  // default.
  const VOUCHER_REQUEST_TIMEOUT_MS = 600000;
  const sqlCfg = { ...config.sqlserver, database: current.database };
  // Opening balance is a genesis value entered once, in whichever FY
  // database was current when a ledger was first created -- confirmed
  // NOT carried forward into later years' own Folio1 rows (see
  // extractMasters()'s own docstring). Since this sync already merges
  // every FY's vouchers into one continuous history, the OpeningBalance
  // attached to each ledger must come from the OLDEST synced database
  // (databases sorted newest-first by listFiscalYearDatabases, so the
  // last entry is oldest), not the current one -- reading it from the
  // current database would show 0 for every pre-existing ledger.
  const oldest = fyDbs.databases[fyDbs.databases.length - 1];
  const openingBalanceDatabase = oldest.database === current.database ? undefined : oldest.database;

  console.log(`== Extracting Busy masters (current FY only, opening balances from ${openingBalanceDatabase || current.database}) + vouchers (every FY database, ${dateFrom || "start"}..${dateTo || "now"}, limit ${limit} per database) ==`);
  const masters = await extractMasters(sqlCfg, { openingBalanceDatabase });
  console.log(`  masters: ${masters.length}`);
  const groupLookup = stockItemGroupLookup(masters);
  const aliasLookup = stockItemAliasLookup(masters);

  let vouchers = [];
  for (const fyDb of fyDbs.databases) {
    const dbVouchers = await extractVouchers({ ...config.sqlserver, database: fyDb.database, requestTimeout: VOUCHER_REQUEST_TIMEOUT_MS }, {
      dateFrom, dateTo, limit,
      stockItemGroupLookup: groupLookup,
      stockItemAliasLookup: aliasLookup,
    });
    console.log(`  vouchers (${fyDb.database}${fyDb.fyKey ? `, FY ${fyDb.fyKey}` : ""}): ${dbVouchers.length}`);
    vouchers = vouchers.concat(dbVouchers);
  }
  console.log(`  vouchers (all FY databases combined): ${vouchers.length}`);

  const unknown = vouchers.filter((v) => v.vch_type.startsWith("UNKNOWN_"));
  if (unknown.length) {
    console.log(`  WARNING: ${unknown.length} voucher(s) have an unmapped vch_type — see FINDINGS.md's VchType table. Investigate before importing these.`);
    if (!dryRun && !allowUnknownTypes) {
      const result = { ok: false, reason: "UNMAPPED_VCH_TYPES", count: unknown.length, sampleGuids: unknown.slice(0, 5).map((v) => v.guid) };
      appendSyncLog({ ...result, database: current.database });
      return result;
    }
  }

  // Mirrors the backend's own ImportRequest.allow_empty guard (defense in
  // depth — failing here means the bad payload never even leaves this
  // machine): a zero-row extraction from a live database almost always
  // means something went wrong upstream (dropped connection, pointed at
  // the wrong FY database, an over-narrow date filter), not that the
  // dealer genuinely has zero data. See _apply_tally_import's docstring.
  if (!dryRun && masters.length === 0 && vouchers.length === 0 && !allowEmpty) {
    const result = { ok: false, reason: "EMPTY_EXTRACTION", message: "Extraction returned 0 masters and 0 vouchers — refusing to post (this would truncate the firm's existing data via the backend's truncate+reload). Pass allowEmpty if this is genuinely expected." };
    appendSyncLog({ ...result, database: current.database });
    return result;
  }

  const payload = {
    firm_id: config.backend.firmId ?? undefined, // omit entirely (undefined, not null) while exactly one firm exists — see _resolve_or_default_firm_id
    masters,
    // /tally/import's VoucherIn doesn't (yet) accept `source` — it's
    // computed server-side from the target firm's own source_system, so
    // stripping it here just avoids sending a field the backend ignores.
    vouchers: vouchers.map(({ source, ...v }) => v),
    allow_empty: allowEmpty,
  };

  if (dryRun) {
    const file = path.join(OUTPUT_DIR, "busy-import-payload.json");
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    console.log(`Dry run only — wrote ${path.relative(__dirname, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB). Nothing posted.`);
    return { ok: true, dryRun: true, mastersCount: masters.length, vouchersCount: vouchers.length, unknownTypeCount: unknown.length };
  }

  console.log(`== Posting to ${config.backend.baseUrl}/tally/import ==`);
  let resp;
  try {
    resp = await postWithRetry(`${config.backend.baseUrl}/tally/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tally-Key": config.backend.tallyImportKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const result = { ok: false, reason: "NETWORK_ERROR", message: err.message };
    appendSyncLog({ ...result, database: current.database });
    return result;
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const result = { ok: false, reason: "HTTP_ERROR", status: resp.status, body };
    appendSyncLog({ ...result, database: current.database });
    return result;
  }
  console.log("Import result:", body);
  const result = { ok: true, dryRun: false, mastersCount: masters.length, vouchersCount: vouchers.length, unknownTypeCount: unknown.length, backendResponse: body };
  appendSyncLog({ ...result, database: current.database });
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runImport({
    dryRun: args.includes("--dry-run"),
    dateFrom: parseArg(args, "--date-from", undefined),
    dateTo: parseArg(args, "--date-to", undefined),
    limit: Number(parseArg(args, "--limit", 100000)),
    allowEmpty: args.includes("--allow-empty"),
    allowUnknownTypes: args.includes("--allow-unknown-types"),
  });
  if (!result.ok) {
    console.log(`FAILED (${result.reason}):`, result.message || result.body || "");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    appendSyncLog({ ok: false, reason: "UNHANDLED_EXCEPTION", message: err.message });
    process.exitCode = 1;
  });
}

module.exports = { runImport };
