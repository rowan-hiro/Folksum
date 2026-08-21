# 7. Keep bookkeeping customization semantic and revisioned

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

Folksum needs a built-in bookkeeping schema that households can customize through files or agent conversation without allowing user definitions to weaken double-entry, exact-money, currency, reversal, or Finance IR invariants. File edits and agent changes must not become competing runtime sources of truth.

## Decision Drivers

* Preserve the fixed accounting and Finance IR safety boundary.
* Give file imports and conversational edits identical validation and concurrency behavior.
* Keep historical configuration auditable and rollback-friendly.

## Considered Options

* Allow household code or migrations to alter the physical SQLite schema.
* Treat editable profile files as a second live runtime source alongside SQLite.
* Validate a semantic profile and activate immutable full snapshots in SQLite through one application service.

## Decision Outcome

Bookkeeping customization is a versioned semantic profile extending a pinned built-in default. SQLite stores immutable normalized revisions and the active pointer; files are validated import/export documents, and agent tools call the same application service. Physical ledger schema and accounting invariants remain application-owned.

## Consequences

* Custom categories, typed fields, rules, and export definitions can evolve without dynamic tables or arbitrary code.
* Every update can use optimistic revision checks and retain author/source provenance.
* File changes require an explicit application path before becoming active.

## Decision History

<!-- driftseal-reconciliation: ffbd5c27-dd8c-4104-ae80-27e153a36666 -->
### 2026-08-12T13:50:55.002Z — Intent `2026-08-12-018`

Status: Accepted → Accepted

Confirmed after the first conversational editing path: get/update tools read and patch the same immutable SQLite-backed semantic profile through FinanceApplication, with optimistic revision checks and application-owned confirmation.

<!-- driftseal-reconciliation: 0918f9e7-74a1-4a2d-a376-2a504213da6b -->
### 2026-08-12T13:55:29.381Z — Intent `2026-08-12-019`

Status: Accepted → Accepted

Confirmed with ledger integration: each categorized expense or income snapshots the active semantic profile hash/revision and resolved category/rule/fields atomically, while later profile revisions do not reinterpret idempotent retries or reversals.

<!-- driftseal-reconciliation: 19c1f583-e982-46c5-9876-d3dbfd9e0de4 -->
### 2026-08-12T14:00:34.864Z — Intent `2026-08-12-020`

Status: Accepted → Accepted

Confirmed after export implementation: export definitions live in the same validated immutable semantic profile revision and permit only an allowlisted declarative projection DSL, never SQL, JavaScript, templates, or filesystem authority.

<!-- driftseal-reconciliation: ec4eb734-44b0-493a-b968-246fb11be544 -->
### 2026-08-12T14:03:20.849Z — Intent `2026-08-12-021`

Status: Accepted → Accepted

Confirmed with the file and CLI path: editable documents carry expectedRevision, profile apply uses the same validator and activation service as agent updates, active SQLite revisions remain authoritative, and only explicit local CLI commands receive filesystem write authority.

<!-- driftseal-reconciliation: 17effd8b-a4e5-4dc4-9c34-fe281ae66b39 -->
### 2026-08-12T14:06:10.494Z — Intent `2026-08-12-022`

Status: Accepted → Accepted

Confirmed in migration and user documentation: schema version 8 owns immutable semantic profile and transaction metadata storage, editable files remain revision-aware transport, and the planned physical ledger-integrity migration is explicitly renumbered to version 9.

<!-- driftseal-reconciliation: 56b21a1c-2710-439c-8aa2-ceea24f474a0 -->
### 2026-08-12T14:13:58.583Z — Intent `2026-08-12-023`

Status: Accepted → Accepted

Confirmed after final hardening: profile activation performs validation and optimistic revision checks under one immediate SQLite transaction, stored hashes and account/profile references are verified, custom fields are limited to the implemented transaction scope, and preview/file outputs remain bounded declarative projections.

<!-- driftseal-reconciliation: e3763398-fc7e-43ba-97c4-fc33ad529d0b -->
### 2026-08-12T15:33:04.072Z — Intent `2026-08-12-025`

Status: Accepted → Accepted

Confirmed after adding the public bookkeeping DSL: private text overlays compile into the existing semantic profile patch, validation, immutable revision, and optimistic concurrency path; no executable extension point or second runtime source of truth was introduced.

<!-- driftseal-reconciliation: d09d5753-7748-434e-a068-93ac8d30dd21 -->
### 2026-08-13T12:40:01.168Z — Intent `2026-08-13-002`

Status: Accepted → Accepted

Confirmed after merging the Telegram alpha with the bookkeeping DSL branch: schema version 9 stores channel update receipts without changing semantic profile or ledger invariants, and the deferred physical ledger-integrity migration is renumbered to version 10.
