const sql = require("mssql");

/**
 * Direct SQL Server introspection — the preferred path over generic ODBC when
 * Busy's data actually lives in a SQL Server instance (confirmed for this
 * deployment), since `mssql` wraps the pure-JS `tedious` TDS driver: no native
 * build toolchain needed to install it, unlike the `odbc` npm package, and no
 * DSN to register on the machine first either — just host/port/credentials.
 *
 * Busy's own table/column names inside that database are still UNCONFIRMED —
 * this discovers them from INFORMATION_SCHEMA rather than guessing, same
 * reasoning as odbc-introspect.js's SQLTables/SQLColumns approach.
 *
 * Auth: a scoped read-only SQL login (`busy_sync_reader`, db_datareader only,
 * explicit DENY on every write/DDL verb — see FINDINGS.md) is the proven path,
 * via config.local.json (gitignored). The msnodesqlv8 branch below is a
 * fallback for a zero-credential Windows-trusted setup and needs a native
 * build toolchain this machine doesn't have — not exercised once a SQL login
 * exists.
 */
async function connect(cfg) {
  // A "HOST\INSTANCE" server string (e.g. SQL Express's default naming) isn't
  // parsed by tedious from the `server` field alone — the instance name is a
  // separate `options.instanceName`, and using it means no fixed `port` (it's
  // resolved via the SQL Server Browser service instead).
  let server = cfg.server;
  let instanceName;
  if (server && server.includes("\\")) {
    [server, instanceName] = server.split("\\");
  }

  const config = {
    server,
    database: cfg.database || undefined,
    options: {
      trustServerCertificate: true, // local/LAN Busy SQL instances rarely have a real cert
      encrypt: cfg.encrypt !== false,
      ...(instanceName ? { instanceName } : {}),
    },
  };

  if (cfg.user) {
    config.user = cfg.user;
    config.password = cfg.password;
  } else {
    // Zero-credential Windows Integrated Auth (SSPI, "Trusted_Connection=Yes")
    // needs the current process's Windows token — pure-JS tedious can't do that
    // without a username/password of some form, only msnodesqlv8 (native,
    // wraps the real Windows ODBC/OLEDB stack) can. Needs a native build
    // toolchain to install — see README's fallback if it's not available.
    config.driver = "msnodesqlv8";
    config.options.trustedConnection = true;
  }
  if (!instanceName) config.port = cfg.port || 1433;

  return sql.connect(config);
}

async function listDatabases(cfg) {
  const pool = await connect({ ...cfg, database: "master" });
  try {
    const result = await pool.request().query(
      "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name" // skip system DBs
    );
    return { ok: true, databases: result.recordset.map((r) => r.name) };
  } finally {
    await pool.close();
  }
}

async function listTables(cfg) {
  const pool = await connect(cfg);
  try {
    const result = await pool.request().query(
      "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );
    return { ok: true, tables: result.recordset };
  } finally {
    await pool.close();
  }
}

async function describeTable(cfg, schema, tableName) {
  const pool = await connect(cfg);
  try {
    const result = await pool
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, tableName).query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
        ORDER BY ORDINAL_POSITION
      `);
    return { ok: true, columns: result.recordset };
  } finally {
    await pool.close();
  }
}

async function sampleRows(cfg, schema, tableName, limit = 5) {
  const pool = await connect(cfg);
  try {
    // Table/column identifiers can't be parameterized in T-SQL — schema/tableName
    // here come only from describeTable's own prior INFORMATION_SCHEMA result,
    // never from unvalidated external input, so bracket-quoting is sufficient.
    const result = await pool
      .request()
      .query(`SELECT TOP ${Number(limit)} * FROM [${schema}].[${tableName}]`);
    return { ok: true, rows: result.recordset };
  } finally {
    await pool.close();
  }
}

/**
 * Full discovery sweep: every table + row count, so the tables actually worth
 * describing/sampling (Ledgers/Vouchers/StockItems-shaped, not lookup/config
 * tables) can be picked out by eye from output/ before spending queries on
 * every single one.
 */
async function discoverAll(cfg) {
  const pool = await connect(cfg);
  try {
    const result = await pool.request().query(`
      SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, SUM(p.rows) AS ROW_COUNT
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0,1)
      GROUP BY s.name, t.name
      ORDER BY ROW_COUNT DESC
    `);
    return { ok: true, tables: result.recordset };
  } finally {
    await pool.close();
  }
}

module.exports = { listDatabases, listTables, describeTable, sampleRows, discoverAll };
