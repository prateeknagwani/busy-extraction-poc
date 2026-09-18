# Busy Data Extraction — Integration Guide

Pulls ledger/stock/voucher data **OUT of** Busy Accounting Software into
plain JSON your own ERP can ingest. This is the opposite direction from
the separate `busy-voucher-push` repo (which pushes a voucher **INTO**
Busy) — pick this one when you need to *read* Busy's data (for reporting,
reconciliation, or feeding a BI/insights layer), not write to it.

## The key fact that makes this possible

Busy has no public API and no published schema. But on this class of
install, **Busy's data turns out to live in a completely ordinary SQL
Server database** — no proprietary driver, no Busy-side export step
required. Plain T-SQL over ODBC/`mssql` reads it directly, read-only, with
a dedicated low-privilege login. This may or may not be true of the
specific Busy install you're integrating with — the very first thing to
do is confirm it (see "Step 1" below), not assume it.

**If your target install turns out to be Access-backed instead of SQL
Server** (Busy also supports MS Access as a backend on some installs): this
POC includes a fallback ODBC path (`lib/odbc-introspect.js`) but the actual
table/column layout has never been verified against a real Access-backed
install — treat everything below as a SQL Server-only guarantee until you
independently confirm the same schema shape holds for Access too.

## What's actually hard about this (read before you start reverse-engineering)

Busy's schema is a **generic wide-table design** — a handful of tables
(`Master1` for every master type, `Tran1`/`Tran2`/`Tran3` for every voucher
type) shared across every real-world record type, discriminated by a
numeric type code, with meaning-varies-by-type slot columns (`D1..D150`
float, `I1..I30` smallint, `B1..B40` bit, `C1..C7` string). **Nothing is
self-labeled.** Unlike Tally (which exports self-describing XML), there is
no metadata table that tells you what `D9` means for a Stock Item vs a
Ledger — every single mapping has to be reverse-engineered by sampling real
rows and cross-checking against what Busy's own on-screen reports show for
the same record.

`FINDINGS.md` in this repo is the accumulated result of exactly that
reverse-engineering work against one real Busy install — every confirmed
table/column/type-code mapping, the evidence each was checked against, and
(just as important) what's still unconfirmed and must NOT be assumed. Real
party/dealer names in it have been redacted for this handoff, but every
technical finding is intact. **Read it before writing new extraction code**
— re-deriving something already confirmed there wastes time, and a
mapping that "looks obviously right" from one sample has been wrong before
(see `FINDINGS.md`'s "Folio 07" — voucher type codes are per-company, not
a fixed Busy-wide table; two different companies used the same numeric
code for two different real-world voucher types).

**The two standing rules this whole investigation converged on, worth
internalizing before you extend it**:
1. **Never trust a "no matches found" result from a blind/automated search
   without first proving it can find a value you already know is there.**
   (A real bug: casting a `FLOAT` to `NVARCHAR` in SQL Server silently
   truncates to scientific notation with ~6 significant digits — a search
   built on that cast can silently fail to find a real value and report
   "not found" with no error.)
2. **When reconciling two datasets by a name/key, always aggregate (sum)
   by that key on BOTH sides before diffing — never assume the key is
   unique.** A `dict`-keyed comparison silently hides a genuine duplicate
   key on either side and produces a misleadingly small diff.

## Step 1 — confirm your own install's shape

```bash
npm install
npm run test:mock              # sanity check: parsing logic works, no live system needed
npm run list-dsns              # ODBC DSNs registered on the machine you're running this from
node run.js --sqlserver-discover   # every table + row count, once config.json points at a real DB
node run.js --describe-table dbo.Master1   # one table's columns + 5 sample rows
```

Fill in `config.json`'s `sqlserver.server`/`database` with your own Busy
SQL Server instance and database name (`npm run list-dsns` helps find it
if you don't already know it) — real credentials go in `config.local.json`
(gitignored, merged over `config.json` at load time), **never** in
`config.json` itself:

```json
{ "sqlserver": { "user": "busy_sync_reader", "password": "<the real password>" } }
```

Create a **dedicated, read-only** SQL login for this (never point extraction
at an admin/write-capable login) — see `FINDINGS.md`'s "Read-only service
login" section for the exact recipe (grant `db_datareader`, then an
explicit `DENY` on every write/DDL verb as a belt-and-suspenders on top of
just not granting write) and how it was verified in both directions
(reads succeed, writes/DDL are denied).

**Do not assume your install's table/column layout matches `FINDINGS.md`'s
mappings exactly.** Different Busy versions and installs have shown real
differences (see Folio 07's per-company voucher-type codes). Spot-check a
handful of `--describe-table` results against what you already know about
your own data before trusting any extraction built on top.

## Step 2 — multi-fiscal-year databases (don't skip this)

**Busy keeps one whole separate SQL Server database per fiscal year** — a
party's true running balance as of this year's start only exists as
transaction history in the PRIOR year's own separate database. Miss this
and every opening-balance/multi-year figure will be systematically wrong
(this was a real, non-obvious bug — see `FINDINGS.md`'s Folio 08/09).

```bash
node run.js --list-fy-databases
```

lists every sibling database on the same server and its own `Tran1`
voucher date range (`lib/busy-fy-database.js`) — run this FIRST against
any new company's server, never assume the naming convention from a
different company's install carries over unchanged.

## Step 3 — extract

```bash
node run.js --extract-masters [--limit N]
node run.js --extract-vouchers [--vch-type N] [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]
node run.js --extract-all [--date-from Y-M-D] [--date-to Y-M-D] [--limit N]   # masters THEN vouchers, correct order
```

Output shape (`lib/busy-voucher-extractor.js`'s module docstring has the
authoritative version — read it, this is a summary):

**Voucher** (one object per voucher):
```json
{
  "guid": "BUSY-<database>-<VchCode>",
  "vch_type": "Sales",
  "vch_no": "SR/26-27/1234",
  "date": "2026-09-18",
  "party_name": "...",
  "amount": 12345.67,
  "lines": {
    "items": [{ "stockItemName": "...", "amount": 0, "quantity": 0, "unit": null, "rate": 0, "discount": null, "stockGroup": "...", "itemAlias": "..." }],
    "ledger": [{ "ledgerName": "...", "amount": 0, "drCr": "Dr" }]
  },
  "is_optional": false,
  "source": "BUSY"
}
```

**Master** (one object per Ledger Group / Ledger / Stock Group / Stock
Item): `{ guid, master_type: "GROUP"|"LEDGER"|"STOCK_GROUP"|"STOCK_ITEM", name, fields: {...} }`.

`guid` is synthesized (`BUSY-<database>-<Code or VchCode>`) since Busy
records carry no native GUID — stable and unique per source database,
which is enough for cross-source identity if your own ERP needs to track
"where did this row come from."

**Deliberately null on every line, on purpose (not silently wrong)**:
`unit` (Busy's own Unit master isn't resolved by this extractor yet) and
`discount` on most voucher types (no reliable column identified — the one
exception, Sales Order lines, recovers it by comparing the frozen
transaction rate against the item master's CURRENT list price, which is
itself a documented approximation with a known drift risk — see
`FINDINGS.md`'s Folio 06 before relying on it for anything financial).

## Step 4 — wire it into YOUR OWN backend

**`import-to-app.js` is a REFERENCE implementation, not a universal
adapter.** As shipped, it does exactly one thing: extract, then
`POST` the result to *this codebase's own* `warehouse-system` backend's
`/tally/import` endpoint (a shared-secret-authenticated, firm-scoped,
truncate-and-reload import). Your own ERP almost certainly has a different
ingestion shape. Two ways to proceed:

1. **Easiest**: run `node import-to-app.js --dry-run`, which writes the
   full extracted payload to `output/busy-import-payload.json` and posts
   nothing — then write your own small script that reads that file (or
   calls `extractMasters()`/`extractVouchers()` from
   `lib/busy-voucher-extractor.js` directly) and POSTs it to YOUR OWN
   ingestion endpoint in whatever shape it expects.
2. **Adapt `import-to-app.js` itself** — swap its POST target/auth header
   for your own endpoint, keep its retry-with-backoff and its two safety
   guards (see below), which are worth keeping regardless of target:
   - **Empty-payload guard**: refuses to proceed if extraction returned 0
     masters and 0 vouchers, UNLESS you explicitly override it — a silent
     truncate-and-reload against an empty extraction (e.g. a dropped DB
     connection, or a wrong database after a fiscal-year rollover) would
     otherwise delete real data on the receiving end for no reason.
   - **Unmapped-vch_type warning**: if any voucher lands as `UNKNOWN_<N>`,
     that means this Busy install uses a voucher type code this extractor
     hasn't seen and classified yet — read `FINDINGS.md`'s VchType
     findings, sample a few of those real vouchers yourself, and add a
     proper mapping to `lib/busy-voucher-extractor.js`'s `VCH_TYPE_MAP`
     before importing — don't blindly force these through unclassified,
     since a real voucher type flowing in as "unknown" can silently be
     excluded from downstream financial totals depending on how your own
     system treats unclassified data.

`scheduled-sync.js`/`run-scheduled-sync.ps1` is the recurring-job wrapper
(once-per-day guard, always pulls full history since a truncate-and-reload
target means a narrow date range would silently delete data outside it on
every run) — reusable as-is once `import-to-app.js` itself points at your
own backend.

## Reference: the original integration this was built for

`RUNBOOK.md` walks through the exact steps used to wire this extractor up
to `warehouse-system`'s own backend (create a Firm row, first dry run,
first real import, scheduling). It's written in terms of that specific
backend's own endpoints — useful as a worked example of the same checklist
this guide describes in the abstract, not as literal instructions for a
different backend.

## What this repo does NOT do

- **No write path.** This never inserts/updates/deletes anything in Busy's
  database — every SQL login this repo uses/recommends is read-only,
  verified both directions (reads succeed, writes/DDL are denied). If you
  need to push data INTO Busy, see the separate `busy-voucher-push` repo
  (a completely different mechanism — UI automation against Busy's own
  Import dialog, not a SQL write).
- **No scheduling infrastructure beyond the one PowerShell/Task Scheduler
  wrapper** — if your own environment isn't Windows Task Scheduler, adapt
  `scheduled-sync.js` (plain Node, no Windows-specific API calls in the
  script itself) to whatever your own cron/scheduler is.
- **No guarantee your install's schema matches these findings exactly.**
  Busy's schema is known to shift between versions/installs (unlike
  Tally's documented TDL) — treat every mapping here as a starting point
  to verify against your own data, not a spec to trust blindly.

## Repo layout

```
lib/                  SQL Server/ODBC introspection, XML shape-sniffing, the actual extractor
run.js                CLI entry point — see its own --help-equivalent usage text
import-to-app.js      reference push-to-backend script (adapt for your own ERP, see Step 4)
scheduled-sync.js      recurring-job wrapper (once-per-day guard, always full history)
run-scheduled-sync.ps1 Windows Task Scheduler entry point
fixtures/             synthetic XML fixture for mock-mode validation (no live data)
FINDINGS.md           the accumulated schema reverse-engineering — read this
RUNBOOK.md            original reference integration walkthrough (see above)
config.json           template config — fill in your own server/database, real creds go in config.local.json (gitignored)
```

`node_modules/`, `output/`, `config.local.json` are gitignored.
