# Folio 02 Runbook — completing the Busy import (steps 5, 7, 8, 9)

> **This runbook documents the ORIGINAL reference integration**: wiring
> this extraction tool up to push into *this codebase's own*
> `warehouse-system` backend (its `/firms` and `/tally/import` Tally-Mode
> endpoints). If you're integrating with a **different** ERP/backend, treat
> this file as a worked example of "how one real consumer wired this in,"
> not literal instructions — swap every `POST /firms`/`POST /tally/import`
> call below for your own ERP's own ingestion endpoint(s), and see
> `INTEGRATION_GUIDE.md` for the generic version of this same checklist.

For whoever has (or regains) live access to the Busy SQL Server / the
machine this runs on — everything Folio 02 could get done without live DB
access is already done (see the Sync Ledger artifact). This is the
remaining checklist to actually land the first real Busy firm, in order.

## Before you start

- Confirm you can reach the Busy SQL Server from wherever this will run:
  `node run.js --sqlserver-discover` should list tables + row counts.
- Confirm the warehouse-system backend is reachable from the same place
  (`curl http://<backend-host>:8000/` should respond) — this matters more
  once the job is scheduled to run somewhere other than the backend's own
  host (see step 3 below).
- `config.local.json` (gitignored) must have real values for
  `sqlserver.user`/`sqlserver.password` (the `busy_sync_reader` login) and
  `backend.tallyImportKey` (must match the backend's `TALLY_IMPORT_KEY` env
  var exactly).

## Step 1 — Decide the firm's name, create it

Pick the permanent display name for this Busy company (shows up on the
Firms Settings card, and — once a second firm exists — on every Tally Mode
screen's firm badge). Not reversible without breaking existing synced
data's meaning, so pick something that reads well on screen, not an
internal code.

Create it either via the UI (Settings page → Tally Mode section → Firms
Settings card → "Add Firm", source system = BUSY, db_server/db_database =
the values already in `config.json`'s `sqlserver` block, purely for
documentation) or via the API:

```
POST /firms
{ "name": "<the chosen name>", "source_system": "BUSY",
  "db_server": "YOUR_SERVER\\SQLEXPRESS", "db_database": "YOUR_BUSY_DATABASE" }
```

Note the returned `id` — that's the `firmId` for the next step. **Once a
second firm exists, `firmId` becomes REQUIRED on every import/sync-settings
call** (`_resolve_or_default_firm_id` no longer guesses).

## Step 2 — Point config at the new firm

In `config.local.json`:

```json
{ "backend": { "firmId": <the id from step 1> } }
```

## Step 3 — Decide where this runs (push topology)

Busy has no live gateway — the job must run somewhere with BOTH SQL Server
access to Busy AND outbound HTTP access to the backend. Two realistic
options:

- **On the machine hosting the Busy SQL Server itself** (simplest network
  path — no firewall/VPN needed for the SQL Server leg, only outbound HTTPS
  to wherever the backend runs).
- **On a separate always-on machine that can reach both** (if the Busy
  machine shouldn't run scheduled jobs, or isn't reliably powered on).

Whichever you pick, confirm outbound reachability to the backend from
there before scheduling anything (`curl <backend-url>/` from that exact
machine).

## Step 4 — First real dry run

From the chosen machine, with `config.local.json` filled in:

```
node import-to-app.js --dry-run
```

Check the console output:
- `== Database: ... (MANUAL — ...) ==` — confirm it names the database you
  expect (see `lib/busy-fy-database.js`'s header if you want to switch to
  the AUTO fiscal-year-rotation mode instead of editing this by hand each
  year).
- masters/vouchers counts look plausible (thousands, not zero, not
  suspiciously small).
- No `WARNING: N voucher(s) have an unmapped vch_type` — if there is one,
  read `FINDINGS.md`'s VchType table first; a real Busy install with a
  voucher type this POC hasn't seen needs a new mapping in
  `lib/busy-voucher-extractor.js` before importing those vouchers, not a
  blind `--allow-unknown-types` override.

Open `output/busy-import-payload.json` and spot-check a handful of real
vouchers against Busy's own screen for the same voucher (amount, party,
line items) — this is the actual "prove a human can trust this number"
check, not just "did the script not crash."

## Step 5 — First real (non-dry-run) import

Once step 4 looks right:

```
node import-to-app.js
```

This posts the FULL history (every voucher this Busy database has ever
recorded) in one call — expected to take a while for a large dataset, this
is normal (same as Tally's own Sync Now, which the CLAUDE.md notes can take
1-2 minutes; a full Busy history is likely to take longer than that).

## Step 6 — Verify

- `GET /tally/sync-runs?firm_id=<firmId>` — one new row, `status: SUCCESS`,
  `masters_count`/`vouchers_count` matching what step 5 printed.
- `GET /tally/summary?firm_id=<firmId>` — sane-looking totals.
- Open a few of the same vouchers you spot-checked in step 4 via
  `GET /tally/vouchers?firm_id=<firmId>` → click through to
  `TallyVoucherDetail.js` on screen, confirm they render correctly (this
  also exercises the firm badge, `components/FirmBadge.js` — with 2+ firms
  now synced it should actually show a pill next to the party name).
- Spot-check one or two Insights endpoints scoped to just this firm, e.g.
  `GET /tally/insights/executive?firm_id=<firmId>` — these were all made
  firm-aware in Folios 03/04 but have never been exercised against real
  Busy data until now.

## Step 7 — Schedule the recurring job

Once step 6 looks right, set up the recurring push (see
`scheduled-sync.js`'s own header for what it adds over calling
`import-to-app.js` directly — a once-per-day guard, and it always pulls
full history since the backend's truncate+reload means a narrow date range
would silently delete data outside it on every run).

On Windows, use `run-scheduled-sync.ps1` as a Task Scheduler Action (see
that file's own header for the exact setup) — pick a daily trigger time
that suits when this dealer's Busy data is expected to be settled for the
day.

After the first scheduled run fires (or run it once manually with
`node scheduled-sync.js --force` to test without waiting for the trigger),
repeat step 6's verification once more, then this Folio is done —
`output/sync-log.jsonl` keeps a running record of every run (success or
failure with a reason) from here on.

## If something goes wrong

- **Import refused with "already has synced data"** — the empty-payload
  safety guard tripped (see `ImportRequest.allow_empty` in
  `tally_router.py`, and the client-side mirror in `import-to-app.js`).
  This means the extraction returned 0 rows — almost always a real problem
  (dropped connection, wrong database after a fiscal-year rollover, an
  over-narrow date filter) worth fixing rather than overriding. Only pass
  `--allow-empty` if you've confirmed the dealer genuinely has zero Busy
  data (implausible for anything but a brand-new company).
- **HTTP 403 from `/tally/import`** — `tallyImportKey` doesn't match the
  backend's `TALLY_IMPORT_KEY` env var.
- **HTTP 400 "firm_id is required once more than one firm exists"** —
  step 2 wasn't done, or a second firm was created after config.local.json
  was written and `firmId` needs updating.
