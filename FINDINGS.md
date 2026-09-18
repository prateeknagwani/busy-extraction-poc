# Busy Extraction — Phase 0 Findings

Confirmed against a **real, live Busy database** (SQL Server 2022 Express,
Windows/Trusted auth, mixed-mode auth already enabled) — not guessed, not
from documentation (Busy doesn't publish its SQL schema the way Tally
publishes TDL).

> **Redacted for external distribution.** This file was originally written
> against a real production Busy database and originally named real
> dealer/party names, real company codenames, and real machine/server
> names in its evidence trail. Every one of those has been replaced below
> with a generic placeholder (`Firm-A`/`Firm-B`, `Example Dealer A`,
> `DEV-MACHINE\SQLEXPRESS01`, etc.) — consistently per name, so the same
> placeholder always refers to the same real entity throughout this file.
> Every table/column/type-code/formula finding itself is untouched and
> still fully trustworthy; only the identifying labels changed. A couple
> of evidence citations reference source spreadsheets (e.g. a `*.xlsx`
> report a placeholder-named folder) that aren't included in this repo for
> the same reason.

## Extraction path — confirmed

- **No Busy-proprietary driver needed.** The System DSN uses the plain
  `SQL Server` ODBC driver — this is stock T-SQL over TDS the whole way.
- **`sqlcmd -E` (trusted/Windows auth) works today**, read-only, with zero
  new credentials — used for every query below.
- **Zero-credential auth from Node is the awkward part.** Pure-JS `mssql`
  (tedious) can't do real SSPI without *some* credential; the native
  `msnodesqlv8` driver can, but needs a C++ build toolchain (Visual Studio
  "Desktop development with C++") this machine doesn't have.
  **Recommended fix, not yet done — needs your OK**: create a dedicated
  read-only SQL login (e.g. `busy_sync_reader`, `db_datareader` on just this
  DB) since mixed-mode auth is already on. That's also the *right* shape for
  an eventual scheduled sync job anyway — a service credential, not a
  personal Windows identity, matching `TALLY_IMPORT_KEY`'s pattern. I didn't
  create it myself (a DDL/security change on a live DB), see "Next step"
  below.

## Schema shape — fundamentally different from Tally

Tally's XML is self-describing (`<SaleOrder>`, `<ItemDetail>`, named fields).
**Busy's SQL schema is a generic wide-table design** — a handful of tables
shared across every real-world type, discriminated by a numeric type code,
with meaning-varies-by-type slots (`D1..D150` float, `I1..I30` smallint,
`B1..B40` bit, `C1..C7` string). Nothing is self-labeled; every mapping below
was reverse-engineered by sampling real rows, not read off a metadata table
(`RepColSize`/`RepOptValues`, which looked promising, turned out to be
report-column pixel-width config — a dead end for this purpose).

### `Master1` — every master type, keyed by `MasterType`

| MasterType | Count (this DB) | Confirmed as | Evidence |
|---|---|---|---|
| 1 | 29 | **Ledger Group** | Rows: "Capital Account", "Current Assets", "Bank Accounts" (ParentGrp=102=Current Assets) — exact Tally-equivalent chart-of-accounts groups, `ParentGrp` is the parent group's own `Code`, 0=top-level |
| 2 | 2,305 | **Ledger** | Rows: default P&L/expense/GST-input-output ledgers AND real party ledgers (dealers/customers), `ParentGrp`=their group's Code |
| 6 | 11,090 | **Stock Item** | Rows: real Honda part numbers (e.g. `01210K0LD00`), by far the largest table — matches this app's own Part Master scale |
| 5 | (Stock Group count not sampled) | **Stock Group** | A Stock Item's (MasterType=6) `ParentGrp` resolves to a MasterType=5 row — e.g. "18-Honda-Running", "18-Honda-Others" — real Honda parts categories |
| 55, 56, 21, 13, 14, 9, 31, 30, 22, 69, 25, ... | single/low digits | **Unconfirmed** | Likely Units, Voucher Series, Godowns/Branches, Tax categories, etc. — not sampled yet, low row count = config-ish, not transactional |

Columns: `Code` (PK), `Name`, `Alias`, `PrintName`, `ParentGrp`. The
`D*`/`I*`/`B*`/`C*` slots' meaning still needs decoding **per MasterType** —
e.g. Stock Item's `D1`/`D2`/`D3` looked like unit-factor/opening-qty/rate in
a 3-row eyeball check, not yet verified against Busy's own item-master screen
side by side.

### `Tran1` — voucher header, keyed by `VchType`

| VchType | Confirmed as | Evidence |
|---|---|---|
| 9 | **Sales** | Legs: `Sales`(Cr), `CGST/SGST Output`(Cr), party(Dr) — real GST-split sales voucher. Two internal numbering series share this type ("SR/26-27/..", "TI/26-27/..") — a dealer-configured naming choice, not two different types |
| 2 | **Purchase** | Real voucher against "Example Supplier Ltd (State)", ₹5+ lakh — matches this app's own Honda-purchase domain |
| 3 | **Credit Note (Sales Return)** | "CN/26-27/.." against real customer ledgers |
| 12 | **Sales Order** (non-accounting) | "SO/26-27/.." — Busy's own Sales Order voucher, separate from an accounting Sales voucher — same SO/DO concept this app already parses from Busy's XML export. Posts no `Tran2` rows (no ledger/item legs there) but DOES have real line items, in `Tran3`/`RecType=4` — see Folio 06 |
| 14 | **Payment** | Legs: Bank ledger(Dr, negative), Party ledger(Cr, positive) — a bank paying a supplier |
| 16 | **Journal** | "JE/26-27/.." — `VchSalePurcAmt`=0 as expected (no sale/purchase amount on a pure journal) |
| 5 | **Stock Journal** | Legs are `RecType=2` (item legs, `MasterCode1` doesn't resolve against `Master1` MasterType=2) with paired +/- quantities — a stock-only transfer/adjustment, no ledger leg at all |
| (not seen in this window) | Receipt | Not sampled — should sit near 14 (Payment)'s type-code neighborhood; needs one more targeted query once real Receipt vouchers are found |

### `Tran2` — voucher line detail, split by `RecType`

- **`RecType=1`** = ledger leg (`MasterCode1` → `Master1` MasterType=2, `Value1`
  = signed amount) — Busy's equivalent of Tally's `ALLLEDGERENTRIES.LIST`.
- **`RecType=2`** = stock-item leg (`MasterCode1` → `Master1` MasterType=6,
  presumably) — Busy's equivalent of `ALLINVENTORYENTRIES.LIST`.
- This means **one Tran2 result set per VchCode gives the same
  `{ledger: [...], items: [...]}` split** `TallyVoucher.lines` already uses —
  a real, structural reason the normalize-into-the-same-table plan from the
  earlier discussion is workable, not just theoretically similar.

### `Tran3` — bill-wise references (unconfirmed but very promising)

Columns include `RefCode`, `Method`, `DueDate`, `Balance1/2/3` — this shape
strongly suggests Busy's own bill-wise/reference allocation table (which
charge a payment settles, with a due date) — i.e., **Busy may track real due
dates**, something Tally's own sync never gets (Receivables/Payables here is
built on a plain FIFO-by-voucher-date approximation specifically because
Tally has no due-date concept). If confirmed, a Busy-sourced Receivables
dashboard could be MORE accurate than the Tally-sourced one, not just a
parallel implementation. **Not yet verified** — needs a targeted sample
joining `Tran3` back to a real invoice+its later payment.

### Other tables seen, not yet explored
`DailySum` (87k rows, likely a precomputed daily-balance cache — Busy's own
equivalent of this app's `tally_agg_daily`?), `VchGSTSumItemWise`/`VchOtherInfo`
(GST return support), `MasterAddressInfo` (clean, self-explanatory party
address/GSTIN/contact columns — no reverse-engineering needed here),
`MastFootPrint` (audit trail?).

## What Phase 0 proves, and what it doesn't

**Proves**: a live Busy SQL Server is reachable read-only today with zero new
credentials; the wide-generic-table schema is decodable by sampling (not a
brick wall); the ledger/item leg split structurally matches what
`tally_masters`/`tally_vouchers` already expect, which is the load-bearing
fact for the "reuse the same modules" plan.

**Doesn't yet prove**: full `D*`/`I*`/`B*` slot semantics per type (only
spot-checked, not verified against Busy's own on-screen reports the way the
Tally POC's own validation plan called for); Receipt voucher's type code;
whether `Tran3` really is due-date bill tracking; whether this schema is
stable across Busy versions (this is one install's schema — Busy's schema is
known to shift between major versions, unlike Tally's documented TDL).

## Read-only service login — created and verified

`busy_sync_reader` exists on `DEV-MACHINE\SQLEXPRESS01`: `db_datareader`
on `BusyCOMP0001_db12026` only, plus an explicit `DENY` on
INSERT/UPDATE/DELETE/EXECUTE/ALTER/CREATE TABLE/CREATE VIEW/CREATE
PROCEDURE/CREATE FUNCTION/REFERENCES (belt-and-suspenders beyond just "don't
grant write"). Verified in both directions:

- **Read works**: `SELECT COUNT(*) FROM Master1 WHERE MasterType=6` → 11,095.
- **Write fails**: `UPDATE Master1 ...` → `Msg 229 ... UPDATE permission was denied`.
- **DDL fails**: `CREATE TABLE ShouldFail (...)` → `Msg 262 ... CREATE TABLE permission denied`.
- **No cross-database access**: this instance actually has 3 Busy databases
  (`BusyComp0001_db`, `BusyComp0001_db12025`, `BusyComp0001_db12026` — looks
  like separate fiscal-year copies) — `busy_sync_reader` can list their
  *names* (harmless server metadata) but a real query against
  `BusyComp0001_db12025` fails with `Login failed ... Cannot open database`
  since no user is mapped there.
- Also confirmed end-to-end through the actual Node POC (`node
  run.js --sqlserver-discover` / `--describe-table`), not just `sqlcmd`.

**Credentials live only in `config.local.json`** (gitignored, merged over
the checked-in `config.json` template at load time) — never in a tracked
file. The password itself isn't repeated here either; it's in that local
file on this machine only.

## Voucher extraction — normalized to TallyVoucher's exact shape

`lib/busy-voucher-extractor.js` (`node run.js --extract-vouchers`) pulls real
`Tran1`+`Tran2`+`Master1` rows and produces objects shaped exactly like
`POST /tally/import`'s `VoucherIn` — the point being cross-firm reuse of
Tally Mode's ~40 insight endpoints, not a parallel Busy-only implementation.

**Ran against 3,000 real vouchers (the most recent window), zero
`UNKNOWN_` vch_types** — every voucher classified cleanly as Purchase/Sales/
Sales Order/Credit Note/Stock Journal/Payment/Journal. Receipt still hasn't
appeared in any sampled window — either genuinely rare for this dealer
(cash-settled sales need no separate Receipt) or its type code sits adjacent
to Sales Order(12)/Payment(14) and just hasn't shown up yet; still an open
item, not a failure. Hand-verified one Sales and one Purchase voucher
line-by-line against the raw tables:

- **`amount` is computed from ledger-leg reconciliation** (`max(ΣCr, ΣDr)`
  over `RecType=1` legs), never `Tran1.VchSalePurcAmt` — confirmed that
  column is only the ex-tax goods subtotal (6508.32 vs the real invoice
  total of 7680.00 on the sample voucher) — the exact same trap
  `totalFromLedger()` exists to avoid for Tally.
- **`Tran2.Value1`'s sign is TRUE double-entry Dr(-)/Cr(+) per line** —
  confirmed the party leg and Sales/Tax legs carry opposite real accounting
  signs on the same voucher. This is a genuine difference from Tally, where
  the confirmed convention is "one sign for the WHOLE voucher" (a quirk of
  Tally's own XML export, not a universal accounting-software behavior) —
  worth remembering if a shared normalizer ever tries to unify the two
  sign-handling code paths; they are NOT the same rule wearing two names.
- **Item quantity/value/rate decoded**: `Value1`=`Value2`=signed qty,
  `Value3`=signed ex-tax line value, `rate` is DERIVED (`amount/quantity`),
  never trusted from a raw column — same rule Tally's own sync applies to
  its `RATE` tag.
- **Stock Group resolves via `Master1.ParentGrp`**, but the group's own
  `MasterType` varies by what's being resolved (1=Ledger Group for a
  Ledger's parent, 5=Stock Group for a Stock Item's parent) — the join must
  not hardcode one MasterType, a real bug hit and fixed during this pass.

**Still null/unresolved on every extracted line, on purpose (not silently
wrong)**: `unit`, `discount` (no column identified yet), and `stockGroup`
beyond the item's IMMEDIATE parent — not walked to a top-level brand the way
Tally's sync walks `STOCK_GROUP.Parent` chains (unconfirmed whether Busy
Stock Groups even nest more than one level here).

`guid` is synthesized (`BUSY-<database>-<VchCode>`) since Busy vouchers carry
no GUID — stable and unique per source database, which is what cross-firm
identity actually needs.

**Not yet wired into the real import path** — `source`/these exact
extra-vs-VoucherIn fields aren't accepted by `POST /tally/import` today
(it hardcodes `source="TALLY"`); actually loading this into `tally_vouchers`
needs that endpoint (or a new one) to accept a `source` param, plus the
`firm_id` schema work discussed earlier for true multi-firm. This POC proves
the DATA SHAPE lines up; wiring it into the app is a deliberate next step,
not done here.

## Next steps (not yet done)

- ~~Confirm Receipt's `VchType` code~~ **Done (Folio 02)** — see below.
- `Tran3`'s due-date-bill-tracking theory — still unconfirmed.
- ~~Decode `D*`/`I*`/`B*` slot semantics~~ — item-leg discount/MRP decoded
  (below); the rest of the D/I/B slots remain unexplored, lower priority
  now that the fields VoucherIn actually needs are covered.
- Design the actual normalizer (Busy schema → `TallyMaster`/`TallyVoucher`
  shape) once enough of the above is confirmed — this is Phase 1, not
  Phase 0.
- The 3-fiscal-year-copy discovery (`BusyComp0001_db`/`_db12025`/`_db12026`)
  matters for the sync design: an eventual sync job needs to know it may be
  pointed at more than one same-company database over time (year-end
  rollover), not assume one fixed DB name forever.

## Folio 02 — confirmed against the FULL live database, not a sample

- **Receipt's `VchType` code: genuinely absent, not unsampled.** Queried
  `SELECT VchType, COUNT(*) FROM Tran1 GROUP BY VchType` against the WHOLE
  table (7,335 rows, every row accounted for): only 7 codes exist anywhere
  in this database's history — 9 (Sales), 12 (Sales Order), 2 (Purchase), 3
  (Credit Note), 16 (Journal), 14 (Payment), 5 (Stock Journal). No code sits
  unclassified. This dealer's Busy setup evidently never books a separate
  Receipt voucher (cash sales settle without one) — a real fact about this
  data, not an extraction gap. No `UNKNOWN_` vch_type should ever appear on
  a real extraction from this database; if one does, that's a genuinely new
  voucher type, not Receipt.
- **Item-leg discount/MRP decoded — exact arithmetic match, not eyeballed.**
  Verified across 6 real item lines on one live Sales voucher (VchCode
  7328): `D9` = discount % (whole number), `D4` = MRP / list price
  (incl-tax, PRE-discount), `D2` = `D3` = post-discount incl-tax rate, and
  `D4 * (1 - D9/100) === D2` matched to the paisa on every single line
  (e.g. `3825 * 0.86 = 3289.5` exactly). `D6` = post-discount EX-tax rate
  (`D6 * qty` = the ex-tax line value already read off `Tran2.Value3`
  directly). `discount` sent to the app now comes straight off `D9`.
- **Stock Group nesting: confirmed, not hypothetical.** This dealer's 5
  real Stock Groups include actual nesting — "18-Honda-Running" and
  "18-Honda-Others" both parent to the top-level "Honda" group (`ParentGrp`
  chain, 2 levels deep). An item filed under "18-Honda-Running" must show
  brand "Honda", not the sub-group name — same walk-to-top-level rule
  `tally_sync.py::_top_level_stock_group` already applies for Tally, now
  ported to `lib/busy-voucher-extractor.js`'s `topLevelStockGroup()`. Busy's
  terminal sentinel is simply `ParentGrp=0` (no "Primary"-string special
  case needed, unlike Tally).
- **Masters extraction implemented** (`extractMasters()` in
  `lib/busy-voucher-extractor.js`, `node run.js --extract-masters` /
  `--extract-all`) — pulls all 13,435 Ledger Group/Ledger/Stock
  Group/Stock Item rows (`MasterType` 1/2/5/6), normalized to `MasterIn`
  shape with `master_type` labels ("GROUP"/"LEDGER"/"STOCK_GROUP"/
  "STOCK_ITEM") matching `tally_sync.py`'s own convention exactly — a Stock
  Item's `brand_category` is walked to the topmost Stock Group before
  being returned, same "denormalize once, at write time" reasoning
  `tally_sync.py` documents. `extractVouchers()` now takes this same
  masters-derived lookup for item-line `stockGroup`/`itemAlias` instead of
  its own weaker immediate-parent SQL join.
- **`import-to-app.js` written** — extracts masters+vouchers and `POST`s to
  the real `/tally/import` (`X-Tally-Key` header, same shared secret Tally's
  own sync uses; no new backend endpoint needed — it already derives
  `source` from whichever `firm_id` the payload is scoped to). `--dry-run`
  mode writes `output/busy-import-payload.json` without posting — used to
  verify the full pipeline end-to-end against this live database (13,435
  masters + a real voucher batch, correct shape, no errors) before any
  first real import.
- **Firms now have a Settings UI + a documentation-only DB mapping.**
  `firms.db_server`/`firms.db_database` (migration
  `20260911b_firm_db_mapping`) record where each firm's data physically
  comes from — a Tally company's gateway host, or a Busy company's SQL
  Server instance\database — never a live connection the backend itself
  opens from these fields (real credentials still only ever live in this
  POC's own `config.local.json`, gitignored). Managed on the Settings page's
  new Firms card (`FirmsSettingsCard`, `frontend/src/Settings.js`) — create
  a firm, edit its DB mapping, toggle active, all without curl/API calls.

## Folio 03 — app-side multi-firm read scoping (no live Busy DB needed)

Done from the warehouse-system app side, not this POC repo, but the
direct prerequisite for trusting a second (Busy) firm's numbers once it's
actually syncing:

- **`app/services/tally_financial_statements.py`'s whole perpetual-WAC
  engine now accepts an optional `firm_id`** (`_walk_stock_wac`,
  `stock_cogs_events`, `stock_valuation_snapshot`, `closing_stock_value`,
  `stock_summary`, `stock_item_register`, `build_balance_sheet`,
  `build_profit_and_loss`, `_GroupGraph`, `_ledger_masters`,
  `_scan_ledger_movements`, `_voucher_type_parent_map`,
  `ledger_names_under_primary`) — default `None` still means "every firm
  at once" so every existing single-firm caller is unaffected.
  `app/services/tally_aggregates.py::_recompute_partner_health` now passes
  its own `firm_id` through, fixing the documented gap where a second
  firm's Purchase/Sale history (even a same-named stock item — plausible
  for two Honda dealerships) could leak into another firm's margin/COGS
  figures during `POST /tally/import`'s post-truncate aggregate rebuild.
  Covered by `backend/tests/test_tally_multi_firm_scoping.py` (two firms,
  a same-named "WIDGET" stock item at very different cost bases,
  chronologically interleaved so the pre-fix code's shared running-average
  pool would visibly contaminate Firm A's own margin figure).
- **Done, in a follow-up pass (still no live Busy DB needed)**: `tally_router.py`'s
  own ~40 read/Insight endpoints (Summary, Vouchers, Parties/Brands/Stock-Items,
  Sync Runs, Opening Balances, Ledger View, Balance Sheet, P&L, Executive,
  Voucher Health, Dealer 360, Sales Performance, Growth Bridge, Budget vs
  Actual, Receivables/Payables, Inventory, Stock Summary/Register, Territory,
  Reconciliation, Command Center, Salesperson Map, Partner Intelligence, SKU
  Intelligence, Brand Performance/Matrix, Purchase & Replenishment, Margin &
  Profitability, Salesperson Intelligence, Exceptions, Custom Report
  Generator, Salesman Tour Plan, Cash-Flow Projection — plus every export
  each of these has) now all accept an optional `firm_id` and thread it
  through their own queries and every shared helper (`_voucher_query`,
  `_receivables_or_payables`/`_fifo_aging_by_party`, `_item_lines_by_vch_class`,
  `_brand_partner_matrix_data`, `_custom_report_data`, `_tour_plan_for_party`,
  `_cashflow_projection`, etc.). Only genuinely global/manually-fed tables
  with no `firm_id` column at all (salespeople, budget target rows, alert/
  cashflow/fy-default settings, recurring cashflows, saved tour plans) stay
  unscoped — their own screens' *actuals* are still firm-scoped, just not
  the target/setting rows themselves. Covered by
  `backend/tests/test_tally_multi_firm_scoping.py`. This closes out the
  read-side half of the multi-firm foundation entirely from the app side —
  all pure app-side plumbing, no live Busy DB access needed for any of it.
  What's left needing a live Busy DB: everything under "Next steps" below
  (Tran3 due-date theory, remaining D/I/B slot decoding, an actual first
  real import against production data), plus (app-side, no live DB needed)
  wiring a real scheduled `POST /busy/import` job and firm/source badges in
  the UI.

## Folio 05 — Stock Journal source/destination, resolved definitively

Earlier note (Folio 00/session summary) said a Stock Journal voucher's item
legs "duplicate exactly" based on `busy-voucher-extractor.js`'s own
`Math.abs(Value1)` reading — which discards the sign. Queried the raw sign
directly against the live DB to settle it properly:

- **`Tran2.Value1`'s sign on a Stock Journal's item legs (`RecType=2`) is
  real and consistent**: `SrNo < 1000` = positive, `SrNo >= 1000` = negative
  — a genuine two-sided split, structurally the same "SrNo offset by 1000"
  convention already used to split ledger vs item legs' srno ranges
  elsewhere in this schema. This is NOT a duplicate-with-abs artifact; the
  sign is a real signal Busy stores.
- **But on EVERY Stock Journal voucher in the full live table (20 of 20,
  not a sample) the two sides carry the identical `MasterCode1` set at
  identical magnitudes** — same stock item, same quantity, opposite sign.
  Net qty and net value both compute to exactly 0 on all 20 vouchers, no
  exceptions (`scratch-check-stock-journal-2.js`, ad hoc query against the
  live DB, not part of the shipped pipeline).
- **Conclusion**: this dealer's Busy setup does not use Stock Journal for a
  genuine material transformation (consuming stock item A to produce a
  different stock item B) — every instance here is a same-item wash that
  cancels to zero regardless of whether the sign is honored or discarded.
  Correctly incorporating the sign changes nothing for this data: honoring
  it nets to 0, and the app's current behavior (excluding Stock Journal
  entirely from `_walk_stock_wac`/`closing_stock_value`) already produces
  the same answer. **This is a confirmed non-issue for this dataset, not an
  open gap** — revisit only if a future sync shows a Stock Journal voucher
  whose two sides carry genuinely different `MasterCode1` sets (would mean
  a real transformation exists somewhere in this company's later data).

## Folio 06 — Sales Order line items: `Tran3`/`RecType=4`, not `Tran2`

Real bug, found via a synced voucher (`SO/26-27/482`) showing "No line-level
detail was synced" in `TallyVoucherDetail.js` despite the user confirming
the order has real line items in Busy's own UI. Folio 02's own "Sales
Order (non-accounting)" framing (line 63) was read as "no line data exists
at all" — that was wrong; it only meant "doesn't post to `Tran2`."

- **Confirmed against the live DB, two real Sales Orders (not a sample of
  one)**: `Tran3` filtered to `RecType=4` holds a Sales Order's line items —
  VchCode 7320 (`SO/26-27/493`) returned 22 lines, VchCode 7381
  (`SO/26-27/499`) returned 5 lines, `Value1(qty) * Value3(rate) ===
  NewRefAmount(line amount)` exact on every sampled row.
- **Column mapping**: `MasterCode1` = stock item (same `Master1`
  `MasterType=6` join as a `Tran2` item leg), `ItemSrNo` = line sequence,
  `Value1` (`=Value2`) = quantity, `Value3` = rate, `NewRefAmount` = line
  amount. `MasterCode2` is a constant-per-voucher party-ledger reference
  (same party the `Tran1` header already carries) — not a UOM, unused.
- **No MRP/discount breakdown exists on this table** — `Tran3` has no
  `D`-prefixed columns at all (unlike `Tran2`'s `D2/D4/D9`). A Sales
  Order's `discount` is always `null`, not an unfetched value.
- **Dead ends checked before landing on `Tran3`**: `Tran7` has no `VchCode`
  column at all (only `MasterCode`). `Tran10` has no `VchCode` column
  either. `Tran12` — despite its row count (7,593) suspiciously close to
  `Tran1`'s total header count (7,336), which looked like a strong lead —
  turned out to be an unrelated tiny print-log table (`VchCode, Date,
  UserName, NoOfCopies`), not order lines.
- **Fixed in `lib/busy-voucher-extractor.js`**: `extractVouchers()` now
  runs a 3rd batch query (`Tran3 WHERE RecType=4 AND VchCode IN (...)`,
  same "one query for the whole batch" shape as the `Tran2` pull) and
  `normalizeVoucher()` builds `lines.items` from those rows whenever the
  voucher has no real `Tran2` item legs (checked via `items.length`, not
  assumed from `vch_type`, so a real Tran2 item leg — if one ever shows up
  for a Sales Order — is never silently dropped). Verified against 5 live
  Sales Orders end-to-end post-fix: 15/5/31/17/1 lines respectively, every
  amount reconciling to `qty * rate`.
- **Re-sync required for already-imported Sales Orders**: any Sales Order
  voucher imported before this fix is sitting in `tally_vouchers` with the
  old empty `lines` — the next `POST /tally/import`/`POST /tally/sync-now`
  for this firm re-pulls and truncate+reloads, so no manual backfill script
  is needed, just a normal re-sync.
- **`rate`/`amount` on a Sales Order line are ex-tax, while Busy's own
  voucher-entry screen shows tax-inclusive figures** — confirmed exact
  against a real voucher (SO/26-27/488, VchCode 7192): our extracted
  `amount`(14,633.28)`×1.18`(9%+9% GST)`=17,267.28` = Busy's own displayed
  line Amount, to the paisa; same for `rate`(2,438.88)`×1.18=2,877.88` =
  Busy's "Price" column. The invoice-level total reconciles the same way
  (`VchSalePurcAmt`=6,14,591.13 ex-tax `×1.18≈7,25,217.63`≈Busy's own Total
  Amount 7,25,218.00, off by a 0.37 round-off line) — not a real value bug,
  just an ex-tax-vs-tax-inclusive display difference. Since a Sales Order
  posts no `Tran2` ledger legs, its GST rate is never itself synced anywhere
  — the voucher detail page/exports now say "Total Value (excl. tax — not
  synced)" instead of "(incl. Tax)" whenever `lines.ledger` is empty
  (`TallyVoucherDetail.js`, `tally_router.py::_voucher_export_shape`
  Excel/PDF), rather than mislabeling an ex-tax figure as tax-inclusive.
- **A Sales Order line's real discount % IS recoverable, exact to the
  paisa, and IS now wired in** — confirmed live: the stock item's own
  current master record (`Master1 WHERE Code=<item> AND MasterType=6`,
  field `D3`) holds today's List Price (3,575.00 for SKU `01210K0ND00`,
  tax-inclusive) exactly matching what Busy's own voucher screen shows;
  backing out `1 − (ex_tax_rate / (D3/1.18)) = 1 − (2438.88 / 3029.66) =
  19.5%` matches Busy's displayed "Disc.: 19.5%" — confirmed not just on
  this one line but across all 5 sampled lines of SO/26-27/488, every one
  landing on exactly `19.5`. **First searched exhaustively for an actual
  configured Scheme/Price-List master before settling on this derivation**
  (per Busy's own "Update Discount"/"Check Scheme" toolbar buttons implying
  one might exist) — `sys.tables` filtered on `%Price%`/`%Scheme%`/`%Disc%`/
  `%Rate%`/`%MRP%` turns up only 3 hits app-wide, and the one that sounds
  closest (`BSItemPriceRange`) has 0 rows; every one of `Master1`'s 35
  distinct `MasterType` values was enumerated and sampled, and none is a
  populated scheme/price-level master (types 30/31, "Compound Discount"/
  "Compound Markup," are just 3-row fixed dropdown-choice lookups, not
  data); the party's own master row carries no assigned price level either
  (every D/B/I field 0). `ItemParamDet` (the most likely place a live
  "Check Scheme" click would persist its result) has 0 rows in this
  install. **Conclusion: no structural scheme/price-list backing exists for
  this dealer's data at all — the 19.5% was manually typed at entry time,
  and `Master1.D3` vs the frozen `Tran3` rate is the only way to recover
  it**, not a fallback chosen over a better source.
  - `Tran3` itself has zero `D`-prefixed columns (confirmed via
    `INFORMATION_SCHEMA.COLUMNS`, unlike `Tran2`'s `D1..D39`) — the
    discount can never come from that table directly, only by comparison
    against the item master.
  - **KNOWN CAVEAT, accepted rather than blocking**: `Master1.D3` is a
    live, MUTABLE master field, not a per-voucher snapshot the way a real
    Tally/`Tran2` line's `D4` is — if an item's list price is edited in
    Busy after a given Sales Order's date, the next re-sync recomputes a
    DIFFERENT discount % for that same old voucher, silently. Accepted
    because a Sales Order is inherently a near-term/still-pending document
    (unlike a settled Tax Invoice), so this drift risk is low in practice
    and re-syncing naturally keeps pace with genuine list-price changes.
  - **Wired in**: `extractVouchers()` runs a 5th batch query (`Master1`
    `D3` for every item referenced by this batch's Sales Order lines) and
    computes `discount` directly on each Sales-Order-sourced item (using
    the already-recovered `taxRatePct` from `VchGSTSumItemWise` to convert
    `D3` down to the matching ex-tax basis) — populating the SAME
    `discount` field every other voucher type's item lines already carry,
    rather than a separate estimate-only field. This means the app's
    EXISTING `_tally_list_rate()`/`tallyListRate()` (which every other
    screen already uses to back out List Price from `rate`+`discount`) now
    automatically shows a real (ex-tax-basis) List Price for these lines
    too, with no separate code path needed — consistent with how a real
    Tally line's List Price is shown. `discount` stays `null` (never a
    guessed 0) only when either `D3` or `taxRatePct` is unavailable for
    that item (e.g. a brand-new item never yet invoiced/master-incomplete).
- **The invoice-level tax-inclusive total IS a real, stored, non-guessed
  fact — `Tran1.VchAmtBaseCur`.** Confirmed exact against the same live
  voucher (VchCode 7192): `VchAmtBaseCur = 725218` matches Busy's own
  displayed "Total Amount - 7,25,218.00" to the rupee — unlike
  `VchSalePurcAmt` (614,591.13, the ex-tax goods subtotal, already used
  elsewhere), this field genuinely carries the tax-inclusive total even for
  a non-accounting voucher type that posts no GST/ledger legs at all.
  `extractVouchers()`'s header query now also selects `t1.VchAmtBaseCur`,
  and `normalizeVoucher()`'s no-ledger-legs fallback tries it FIRST, only
  falling back to `VchSalePurcAmt` if it's ever null — so a Sales Order's
  (or any other non-accounting voucher type's) `amount` field is now the
  real tax-inclusive total, matching Busy's own screen exactly, not an
  ex-tax approximation mislabeled as inclusive.
- **A Sales Order line's own GST% IS recoverable too, from real history —
  `VchGSTSumItemWise`, not a guess.** This table (52,234 rows) records the
  actual filed GST split for every REAL Tax Invoice/Purchase line ever
  posted, keyed by `ItemCode` (not `MasterCode1` — a different column name
  on this table) + `VchDate`. For every item on SO/488, `TaxRate +
  TaxRate1` from that item's own most recent real posting summed to a
  stable 18% (either 9+9 CGST/SGST intra-state or 18+0 IGST inter-state —
  always totaling 18 regardless of split) — confirmed across all 59 lines,
  not just one. Grossing up the ex-tax `rate`/`amount` by this recovered
  rate reproduced Busy's own displayed Price/Amount columns exactly (e.g.
  item 1: `2438.88 × 1.18 = 2877.8784` → Busy shows `2,877.88`; item 2:
  `17011.42 × 1.18 = 20073.48` → Busy shows exactly `20,073.48`).
  **`extractVouchers()` now runs a 4th batch query** (a
  `ROW_NUMBER()`-windowed lookup over `VchGSTSumItemWise`, one row per
  `ItemCode` = its own most recent posting) and attaches 3 extra fields to
  each Sales-Order-sourced item: `taxRatePct` (the recovered rate, `null`
  if this item has never been invoiced in Busy at all — nothing to derive
  from), `amountInclTaxEst`/`rateInclTaxEst` (the grossed-up figures).
  **Deliberately NOT stored as/overwriting the canonical `amount`/`rate`**
  — those stay ex-tax (consistent with every other voucher type's item
  lines and every Insight that sums `items[].amount` as a goods-value
  figure; Sales Order type is never classified `SALES` by
  `_classify_vch_type` — exact native-type match, not a substring guess —
  so nothing elsewhere would even read a Sales Order's item amounts
  either way, but keeping the convention consistent avoided the whole
  question). Surfaced as two EXTRA columns ("Rate (incl. Tax, est.)"/
  "Amount (incl. Tax, est.)") on `TallyVoucherDetail.js`'s Stock Items
  table and its Excel/PDF exports — shown only when at least one item on
  that voucher actually carries an estimate, with an on-page note
  explaining it's a best-effort historical estimate, not a stored fact on
  the Sales Order itself. **Still an estimate, not authoritative**: a
  brand-new item never yet invoiced yields `null` (no gross-up shown), and
  a genuine future GST-rate change on an item would only be picked up once
  that item is actually re-invoiced at the new rate.

## Folio 07 — a second company's VchType codes, confirmed by sampling not assumed

First real multi-company test of this extractor: firm "Firm-B", a genuinely
different real company from the "Firm-A" firm Folios 0-06 were confirmed
against, on a different server (`BUSY2019` SQL Express instance, not
`DEV-MACHINE\SQLEXPRESS01`) but the same generic
`BusyComp0001_db<FY>` database-naming convention (confirms that naming is
Busy's own default, not company-specific). A dry-run extraction against
this company's live `BusyComp0001_db12026` showed 1,130 of 7,602 vouchers
(~15%) with an unmapped `VchType` — far too many to wave through with
`--allow-unknown-types`, since the single largest bucket (808 vouchers,
code 19) turned out to be real cash payments, bigger than this company's
entire Purchase bucket.

**Confirms VchType codes are per-company, not a fixed Busy-wide table**
(see the module docstring's own note above) — this company used 8 codes
(`8,10,13,15,17,18,19,61`) the first company's data never touched at all,
while the first company's own codes `5` (Stock Journal) and `12` (Sales
Order) never appeared here either. Every code below was identified by
sampling real rows (`VchNo` prefix + actual `Tran2` ledger/item legs via
the dry-run's own `output/busy-import-payload.json`), the same method
Folio 0's original 7 codes were confirmed by — never assumed from the
first company's mapping.

- **Code 19 (808 rows, `VchNo` prefix `PC/`)** — Dr an expense ledger
  (`SALARY & WAGES`, `TOUR AJAY EXP A/C`, ...) / Cr `CASH`, real ₹, no
  party resolved. A genuine **Cash/Petty-Cash Payment** series, distinct
  from code 14's bank payments but the same real-world nature — mapped to
  `"Payment"` (same label as 14) so `_classify_vch_type` buckets both
  identically. No `party_name` means these never touch any single party's
  Payables/aging FIFO — correct, since they're direct expense payments,
  not payments to a creditor.
- **Code 10 (19 rows, `VchNo` prefix `DN/`)** — Dr party / Cr `Purchase`,
  real stock item legs. A clean, stock-linked **Debit Note (Purchase
  Return)** — mapped to `"Debit Note"`, matching `_classify_vch_type_ext`'s
  exact-match convention (any vch_type literally named "Debit Note" nets
  as `PURCHASE_RETURN`, regardless of which party it's against — the same
  simplification the first company's own `"Credit Note"`→`SALES_RETURN`
  mapping already relies on).
- **Code 18 (59 rows, blank `VchNo`)** — party leg ↔ a nominal `"DEBIT
  NOTE"` ledger (no stock items at all) — a DIFFERENT Busy voucher type
  than code 10 (no `DN/` numbering, no item legs) that still posts to the
  same real-world-named ledger. Also mapped to `"Debit Note"` — the
  distinguishing detail for the app's classifier is the vch_type NAME
  alone, not the posting shape, so both being genuinely debit-note-natured
  is enough to share the label even though one carries stock detail and
  the other doesn't.
- **Code 17 (40 rows, blank `VchNo`)** — party leg ↔ a nominal `"CREDIT
  NOTE"` ledger, no items. Mapped to `"Credit Note"` by the same reasoning
  as code 18 above.
- **Code 15 (52 rows, blank `VchNo`)** — two BANK ledgers only (`BANK
  PNB(PHONE PAY) A/C` ↔ `PNB NEW A/C(...)`), no party, no items. A genuine
  **Contra** (fund transfer between the company's own accounts) — mapped
  to `"Contra"`, a label neither `_classify_vch_type` nor
  `_classify_vch_type_ext` recognizes, so it's correctly excluded from
  every Sales/Purchase/Receipt/Payment/Return-based figure (a Contra has
  no P&L or Payables/Receivables effect in real accounting either).
- **Code 8 (136 rows, blank `VchNo`)** — item legs only (real quantities,
  `stockGroup`/`itemAlias` populated), zero ledger legs, `amount=0`. Same
  shape as this company's own code 5 (Stock Journal, confirmed Folio 05) —
  mapped to `"Stock Journal"` too, sharing that label with code 5.
- **Left UNMAPPED on purpose — genuinely negligible, not a shortcut**:
  code **61** (14 rows, `VchNo` values like `"SKAS ZERO ITEM"`/`"HERO
  MANNU"`, ZERO ledger legs AND zero item legs AND `amount=0` — a
  non-posting memo/placeholder with no financial or stock effect
  whatsoever) and code **13** (2 rows only, no ledger legs at all, but
  real item-line pricing reconciling to a real total — a non-accounting
  order/quotation-shaped document, the same "priced but never posted"
  nature as the confirmed Sales Order type, just under a different code).
  Both stay `UNKNOWN_61`/`UNKNOWN_13` — since neither ever posts a ledger
  leg, no Insight (Sales/Purchase/Receivables/Payables/Cash-Flow) can be
  affected by leaving them unclassified; 16 vouchers total, immaterial
  either way. Revisit only if a future company's data makes either code's
  volume large enough to matter.
- **Read-only login must be created fresh per SQL Server instance** — a
  server-level SQL login (unlike a database, which restores/attaches with
  its data) never travels between servers; `busy_sync_reader` had to be
  created again from scratch on `BUSY2019` (same recipe as Folio 0:
  `db_datareader` + explicit DENY on every write/DDL verb), confirmed
  working both directions (`SELECT` succeeds, `CREATE TABLE` denied) the
  same way as the original machine.
- **`config.local.json`'s `sqlserver.server` value `.\<INSTANCE>` is a
  SQL-client-tool convention, not something Node's own DNS resolver
  understands** — `sqlcmd`/ODBC tools special-case a bare `.` as
  "localhost", but `tedious`/`mssql` hands the string straight to Node's
  `dns.lookup()`, which has no such special case and fails
  (`getaddrinfo ENOTFOUND .`). Use `localhost\<INSTANCE>` (or the real
  hostname) instead of `.\<INSTANCE>` in `config.local.json` — this is a
  config-value gotcha, not a code bug in `lib/sqlserver-introspect.js`
  (whose own `server.split("\\")` handling was already correct).

## Folio 08 — multi-FY-database sync (opening balances + FY rollup), confirmed live for Firm-A

**Root cause investigated**: Receivables/Payables showed implausible large
negative Outstanding for a big share of parties on the Firm-B firm (53% of
parties in the "Unknown" aging bucket, whole-book total negative) — traced
to `Master1` never carrying an opening balance for a Busy LEDGER (confirmed:
sampled every one of 2,166 real Sundry Debtor/Creditor ledgers' `D1`-`D26`
slots on the live Firm-A database — every single one is 0; Busy just doesn't
store this on the master row the way Tally's `$OpeningBalance` does).

**Real cause: Busy keeps one whole SQL Server database PER FISCAL YEAR**
(confirmed live: `BusyComp0001_db12025`/`_db12026` sit side by side, see
`lib/busy-fy-database.js`) — a party's true running balance as of the
current FY's start only exists as transaction history in the PRIOR year's
own separate database, which the sync never touched. This is the SAME root
cause behind both problems the app asked to fix together: correct opening
balances, and any FY-over-FY/multi-year report (Growth Bridge FY mode,
Budget vs Actual, Sales Performance trend) for a Busy firm — once full
multi-year voucher history is actually synced, neither needs a separate
fix; the FIFO/aging engine (and every date/FY-scoped query) already walks
whatever voucher history it has, exactly like it does for Tally.

**Fixed, `databasePattern` doc bug**: `config.json`'s example/comment said
`"BusyCOMP0001_db1{fyEndYear}"` — backwards. Confirmed live: `db12026`
holds vouchers dated 2026-04-01 onward (the FY it *starts*), so the correct
pattern is `"BusyCOMP0001_db1{fyStartYear}"`. Never actually caused a bad
sync (AUTO mode wasn't enabled anywhere yet), but would have picked the
wrong database the moment it was.

**Built, `lib/busy-fy-database.js::listFiscalYearDatabases()`**: discovers
every sibling FY database via `sys.databases` (a server-scoped catalog
view, confirmed readable by the read-only `busy_sync_reader` login) matched
against `databasePattern`, newest-first. **A name-pattern match alone isn't
trusted** — the un-suffixed `BusyComp0001_db` looked, by name, like a
plausible "oldest, pre-convention FY" database (an earlier version of this
function guessed exactly that) but turned out to be Busy's own shared
application/system database (`Company`, `UserLog`, `GSTFilingStatusDet`,
`Patches`, ... — confirmed via `INFORMATION_SCHEMA.TABLES`, no `Tran1` at
all). Every candidate is now verified to actually have a `Tran1` table
before being included.

**Wired into `import-to-app.js`**: masters (Ledger/Group/Stock Item) still
come from the CURRENT FY database only — a ledger's Parent/category
classification should reflect its current state, and merging same-name
duplicates across years would make the app's own name-keyed grouping
ambiguous about which one "wins". Vouchers are pulled from EVERY verified
sibling FY database and merged into one array (`guid` is already
namespaced per-database, `BUSY-<database>-<VchCode>`, so no collision
risk) — then sent in ONE combined `POST /tally/import`, keeping the
backend's existing per-firm truncate+reload semantics completely unchanged
(no backend code touched). `scheduled-sync.js` needed no changes at all —
it already just calls `runImport({dryRun:false})`.

**Fixed, hardcoded query timeout**: `busy-voucher-extractor.js::connect()`
hardcoded `requestTimeout: 180000` regardless of what a caller passed —
a real problem once a run does several databases' extractions back to back
(one 15,618-voucher FY database's own legs query timed out at 180s in that
context, but completed in ~28s run in isolation — likely connection/
resource contention from back-to-back SQL Server connections on this dev
box, not the query itself being inherently that slow). Now honors
`cfg.requestTimeout`; `import-to-app.js` passes 600000 for the voucher
pull.

**Verified live against Firm-A** (firm_id 2, the only firm with an actually
reachable multi-FY source right now): posted 13,438 masters + 23,159
vouchers (up from 7,541 single-FY) spanning FY2025-26 + FY2026-27.
`total_parties` 193→369 (many more parties have SOME history once a prior
year is included), `total_outstanding` stayed positive and grew sanely
(₹5.89Cr→₹6.47Cr, consistent with more real Sales/Receipt history now
counted), and the count of parties with a real negative Outstanding dropped
to a small residual (22, mostly individual-sounding names like "example individual" — plausibly genuine advances, or this SQL Server instance's own
data simply not going back far enough; **this server only has 2 real FY
databases for Firm-A (`db12025`/`db12026`) — there's no earlier one to chase**,
same accepted "data completeness limit" as Tally's own Books-Beginning-From
boundary).

**Not yet done — Firm-B**: the party this investigation actually started from
(Example Dealer G, firm_id 3) is on Firm-B, whose live Busy
database is NOT this SQL Server instance (confirmed: only the 3
`BusyComp0001_*` databases exist here) and isn't currently reachable at
all — `firms.db_database` is still unset for Firm-B in the app. The mechanism
above is source-agnostic (works against any SQL Server instance once
`config.sqlserver`/`databasePattern` point at it), so applying it to Firm-B is
just a config + access problem once its real server is known, not further
code work. Until then, Firm-B's Receivables/Payables/aging figures remain
understated the same way Firm-A's were before this Folio.

**Update — Firm-B's own source found and reached (same SQL Server instance
layout as Firm-A, different box)**: server `REMOTE-SERVER\BUSY2019`, same 4
database names (`BusyComp0001_db`/`_db12025`/`_db12026`/`COMPINFO`), same
`{fyStartYear}` pattern (`db12025`: 2025-04-01..2026-03-31, `db12026`:
2026-04-01..today) — confirmed via `run.js --list-fy-databases` (the new
CLI command this Folio added specifically so this kind of remote-machine
confirmation doesn't need ad hoc SQL each time). `busy_sync_reader` only
had `db12026` access, same starting point Firm-A had; granted `db_datareader`
on the other 3 the same way.

**A real 3rd company's `VchType` 13, confirmed distinct from Folio 07's
own company-2 code 13**: `import-to-app.js --dry-run` on Firm-B's merged
payload flagged 23 `UNKNOWN_` vouchers (14× code 61, 9× code 13). Code 61
matches the already-confirmed harmless "SKAS ZERO ITEM" stub pattern
(₹0, no party, no lines) — same as before. **Code 13 here is NOT the
same as Folio 07's own code 13** (which posted nothing at all for that
other company) — Firm-B's version carries real party/item/amount data
(₹6,28,275 across 2 vouchers in `db12026`, ₹10,84,589 across 7 in
`db12025`). Confirmed live (both FY databases, all 9 vouchers): zero
`Tran2` `RecType=1` ledger legs on every one — same non-accounting,
`Tran3`-only shape as code 12 (Sales Order), just a different VchNo
series ("2" instead of "SO/26-27/.."), so it can't be silently affecting
Sales/Purchase/Receivables/Payables the way a real posting voucher could.
Added to `VCH_TYPE_MAP` as `"Sales Order"` (behaviorally, not asserting
that's its real on-screen name in Busy) — reconfirms Folio 07's own
standing warning that a `VchType` code's meaning is never safe to assume
company-to-company, even when the number matches one already seen.

## Folio 09 — `Folio1`: the real opening-balance table, found after `Master1` genuinely has none

**Every ledger opening balance search up to this point (Folio 08 and
earlier) was scoped to `Master1` alone** — its `D1`-`D26`/`CM1`-`CM11`/
`L1`-`L2`/`M1`-`M2`/`TPF1`-`TPF2`/`I*`/`B*` columns were checked
exhaustively, confirmed genuinely all zero for every real ledger sampled.
That conclusion was correct as far as it went — `Master1` really doesn't
carry it. The miss was scope: nobody had listed **every table** in the
live database fresh; the working table set (`Master1`/`Tran1`/`Tran2`/
`Tran3`/`VchGSTSumItemWise`) was inherited from earlier Folios' own
investigation of a different table's shape, never re-verified complete
for this question.

**`dbo.Folio1`** (`MasterCode int, MasterType smallint, D1..D150 float,
B1..B12 bit`) is a **separate one-row-per-master table**, joined
`Folio1.MasterCode = Master1.Code`. For `MasterType=2` (Ledger),
**`Folio1.D1` is the real opening balance** — confirmed by cross-checking
ALL 189 nonzero rows of a real "List of Accounts" Excel export (Firm-A /
EXAMPLE DISTRIBUTORS) against `Folio1.D1` pulled live: **0 mismatches, 0
missing**, not a single-sample spot-check. Sign convention (opposite of
this app's own `dr_positive` convention, so flipped at extraction time —
see `busy-voucher-extractor.js::extractMasters()`):

```
D1 < 0  → Debit opening balance,  OpeningBalance=ABS(D1), IsDebit="Yes"
D1 > 0  → Credit opening balance, OpeningBalance=D1,      IsDebit="No"
D1 = 0  → genuinely zero (LEFT JOIN required — a master with no Folio1
          row, or D1=0, must still come through as OpeningBalance="0",
          never be dropped; confirmed via "Example Dealer B", Code 11228, D1=0)
```

**Opening balance is a genesis value, not carried forward year to year**
— confirmed live: this dealer's own Folio1.D1 for "Example Dealer A"
(Code 11870) is `-1716453.34` in `db12025` (the FY it was hand-typed in,
1-April-2025) but `0.0` in `db12026` (this dealer hasn't rolled it
forward). Since this app's multi-FY sync (Folio 08) already merges every
synced year's vouchers into one continuous history, the OpeningBalance
attached to the merged result must be read from the **oldest** synced FY
database specifically, not whichever one is "current" — `extractMasters()`
now takes an optional `openingBalanceDatabase`, cross-database-joining
`[OtherDb].dbo.Folio1` (same SQL Server instance, both databases) while
every other master field still comes from the current database as before;
`import-to-app.js` passes the oldest entry of `listFiscalYearDatabases()`'s
own result. Verified end-to-end through the real sync (not a manual DB
patch): posted for Firm-A, Example Dealer A's Outstanding came out
₹51,89,502.34 — matching the hand-computed expectation (raw voucher
movement ₹34,73,049 + opening balance ₹17,16,453.34) to within rounding.

**Only `D1` is confirmed.** The sampled `Folio1` row for this same ledger
also carries plenty of other nonzero `D` fields (`D12`, `D13`, `D14`...) —
`Folio1` is clearly doing more than storing one opening balance. **Do not
assume any other `D` column's meaning** (including `D4`, which happened to
equal `D1` on every tested record but was never independently confirmed —
do not use it) until independently verified the same way D1 was: sampled
against a real Busy report, not guessed from a coincidental match.

**Process lesson, the actual reason this took as long as it did**: an
automated whole-database blind value search (every numeric column of
every table, built via dynamic SQL) was tried BEFORE finding `Folio1` by
hand, and it reported zero matches — which was trusted as "the value
truly isn't in this database" rather than treated as a claim needing its
own verification. The real bug: `CAST(@target AS NVARCHAR(50))` on a
`FLOAT` silently produces SQL Server's low-precision scientific-notation
string (e.g. `1.71645e+006`, ~6 significant digits) instead of a proper
decimal string — both the lower and upper bound of a `BETWEEN` range
collapsed to the SAME rounded value, turning an intended ±0.01 tolerance
into a single useless point off by more than 3 from the real number. The
query ran with no error and no output, which reads exactly like "genuinely
not found" — indistinguishable from it unless the search methodology is
itself sanity-checked against a value already known to be present. **Any
future blind/automated value search must first prove it can find a planted
known-good match before trusting a "no matches" result** — and should
build numeric range bounds via `CONVERT(NVARCHAR(50), @val, 2)` or
`STR(@val, 20, 2)`, never a bare `CAST(float AS NVARCHAR)`.

**Standing rule going forward, since this schema keeps growing as the app
does**: every newly-confirmed table/column here should get the same
treatment this Folio does — the exact confirmed mapping, the evidence it
was checked against (not just one sample), the sign/join convention, and
what's still unconfirmed and must not be assumed. `Folio1.D2`-`D150` and
`B1`-`B12` remain open — reverse-engineer them the same way, one
confirmed field at a time, against real Busy reports.

## Folio 10 — `Folio1.D1`/`D3` are also a Stock Item's opening qty/value (bug: opening stock never synced from Busy)

**Symptom that led here**: BookSync's Opening Balances page showed "Items
with Opening Qty: 0", "Opening Qty (Sum): 0", "Opening Stock Value (Sum):
0.00" for a Firm-A (Busy-sourced) firm, even though this dealer's real Busy
data clearly has opening stock on many items. Root cause: `extractMasters()`
only ever set `fields.OpeningBalance`/`OpeningBalanceIsDebit` for
`MasterType===2` (Ledger) — there was no equivalent branch for
`MasterType===6` (Stock Item) at all, so every synced STOCK_ITEM master's
`fields` carried no opening qty/rate whatsoever, and the downstream parsers
(`tally_router.py::_parse_tally_stock_qty`/`_parse_tally_stock_rate`,
`tally_financial_statements.py`'s own mirrored copies) correctly returned
`None` for a field that was never there.

**Confirmed**: `Folio1.D1` (same column already confirmed as a Ledger's own
opening balance in Folio 09) is ALSO a Stock Item's opening qty, and
`Folio1.D3` is its opening value — `D2` also equals `D1` on every sampled
item (redundant secondary-unit qty, presumably — not used). Confirmed two
ways, not guessed:

1. **Single real item, cross-checked against Busy's own Item Master
   screen** (user-supplied screenshot for `44820KTE911`: "Op. Stock (Qty.)"
   `-577`, "Op. Stock (Value)" `-19,305.92`). In the CURRENT FY database
   (db12026) this item's Folio1 row is all-zero on D1-D9 — same "genesis
   value, not carried forward year to year" behavior Folio 09 already
   confirmed for Ledgers. In the OLDEST synced FY database (db12025, the FY
   this item was created in), `Folio1.D1 = D2 = -577` and `Folio1.D3 =
   -19305.92` — exact match, both figures, including sign (unlike the
   Ledger case, NO sign flip is needed: D1/D3 already carry the same sign
   Busy's own screen displays).
2. **Whole-dataset reconciliation, not just one row**: `SUM(Folio1.D3)`
   across all 10,823 Stock Item rows in the oldest FY database =
   `20,060,548.89`. The "Stock" ledger (Parent: "Stock-in-hand", the real
   book-value control account) in that SAME database has `Folio1.D1 =
   -20,060,548.89` — matches to the cent (D1<0 on a Ledger = Debit,
   confirmed sign convention from Folio 09; Stock is naturally a Debit/asset
   balance, consistent).

**Fix** (`lib/busy-voucher-extractor.js::extractMasters()`): added a
`MasterType===6` (Stock Item) branch alongside the existing Ledger one,
reading the same `f.D1`/newly-selected `f.D3` columns (the query already
LEFT JOINs `Folio1` for every master type, just wasn't selecting D3 or doing
anything with it for a Stock Item) — writes `fields.OpeningBalance =
String(qty)` and `fields.OpeningRate = String(value/qty)` (omitted when
qty=0, matching how a Tally-sourced item with no cost basis leaves
`OpeningRate` unset). Deliberately encoded as qty/rate TEXT, not a plain
number, to match the exact shape `tally_sync.py`'s own STOCK_ITEM
`OpeningBalance`/`OpeningRate` fields carry (see the "StockItem opening qty
always blank" bullet earlier in this doc) — `_parse_tally_stock_qty`/
`_parse_tally_stock_rate` only ever read the leading numeric token, so no
real unit suffix is required; this extractor still doesn't resolve Busy's
own Unit master (see the module docstring's `unit` caveat), unchanged.
Reuses the SAME `openingBalanceDatabase` (oldest-FY-database) join
`import-to-app.js` already passes for the Ledger case — no caller change
needed, a plain resync (`POST /tally/sync-now` or the next `import-to-app.js`
run) picks this up.

**Still unconfirmed**: `D2`'s exact meaning (equals D1 on every sample so
far, not independently verified as something different) and every other
`Folio1.D` column for a Stock Item beyond D1/D3.

## Folio 11 — Folio1's real key is (MasterCode, MasterType), not MasterCode alone — a cross-type/cross-database Code collision was silently corrupting opening balances

**Symptom that led here**: after Folio 10's fix landed, a user-supplied real
Busy report (`Firm-A DATA/Sundry Clsing 31-3-25.xlsx` — Busy's own "Group
Balances" printout, Sundry Debtors, at the end of 31-03-2026: Total Debit
22,032,827.08, Total Credit 2,003,076.00, Balance 2,00,29,751.08 Dr) didn't
match the app's own Balance Sheet Sundry Debtors total for the same date
(2,00,31,548.08) — a ₹1,797.00 gap. A full per-ledger reconciliation (every
row from both sides, summed by exact name — not naively deduped in a
Python `dict`, which would have silently hidden a real same-name collision
on either side, see the "verify before trusting" lesson this doc already
carries) surfaced TWO separate, real bugs, not one:

**Bug 1 — `_ledger_masters()` (`tally_financial_statements.py`) emitted one
leaf per RAW ledger-master name, but `_scan_ledger_movements()` aggregates
every voucher leg by NORMALIZED name** (`_normalize()`: lowercase + collapse
whitespace) since a voucher leg only carries a ledgerName STRING, never a
master Code. Busy's live data has several genuine near-duplicate Ledger
masters for the same real-world party (an accidental extra internal space,
e.g. "Example Party D" vs "Example Party D (double-spaced variant)") — both raw names
share ONE normalized-movement bucket, so both leaves independently emitted
the SAME (already-combined) total: a straight double-count. Fixed by
merging `_ledger_masters()`'s output by normalized name (summing their
`opening_raw`, keeping the first-seen `opening_is_debit`/`parent`) —
touches all 3 callers (`real_stock_ledger_value`, `build_balance_sheet`,
`build_profit_and_loss`) at the one shared source. This alone only closed
part of the gap (and, on its own, briefly made the Sundry Debtors total
go the OTHER way, ₹7,173 under Busy's figure) — Bug 2 explains the rest.

**Bug 2 — the `openingBalanceDatabase` cross-database Folio1 join
(`extractMasters()`, added in Folio 10 and reused from the pre-existing
Ledger opening-balance logic) joined on `Code` ALONE, but `Code` is only
unique together with `MasterType`.** Confirmed live, the actual root cause
of the largest single error found: Ledger "Example Dealer C"
(Code 14324, created 2026-04-04 — genuinely zero activity before that
date, confirmed via its only 2 synced vouchers, both dated July 2026) was
silently attributed an "opening balance" of `D1=-4870`/`D3=-830696.02`
pulled from the OLDEST synced FY database's (db12025) OWN Code 14324 —
which in THAT database is a completely unrelated `MasterType=5` (Stock
Group) named "Others". `Code` numbers are allocated independently per
database once two sibling FY databases diverge (each keeps assigning new
Codes to whatever's created in IT from its own rollover point onward, with
no reservation against the other database's own future Codes) — so a Code
freshly created in the CURRENT database can, and did, numerically collide
with an unrelated, pre-existing master of a DIFFERENT type in the OLDER
database used for opening-balance lookup. Fixed with the minimal correct
join: `ON f.MasterCode = m.Code AND f.MasterType = m.MasterType`, restoring
Folio1's true composite key instead of treating `MasterCode` as unique on
its own. (A same-TYPE Code collision across sibling databases — e.g. two
unrelated Ledgers sharing a Code — remains a theoretical residual risk this
doesn't fully rule out; not observed in practice so far.)

**Net result, verified against the real Busy report after both fixes**:
Sundry Debtors total 2,00,27,274.08 vs Busy's 2,00,29,751.08 — a remaining
₹2,477.00 gap, fully traced to one further case (party "Example Party E" per Busy's historical printout) whose CURRENT ledger name no
longer contains that string at all — a genuine full rename this
name-string-based matching architecture has no way to chase without a
stable cross-database Code mapping (out of scope here; not a bug, a known
limitation of the whole "match ledgers by name" design already documented
elsewhere in this file and in CLAUDE.md's Tally Mode section).

**Process lesson**: a `dict`-keyed-by-name comparison between "our" data
and a reference report is NOT safe when either side could genuinely
contain more than one row under related-but-not-identical names — the
FIRST version of this reconciliation used exactly that shortcut on both
sides, which both hid a real Busy-side double row (two literal "Example Individual F"-normalized ledgers, 1000 + 935 = 1935, matching this app's own
correctly-merged 1935 single row) and produced a misleadingly small
"only in ours"/"only in busy" diff. Always aggregate (sum) by key on BOTH
sides before diffing two datasets for reconciliation, never assume
uniqueness — same standing rule as this doc's "verify a SQL search can
find a known match before trusting a negative result," just applied to a
Python-side reconciliation instead of a SQL one.
