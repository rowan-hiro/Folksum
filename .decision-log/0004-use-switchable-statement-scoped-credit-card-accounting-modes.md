# 4. Use switchable statement-scoped credit-card accounting modes

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

Users need both lightweight aggregate statement reminders and fully integrated card ledger accounting. A mutable global mode alone would let an existing statement change repayment semantics after a settings update, while retroactively converting aggregate statements into postings would require information the application does not have.

## Decision Drivers

* Let households choose their preferred bookkeeping depth
* Keep lightweight card reminders independent from incomplete daily records
* Preserve deterministic historical and pending-statement semantics across settings changes
* Prevent statement totals and card ledger balances from being double counted

## Considered Options

* Support only lightweight mode and defer integrated behavior
* Apply one mutable global mode retroactively to every open statement
* Snapshot the selected mode on each statement while using a global default for new activity

## Decision Outcome

Persist a local-only cardTrackingMode setting with lightweight as the default and integrated as the alternative. The setting controls new credit-card activity, and every statement snapshots its accounting mode at creation. Lightweight repayments create standalone allocations without ledger mutations; integrated repayments create atomic ledger transactions and allocations. Switching mode never rewrites existing statements or historical ledger entries. The TUI, JSON file, and environment override may select the mode, but the LLM runtime-settings tool may not change it.

## Consequences

* Existing statements keep stable repayment semantics after a settings change
* Legacy statements migrate as lightweight because historical statement totals may not have matching card-purchase postings; existing allocations are copied into standalone payment records while their ledger transactions remain unchanged
* Standalone obligations remain outside spending and net-worth totals and must be labeled separately
* A future reconciliation workflow must be explicit; aggregate statement totals are never converted into inferred postings

## Decision History

<!-- driftseal-reconciliation: 9106c032-7f12-41d0-9575-b064602284b5 -->
### 2026-08-12T07:27:11.630Z — Intent `2026-08-12-011`

Status: Accepted → Accepted

Confirmed after implementation and migration tests: statements retain immutable mode snapshots; v6 statements migrate as lightweight with allocations copied while historical ledger transactions remain unchanged.
