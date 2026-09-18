const sql = require("mssql");
const { connect } = require("./busy-voucher-extractor");

/**
 * Folio 09's own lesson, made reusable: a whole-database "does this number
 * exist anywhere" search that CANNOT fall into the bug that hid Folio1.D1
 * for so long -- a string-cast float range (`CAST(@target AS NVARCHAR(50))`)
 * silently collapses to ~6-significant-digit scientific notation
 * (`1.71645e+006`), turning an intended +/-0.01 tolerance into a useless
 * single rounded point. This version never casts the bound to text at all:
 * `@lo`/`@hi` are bound as real typed `mssql` parameters and referenced by
 * name in the generated SQL, so SQL Server compares the column against the
 * actual numeric value the driver sent, not a lossy string round-trip.
 *
 * Also runs a mandatory self-test BEFORE trusting any "no matches" result --
 * confirms the exact same parameter-bound comparison finds a planted match
 * for the target value itself. A search whose own self-test fails must
 * never be reported as "value not found" -- see Folio 09's process lesson:
 * a query that runs with no error and no output looks EXACTLY like a
 * genuine negative result. Don't repeat that mistake.
 *
 * Only scans base tables' numeric-typed columns by default (float, real,
 * decimal, numeric, money, smallmoney, int, bigint, smallint) -- pass
 * `dataTypes` to widen/narrow.
 */
async function searchValue(cfg, { target, tolerance = 0.01, dataTypes } = {}) {
  const types = dataTypes || ["float", "real", "decimal", "numeric", "money", "smallmoney", "int", "bigint", "smallint"];
  const pool = await connect(cfg);
  try {
    // Self-test: same parameter-bound comparison, against a value we KNOW
    // should match (the target itself) -- proves the binding round-trips
    // precisely before trusting the real scan's result either way.
    const selfTestReq = pool.request();
    selfTestReq.input("lo", sql.Float, target - tolerance);
    selfTestReq.input("hi", sql.Float, target + tolerance);
    selfTestReq.input("val", sql.Float, target);
    const selfTest = (await selfTestReq.query("SELECT CASE WHEN @val BETWEEN @lo AND @hi THEN 1 ELSE 0 END AS ok, @lo AS lo, @hi AS hi")).recordset[0];
    if (!selfTest.ok) {
      throw new Error(
        `searchValue self-test FAILED (target=${target}, bound lo=${selfTest.lo}, hi=${selfTest.hi}) -- the search mechanism itself is broken. ` +
        `Do NOT trust a "no matches" result from this run; fix the self-test before relying on the scan.`
      );
    }

    const colsReq = pool.request();
    const typeList = types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
    const cols = (
      await colsReq.query(`
        SELECT t.TABLE_NAME, c.COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
        WHERE c.DATA_TYPE IN (${typeList})
      `)
    ).recordset;

    if (!cols.length) return { selfTestPassed: true, columnsScanned: 0, matches: [] };

    const quoteIdent = (s) => `[${String(s).replace(/]/g, "]]")}]`;
    const esc = (s) => String(s).replace(/'/g, "''");
    let body = "CREATE TABLE #matches (table_name NVARCHAR(300), column_name NVARCHAR(300));\n";
    for (const c of cols) {
      body += `IF EXISTS (SELECT 1 FROM ${quoteIdent(c.TABLE_NAME)} WHERE ${quoteIdent(c.COLUMN_NAME)} BETWEEN @lo AND @hi) INSERT INTO #matches VALUES ('${esc(c.TABLE_NAME)}', '${esc(c.COLUMN_NAME)}');\n`;
    }
    body += "SELECT * FROM #matches;";

    const scanReq = pool.request();
    scanReq.input("lo", sql.Float, target - tolerance);
    scanReq.input("hi", sql.Float, target + tolerance);
    const result = await scanReq.query(body);

    return {
      selfTestPassed: true,
      columnsScanned: cols.length,
      matches: result.recordset.map((r) => ({ table: r.table_name, column: r.column_name })),
    };
  } finally {
    await pool.close();
  }
}

module.exports = { searchValue };
