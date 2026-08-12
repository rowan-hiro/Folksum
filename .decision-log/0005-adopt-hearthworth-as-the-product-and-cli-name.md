# 5. Adopt HearthWorth as the product and CLI name

Date: 2026-08-12

## Status

Superseded

## Context and Problem Statement

The descriptive Home Wealth Agent name is not distinctive enough for a user-facing product. Kinsum was preferred for its short family-plus-accounting meaning but kinsum.app is already in use, creating avoidable brand and search ambiguity.

## Decision Drivers

* Use a memorable name that still signals household finances and net worth
* Keep the npm package and terminal command easy to spell
* Avoid an active product name collision before the first release

## Considered Options

* Keep Home Wealth Agent as a descriptive project name
* Use Kinsum despite the existing kinsum.app product
* Adopt HearthWorth and retain stable configuration interfaces

## Decision Outcome

Use HearthWorth for the product, npm package, and installed CLI. Preserve the existing HWM_* environment-variable contract and legacy credential directory for compatibility rather than coupling a brand rename to a data migration.

## Consequences

* User-facing titles, package metadata, documentation, and release verification use HearthWorth and the hearthworth command
* Existing HWM_* scripts and ~/.home-wealth-manager/auth.json credentials continue to work

## Decision History

<!-- driftseal-reconciliation: a62321ab-1b15-441c-a116-4772245c369e -->
### 2026-08-12T09:42:43.812Z — Intent `2026-08-12-014`

Status: Accepted → Superseded

Superseded by decision 0006 before the first release: the user selected Folksum, rejected the HearthWorth/HW identity, and explicitly chose a clean break with FOLKSUM_* configuration and ~/.folksum/auth.json instead of compatibility aliases.
