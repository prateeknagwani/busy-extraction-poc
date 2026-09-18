/**
 * Folio 02 (Sync Ledger) step 6 — Busy's fiscal-year database rotation.
 *
 * This dealer's Busy install keeps one SQL Server database PER FISCAL YEAR
 * (confirmed live: `BusyCOMP0001_db`, `BusyCOMP0001_db12025`,
 * `BusyCOMP0001_db12026` sit side by side on the same SQL Server instance —
 * see CLAUDE.md's Tally Mode section / FINDINGS.md). Whoever runs the
 * scheduled sync has to decide, at each firing, which of those databases is
 * "current" — this file exists so that decision is at least NAMED and
 * centralized, rather than silently baked into a hardcoded `database`
 * string that goes stale the next time the fiscal year rolls over.
 *
 * Two modes, both driven by config.sqlserver (see config.json):
 *
 *   1. MANUAL (default, safest) — `database` is a plain fixed string, used
 *      as-is. Whoever edits config.local.json after a fiscal year rolls
 *      over is responsible for updating it. This is the current default
 *      because the exact rollover date/naming convention has only been
 *      observed from 2 real data points ("_db12025"/"_db12026") — not
 *      enough to be confident an automatic guess would never point at the
 *      wrong database on the day it matters.
 *
 *   2. AUTO (opt-in via `autoDetectFiscalYearDatabase: true` +
 *      `databasePattern`, e.g. "BusyCOMP0001_db1{fyStartYear}" -- CONFIRMED
 *      live: db12026 holds vouchers dated 2026-04-01 onward, i.e. the
 *      suffix encodes the FY's START year, not its end year; an earlier
 *      version of this comment/example had the token backwards) — computes
 *      the current Indian financial year (Apr Y -> Mar Y+1, same
 *      convention as the app's own backend/app/services/tally_fy.py) as of
 *      today, and substitutes {fyEndYear}/{fyStartYear} into the pattern
 *      (both tokens are supported -- use whichever one actually matches a
 *      given company's own real naming, confirmed against sys.databases,
 *      not assumed).
 *      Every resolution is logged loudly (which DB, which FY, which mode)
 *      so a wrong guess is visible in the run log before it silently pulls
 *      a year's worth of stale/empty data.
 *
 * Whichever mode resolves the name, `resolveDatabaseName()` never talks to
 * SQL Server itself to verify the database exists — that's caught the
 * normal way, by the extraction connection itself failing loudly.
 */

function fyBoundsForDate(d) {
  // Mirrors tally_fy.py::fy_key_for_date exactly (Apr Y -> Mar Y+1).
  const fyStartYear = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return { fyStartYear, fyEndYear: fyStartYear + 1 };
}

function fyKeyForEndYear(fyEndYear) {
  const fyStartYear = fyEndYear - 1;
  return `${fyStartYear}-${String(fyEndYear).slice(-2)}`;
}

/**
 * Builds a regex that matches `databasePattern` (e.g.
 * "BusyCOMP0001_db1{fyEndYear}") against a real database name and captures
 * the {fyEndYear} digits — the `{fyStartYear}` token, if a pattern ever uses
 * it instead, is treated the same way and converted to fyEndYear=+1 by the
 * caller. Every other pattern character is escaped literally, so a pattern
 * with no token at all just becomes an exact-match regex (used for the
 * un-suffixed base database, see below).
 */
function patternToRegex(pattern) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usesFyStart = pattern.includes("{fyStartYear}");
  const token = usesFyStart ? "{fyStartYear}" : "{fyEndYear}";
  const [before, after] = pattern.split(token);
  const re = new RegExp(`^${escapeRe(before)}(\\d{4})${escapeRe(after || "")}$`, "i");
  return { re, usesFyStart };
}

/**
 * Discovers every sibling fiscal-year database for this Busy company on the
 * same SQL Server instance — Folio 02's "3-fiscal-year-copy discovery"
 * (`BusyComp0001_db`/`_db12025`/`_db12026`) made concrete: Busy keeps one
 * whole database PER FISCAL YEAR, so a party's true running balance (and
 * any multi-year trend/FY-over-FY report) needs voucher history pulled from
 * ALL of them, not just whichever one `resolveDatabaseName()` picks as
 * "current" for today.
 *
 * Queries `sys.databases` (server-scoped catalog view — readable from
 * whichever database the connection happens to be pointed at, confirmed
 * working with the read-only `busy_sync_reader` login) rather than guessing
 * a year range, so a new FY's database is picked up automatically the next
 * time this runs, with nothing to update by hand.
 *
 * Requires AUTO mode (`autoDetectFiscalYearDatabase`+`databasePattern`) —
 * MANUAL mode has no pattern to discover siblings BY, so it falls back to
 * just the one configured database (same single-DB behavior as before this
 * function existed), with `multiYear: false` so a caller can tell the
 * difference and warn instead of silently under-syncing.
 *
 * Returns databases newest-first (current FY first), each
 * `{database, fyEndYear, fyKey, isCurrent}`.
 *
 * A name-pattern match alone isn't trusted — confirmed live that this same
 * SQL Server instance also carries an UN-SUFFIXED "BusyComp0001_db" that
 * looked, by name alone, like a plausible "pre-convention oldest FY"
 * database (an earlier version of this function guessed exactly that), but
 * turned out to be Busy's own shared APPLICATION/system database (Company,
 * UserLog, GSTFilingStatusDet, Patches, ... — no `Tran1`/voucher data at
 * all, confirmed via INFORMATION_SCHEMA.TABLES). Every matched candidate is
 * verified to actually have a `Tran1` table before being treated as a real
 * per-FY data database — a pattern match with no `Tran1` is silently
 * skipped (not included, not an error), since a company's SQL Server can
 * legitimately host other non-data databases alongside the real FY ones.
 */
async function listFiscalYearDatabases(sqlConfig, { connect, now = new Date() } = {}) {
  if (!sqlConfig.autoDetectFiscalYearDatabase || !sqlConfig.databasePattern) {
    const resolved = resolveDatabaseName(sqlConfig, { now });
    return { multiYear: false, databases: [{ database: resolved.database, fyEndYear: null, fyKey: null, isCurrent: true }] };
  }

  const resolved = resolveDatabaseName(sqlConfig, { now });
  const { re, usesFyStart } = patternToRegex(sqlConfig.databasePattern);

  const listPool = await connect({ ...sqlConfig, database: resolved.database });
  let names;
  try {
    const r = await listPool.request().query("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name"); // state=0 = ONLINE, skip offline/restoring copies
    names = r.recordset.map((row) => row.name);
  } finally {
    await listPool.close();
  }

  const candidates = [];
  for (const name of names) {
    const m = name.match(re);
    if (!m) continue;
    const yearDigits = Number(m[1]);
    const fyEndYear = usesFyStart ? yearDigits + 1 : yearDigits;
    candidates.push({ database: name, fyEndYear, fyKey: fyKeyForEndYear(fyEndYear), isCurrent: name.toLowerCase() === resolved.database.toLowerCase() });
  }

  // Verify each candidate is a real per-FY data database, not just a
  // name-pattern coincidence (see the Tran1-less "BusyComp0001_db" case
  // above) — one lightweight connection per candidate.
  const databases = [];
  for (const c of candidates) {
    const pool = await connect({ ...sqlConfig, database: c.database });
    try {
      const r = await pool.request().query("SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Tran1'");
      if (r.recordset.length) databases.push(c);
    } finally {
      await pool.close();
    }
  }
  databases.sort((a, b) => (b.fyEndYear || 0) - (a.fyEndYear || 0)); // newest FY first

  if (!databases.some((d) => d.isCurrent)) {
    // The pattern-resolved "current" database doesn't actually exist yet
    // (or has no Tran1 table yet — e.g. run right at a FY rollover before
    // Busy has created this year's DB) — surface it rather than silently
    // proceeding with zero "current" data.
    throw new Error(`resolveDatabaseName() picked "${resolved.database}" as current, but it wasn't found among the verified sibling databases: ${databases.map((d) => d.database).join(", ") || "(none matched the pattern and had a Tran1 table)"}`);
  }

  return { multiYear: true, databases };
}

function resolveDatabaseName(sqlConfig, { now = new Date() } = {}) {
  if (!sqlConfig.autoDetectFiscalYearDatabase) {
    if (!sqlConfig.database) {
      throw new Error("config.sqlserver.database is blank and autoDetectFiscalYearDatabase is not set — nothing to connect to.");
    }
    return { database: sqlConfig.database, mode: "MANUAL", reason: "config.sqlserver.database used as-is" };
  }

  if (!sqlConfig.databasePattern) {
    throw new Error("autoDetectFiscalYearDatabase is true but config.sqlserver.databasePattern is not set (expected something like \"BusyCOMP0001_db1{fyEndYear}\").");
  }
  const { fyStartYear, fyEndYear } = fyBoundsForDate(now);
  const database = sqlConfig.databasePattern
    .replace("{fyEndYear}", String(fyEndYear))
    .replace("{fyStartYear}", String(fyStartYear));
  return {
    database, mode: "AUTO",
    reason: `today (${now.toISOString().slice(0, 10)}) falls in FY ${fyStartYear}-${String(fyEndYear).slice(-2)}, pattern "${sqlConfig.databasePattern}"`,
  };
}

module.exports = { resolveDatabaseName, fyBoundsForDate, listFiscalYearDatabases, fyKeyForEndYear };
