# 10. Keep bookkeeping DSL primitives declarative in the semantic profile IR

Date: 2026-08-14

## Status

Accepted

## Context and Problem Statement

Household overlays need amount bounds, per-person thresholds, boolean match composition, capture shortcuts, posting-role export amounts, allowlisted date/literal/BOM columns, and rule explanations. These must not become executable profile code, a second runtime source of truth, or ledger-schema changes, and they must preserve exact-money and revision hashing for existing formatVersion 1 documents.

## Decision Drivers

* Preserve exact-money, currency, reversal, and Finance IR invariants
* Keep file apply and agent patch on one validator and activation path
* Leave household merchants, prices, and shortcut values out of folksum/default@1

## Considered Options

* Embed a text .folksum compiler and executable match language in the public runtime
* Store amount thresholds as currency-scaled minor units in the profile document
* Put shortcuts in memory rules and persist match explanations on ledger rows

## Decision Outcome

Extend the versioned JSON semantic profile IR additively. Rule matches are a capped predicate AST beside the legacy descriptionContains leaf. Amount bounds stay decimal strings and convert with the transaction currency at match time; per-person compares by multiplying threshold minor units by an explicit participant count. Capture shortcuts live in the profile, not memory rules, and expand into structured capture input before classification. Export gains allowlisted posting roles, literal columns, date formats, and an optional UTF-8 BOM. Match explanations are a read of the current profile and are not stored on posted transactions.

## Consequences

* Existing descriptionContains rules and stored profile hashes remain valid because new collections and optional keys are omitted when unused
* Agent tools and JSON profile apply can express the overlay backlog primitives before a text DSL compiler exists
* A later .folksum compiler can target this IR without a second execution engine
