# Busy Extraction POC — Phase 0

**Integrating this with your own ERP?** Start with `INTEGRATION_GUIDE.md`
— that's the generic, backend-agnostic version of this walkthrough.
`RUNBOOK.md` documents the original reference integration (this
extractor wired up to `warehouse-system`'s own backend specifically) —
useful as a worked example, not literal instructions for a different
backend.

Mirrors `tally-extraction-poc/`'s approach for Tally: figure out how to pull
ledger/stock/voucher data out of Busy Accounting Software, side by side with
a mock mode that proves the parsing logic is correct in isolation. Unlike
Tally, this deployment's Busy data turned out to live directly in a **real
SQL Server database**, found live on this machine — see `FINDINGS.md` for
everything confirmed against it so far. Read that first; this file is just
"how to run the scripts."

## Running it

```
npm install
npm run test:mock              # validates XML parsing logic, no live system needed
npm run list-dsns               # lists ODBC DSNs on THIS machine
node run.js --sqlserver-discover                  # every table + row count (config.json's sqlserver.*)
node run.js --describe-table dbo.Master1          # one table's columns + 5 sample rows
node run.js --parse-xml                           # sniff shape + parse a Busy XML export (fixture or config.json's xml.sampleFile)
```

`--sqlserver-discover`/`--describe-table` need a working connection —
fill in `config.json`'s `sqlserver.server`/`database` with YOUR OWN Busy
SQL Server instance/database (run `npm run list-dsns` first if you don't
already know it), and create a scoped read-only login on it (e.g.
`busy_sync_reader`, `db_datareader` + explicit DENY on every write/DDL verb
— see `FINDINGS.md`'s "Read-only service login" section for the exact
recipe this was originally verified against). Its credentials go in
`config.local.json` (**gitignored** — never commit it), merged over
`config.json` at load time:

```json
{ "sqlserver": { "user": "busy_sync_reader", "password": "<the real password>" } }
```

On a different machine (no `busy_sync_reader` login there yet), the same
queries can be run via
`sqlcmd -S "<server>\<instance>" -E -d <database> -Q "..."` (trusted Windows
auth) instead — which is how the schema was first explored before this login
existed.

## What's here

- `lib/dsn-discovery.js` — enumerates ODBC DSNs via PowerShell's `Get-OdbcDsn`, no npm dependency.
- `lib/sqlserver-introspect.js` — direct SQL Server introspection via `mssql` (pure-JS `tedious`, no native build needed for SQL-login auth) — table/column discovery via `INFORMATION_SCHEMA`, never hardcoded table names.
- `lib/odbc-introspect.js` — generic ODBC path via the `odbc` npm package (optional dependency, needs a native build toolchain) — kept as a fallback in case a future firm's Busy install *doesn't* expose plain SQL Server underneath.
- `lib/xml-shape-sniffer.js` — a generic "what does this XML actually look like" tool, plus a targeted parser for the one Busy XML shape already confirmed in production (`backend/app/services/xml_parser.py::parse_so_xml`) — reused here as a known-good baseline.
- `fixtures/sample-sale-order.xml` — synthetic, shaped to match that confirmed production XML, for mock-mode validation with no live file needed.
- `FINDINGS.md` — everything actually confirmed against the real live database on this machine. **This is the important file**, not this README.
- `lib/busy-voucher-extractor.js` — normalizes real Busy rows into `TallyVoucher`/`TallyMaster`'s exact shape (`extractMasters`/`extractVouchers`).
- `lib/busy-fy-database.js` — resolves which of Busy's per-fiscal-year sibling databases to connect to (manual by default, opt-in auto-detection off today's date) — see Folio 02 step 6 in the Sync Ledger.
- `import-to-app.js` — the actual import job: extract + `POST /tally/import`. Exports `runImport()` for reuse; has its own retry-with-backoff, an unmapped-vch-type guard, and an empty-extraction guard (mirrors the backend's own `allow_empty` safety check) — see its header comment.
- `scheduled-sync.js` / `run-scheduled-sync.ps1` — the recurring-job wrapper (once-per-day guard, always full history, proper exit codes/logging) meant to be pointed at by a Windows Task Scheduler Action — see Folio 02 step 7.

## What's deliberately not here yet

Full `D*`/`I*`/`B*` generic-slot decoding per master/voucher type (only
spot-checked so far), a normalizer that maps this schema onto
`TallyMaster`/`TallyVoucher`'s shape (the next real step once the type
dictionary above is more complete), any writing/scheduling/upload endpoint —
matching Tally POC's own Phase 0 scope ("no app changes yet").
