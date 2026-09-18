/**
 * Folio 02 (Sync Ledger) step 7 — the recurring push job wrapper.
 *
 * Busy has no live gateway the backend can pull from (unlike Tally's own
 * "Sync Now" button) — this firm is push-only, meaning something has to
 * run `import-to-app.js` on a schedule from wherever it can reach BOTH the
 * Busy SQL Server (the read-only busy_sync_reader login) and the
 * warehouse-system backend (POST /tally/import over HTTP). This file is
 * that "something" — designed to be the Action a Windows Task Scheduler
 * job points at (see run-scheduled-sync.ps1 next to this file), not to be
 * run by a person directly.
 *
 * What it adds over calling import-to-app.js directly:
 *   - A once-per-day guard (output/last-run-date.txt) so an accidentally
 *     duplicated/overlapping Task Scheduler trigger doesn't run the import
 *     twice in the same day — pass --force to override.
 *   - ALWAYS pulls the full history (no --date-from/--date-to) on every
 *     run — see import-to-app.js's own header note on why a recurring job
 *     must never narrow the date range (the backend truncates+reloads the
 *     firm's ENTIRE dataset every call, so a narrow window would silently
 *     delete everything outside it).
 *   - A proper process exit code (0 success, 1 failure) and a one-line
 *     stdout summary, so Task Scheduler's own "last run result" and
 *     Windows Event Log can tell success from failure without opening a
 *     log file.
 *
 * Usage (from Task Scheduler's Action, "Start a program"):
 *   Program:   node.exe
 *   Arguments: scheduled-sync.js
 *   Start in:  <this directory>
 *
 * Manual runs: `node scheduled-sync.js` (respects the once-per-day guard),
 * `node scheduled-sync.js --force` (ignores it — for testing).
 */
const fs = require("fs");
const path = require("path");
const { runImport } = require("./import-to-app");

const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
const LOCK_FILE = path.join(OUTPUT_DIR, "last-run-date.txt");

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local process TZ
}

async function main() {
  const force = process.argv.includes("--force");
  const today = todayStamp();

  if (!force && fs.existsSync(LOCK_FILE)) {
    const lastRun = fs.readFileSync(LOCK_FILE, "utf8").trim();
    if (lastRun === today) {
      console.log(`Already ran today (${today}) — skipping. Pass --force to override.`);
      return;
    }
  }

  console.log(`== Scheduled Busy sync starting ${new Date().toISOString()} ==`);
  const result = await runImport({ dryRun: false }); // full history, every run — see header note

  if (result.ok) {
    fs.writeFileSync(LOCK_FILE, today);
    console.log(`SUCCESS — ${result.mastersCount} masters, ${result.vouchersCount} vouchers imported.`);
  } else {
    console.log(`FAILED (${result.reason}) — ${result.message || JSON.stringify(result.body || {})}`);
    console.log("Not writing the once-per-day lock file — a failed run should be retried on the next trigger, not skipped as 'already done today'.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Unhandled error in scheduled-sync.js:", err);
  process.exitCode = 1;
});
