/**
 * Connects to a Busy ODBC DSN and dumps its schema — table names, then columns
 * per table — rather than assuming any table/column names up front. Busy's ODBC
 * schema (if it exposes one at all; unconfirmed — see README) is undocumented
 * here, unlike Tally's TDL model which Tally publishes. Guessing table names
 * (e.g. "Ledgers"/"Vouchers") and shipping that as fact would be worse than
 * useless — this discovers the real shape from whatever DSN is handed to it.
 */
async function introspectOdbc(dsnConfig) {
  let odbc;
  try {
    odbc = require("odbc");
  } catch (err) {
    return {
      ok: false,
      reason:
        "The 'odbc' npm package isn't installed (it needs native build tools — " +
        "Python + a C++ toolchain — to compile against the system ODBC driver manager). " +
        "Run `npm install` on the machine that has both Busy and a build toolchain, not " +
        "necessarily this dev machine.",
    };
  }

  if (!dsnConfig.dsn) {
    return { ok: false, reason: "No DSN configured — run --list-dsns first and put the real DSN name in config.json." };
  }

  const connStr = [
    `DSN=${dsnConfig.dsn}`,
    dsnConfig.uid ? `UID=${dsnConfig.uid}` : null,
    dsnConfig.pwd ? `PWD=${dsnConfig.pwd}` : null,
  ]
    .filter(Boolean)
    .join(";");

  let connection;
  try {
    connection = await odbc.connect(connStr);
  } catch (err) {
    return { ok: false, reason: `Could not connect to DSN "${dsnConfig.dsn}": ${err.message}` };
  }

  try {
    // connection.tables()/columns() call the driver's own SQLTables/SQLColumns —
    // works against any ODBC driver, not Busy-specific API surface, so this part
    // is safe even without knowing anything about Busy's own schema.
    const tables = await connection.tables(null, null, null, "TABLE");
    const tableNames = tables.map((t) => t.TABLE_NAME).filter(Boolean);

    const schema = {};
    for (const name of tableNames) {
      try {
        const cols = await connection.columns(null, null, name, null);
        schema[name] = cols.map((c) => ({
          name: c.COLUMN_NAME,
          type: c.TYPE_NAME,
          nullable: c.IS_NULLABLE,
        }));
      } catch (err) {
        schema[name] = { error: err.message };
      }
    }

    return { ok: true, tableCount: tableNames.length, tables: tableNames, schema };
  } finally {
    await connection.close();
  }
}

/**
 * Once a real table is known (from introspectOdbc's output), pull a small sample
 * of rows so the actual data shape/values can be eyeballed against Busy's own
 * on-screen reports — never assume column semantics from the name alone.
 */
async function sampleRows(dsnConfig, tableName, limit = 5) {
  const odbc = require("odbc");
  const connStr = [
    `DSN=${dsnConfig.dsn}`,
    dsnConfig.uid ? `UID=${dsnConfig.uid}` : null,
    dsnConfig.pwd ? `PWD=${dsnConfig.pwd}` : null,
  ]
    .filter(Boolean)
    .join(";");

  const connection = await odbc.connect(connStr);
  try {
    // TOP N is SQL-Server/Access-style; if Busy's driver rejects it, this itself
    // is a useful discovery about which SQL dialect the driver actually speaks.
    const rows = await connection.query(`SELECT TOP ${limit} * FROM [${tableName}]`);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    await connection.close();
  }
}

module.exports = { introspectOdbc, sampleRows };
