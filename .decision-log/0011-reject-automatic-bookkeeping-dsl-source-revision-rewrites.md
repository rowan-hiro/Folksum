# 11. Reject automatic bookkeeping DSL source revision rewrites

Date: 2026-08-14

## Status

Rejected

## Context and Problem Statement

After profile apply-dsl activates a new immutable SQLite revision, the external .folksum document still contains the prior expected-revision value. Automatically rewriting that private source was considered as a convenience, but SQLite activation and filesystem replacement cannot participate in one atomic transaction, and the file may be edited concurrently outside Folksum.

## Decision Drivers

* Preserve the boundary between the application-owned SQLite transaction and user-owned external source files
* Avoid data loss from non-atomic compare-and-replace behavior across independent persistence systems

## Considered Options

* Rewrite expected-revision automatically after successful activation
* Return expectedRevision and require an explicit user edit

## Decision Outcome

Reject automatic source rewrites. apply-dsl returns the next expectedRevision and never edits the supplied .folksum file; the user updates the directive explicitly after activation. This keeps SQLite as the runtime source of truth and avoids silently overwriting concurrent external edits.

## Consequences

* A successful apply leaves the source intentionally stale until the user updates it
* The CLI cannot silently replace comments, formatting, permissions, or concurrent edits in the private file
