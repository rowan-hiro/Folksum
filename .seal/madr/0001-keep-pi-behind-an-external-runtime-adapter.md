# 1. Keep Pi behind an external runtime adapter

Date: 2026-08-11

## Status

Accepted

## Context and Problem Statement

The finance product needs Pi agent-loop capabilities without coupling its domain, policy, channels, or persistence to the Pi repository or coding-agent extension model.

## Decision Drivers

* Not recorded.

## Considered Options

* Independent application with Pi packages as replaceable dependencies
* Pi extension or in-tree Pi package

## Decision Outcome

Build Finance Agent App as an independent application. Depend on published pi-agent-core and pi-ai packages through a narrow runtime adapter; never place finance code in, fork, or modify the Pi checkout.

## Consequences

* Finance IR, confirmation, identity, memory, scheduling, channels, and financial persistence remain application-owned and testable without an LLM.
* Pi upgrades are isolated to the runtime adapter.

## Decision History

<!-- driftseal-reconciliation: b5b54c11-9183-417c-bb8c-d25e5cd60d09 -->
### 2026-08-11T15:05:12.968Z — Intent `2026-08-11-008`

Status: Accepted → Accepted

Finance IR execution and durable confirmation were implemented entirely under src/app and depend only on application-owned core services; the Pi boundary remains unchanged and will be added later under a dedicated runtime adapter.

<!-- driftseal-reconciliation: 36f77e05-6ee3-4a14-bfc7-5474a64778b0 -->
### 2026-08-11T15:07:46.435Z — Intent `2026-08-11-009`

Status: Accepted → Accepted

Identity, sessions, transcripts, and structured memory rules were implemented as application-owned SQLite services with no Pi types or imports, preserving the external runtime boundary.

<!-- driftseal-reconciliation: cb468eaa-85f4-4850-9a9c-f003784769fd -->
### 2026-08-11T15:09:18.500Z — Intent `2026-08-11-010`

Status: Accepted → Accepted

Reminder scheduling and the notification outbox are deterministic application services and have no dependency on Pi or an LLM; channel delivery remains outside the runtime adapter.

<!-- driftseal-reconciliation: b1415314-86cc-4951-ae7a-010942b3f4cd -->
### 2026-08-11T15:12:28.096Z — Intent `2026-08-11-011`

Status: Accepted → Accepted

package.json now declares exact published Pi package versions and contains no local checkout reference. Installation could not be verified because npm registry access hung in the restricted environment; the dependency boundary remains accepted.

<!-- driftseal-reconciliation: 07230d01-d476-4a35-8511-67d9b81cfe13 -->
### 2026-08-11T15:15:37.879Z — Intent `2026-08-11-012`

Status: Accepted → Accepted

The completed adapter imports only published @earendil-works Pi packages under src/runtime/pi. CLI calls the adapter, finance tools submit Finance IR through FinanceApplication, and the local pi checkout is ignored and never imported.

<!-- driftseal-reconciliation: 15de75df-5cc3-468a-b544-fd5471b5c069 -->
### 2026-08-11T15:19:56.760Z — Intent `2026-08-11-013`

Status: Accepted → Accepted

Confirmed the external Pi boundary after installing and locking the published 0.84.1 packages; strict typechecking and all 26 tests pass, and Pi imports remain isolated under src/runtime/pi.

<!-- driftseal-reconciliation: e540fbc4-638f-44b8-bf14-da01855b82fe -->
### 2026-08-12T08:48:41.866Z — Intent `2026-08-12-012`

Status: Accepted → Accepted

Confirmed for the release package: TypeScript emits only Home Wealth Agent code, bare published @earendil-works/pi-* imports remain external, npm installs exact Pi runtime dependencies, and package verification rejects bundled or vendored Pi contents.

<!-- driftseal-reconciliation: d80f5177-ae86-4f90-8309-76bc1ae1b8c6 -->
### 2026-08-12T13:50:54.957Z — Intent `2026-08-12-018`

Status: Accepted → Accepted

Confirmed while adding bookkeeping profile tools: Pi exposes only typed finance/profile tools through src/runtime/pi, while validation, revision checks, confirmation, and persistence remain application-owned with no Pi types in the profile service.

<!-- driftseal-reconciliation: 46e0685b-7d3a-4567-94c0-f0c3cde05918 -->
### 2026-08-12T13:55:29.340Z — Intent `2026-08-12-019`

Status: Accepted → Accepted

Confirmed while connecting profiles to transaction recording: Pi still submits typed Finance IR only; deterministic category resolution, custom-field validation, idempotency, atomic ledger metadata persistence, and reversals are application/core responsibilities.

<!-- driftseal-reconciliation: f29b3f29-e2a6-4405-a502-5168c9a7695e -->
### 2026-08-12T14:00:34.907Z — Intent `2026-08-12-020`

Status: Accepted → Accepted

Confirmed for export previews: Pi can request only a typed read-only Finance IR operation, while deterministic projection, filtering, exact amount formatting, and code-free rendering remain in an application service.

<!-- driftseal-reconciliation: 3f8e2334-d74a-47db-8a37-2bba6f1189fc -->
### 2026-08-12T14:13:58.539Z — Intent `2026-08-12-023`

Status: Accepted → Accepted

Confirmed during final hardening: profile edits and export previews remain typed Finance IR operations, while transaction-only field validation, revision/hash/reference enforcement, preview byte bounds, and CSV safety stay in application/core code outside Pi.
