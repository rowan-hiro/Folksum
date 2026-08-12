# 3. Defer integrated credit-card ledger accounting

Date: 2026-08-12

## Status

Superseded

## Context and Problem Statement

Credit-card support can either bind each purchase and repayment to ledger postings, or track statement totals, due dates, repayments, and reminders as a standalone obligation. The first model provides full reconciliation but requires complete and correctly categorized daily activity; the second delivers useful repayment tracking without that coupling.

## Decision Drivers

* Make credit-card reminders useful without requiring complete daily bookkeeping
* Reduce initial data-entry burden and reconciliation complexity
* Keep the first implementation understandable when statement totals and daily records differ

## Considered Options

* Integrated mode: post each card purchase to a card liability account and link statement repayments to ledger transactions
* Lightweight mode: maintain aggregate statement obligations and reminders independently of daily bookkeeping

## Decision Outcome

Implement standalone credit-card statement tracking first. Statement amount, minimum payment, due date, recorded repayments, outstanding amount, and reminder status are authoritative only within the card-statement module and are not derived from or reconciled against daily ledger transactions. Defer purchase-level and repayment-level ledger integration until users need unified card balances or transaction reconciliation, or reliable card-import data and a migration plan are available.

## Consequences

* Users can track what is due even when they do not record every card purchase
* Daily spending reports and card-statement outstanding amounts may differ and the product must label them as independent views
* Net-worth and balance reports must not silently combine standalone statement totals with any card liability ledger balance, which would risk double counting
* Adding integrated mode later requires an explicit reconciliation and migration design rather than retroactively inferring postings from aggregate statements

## Decision History

<!-- driftseal-reconciliation: f2c4d8b7-491b-4eda-ba82-e88adb14b364 -->
### 2026-08-12T06:54:31.365Z — Intent `2026-08-12-010`

Status: Deferred → Superseded

Superseded by decision 0004: lightweight remains the default, but integrated mode is now implemented as an explicit local-only option with statement-scoped mode snapshots instead of being wholly deferred.
