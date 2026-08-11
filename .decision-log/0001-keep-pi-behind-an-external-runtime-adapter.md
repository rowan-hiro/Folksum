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
