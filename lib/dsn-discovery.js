const { spawnSync } = require("child_process");

/**
 * Enumerates ODBC DSNs registered on THIS machine via PowerShell's Get-OdbcDsn —
 * no native npm dependency needed for this step, unlike the actual data pull later.
 * Must be run on the machine where Busy (and its ODBC driver, if it registers one)
 * is actually installed — running it here, in a sandbox with no Busy install, will
 * only ever show the generic Windows-shipped drivers (SQL Server, Access, Excel, ...).
 */
function listOdbcDsns() {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-OdbcDsn | Select-Object DsnType,Name,DriverName | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      reason: result.stderr || "Get-OdbcDsn returned no output — not on Windows, or no DSNs registered at all.",
      dsns: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { ok: false, reason: `Could not parse PowerShell output: ${err.message}`, dsns: [] };
  }

  const dsns = Array.isArray(parsed) ? parsed : [parsed];
  const likelyBusy = dsns.filter(
    (d) =>
      /busy/i.test(d.Name || "") ||
      /busy/i.test(d.DriverName || "")
  );

  return { ok: true, dsns, likelyBusy };
}

module.exports = { listOdbcDsns };
