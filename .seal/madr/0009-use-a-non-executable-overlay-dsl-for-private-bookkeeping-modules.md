# 9. Use a non-executable overlay DSL for private bookkeeping modules

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

Household-specific categories, participant fields, merchant rules, account bindings, and export layouts must remain outside the public repository, while the reusable language and validation path should be public. Raw JSON full-profile snapshots are precise but cumbersome to author and tend to copy defaults into private configuration.

## Decision Drivers

* Keep household names, merchants, account identifiers, and export preferences out of the public repository.
* Preserve one application-owned validation and activation boundary for files, agents, and the CLI.
* Make customization readable in code review and practical for an agent to edit.

## Considered Options

* Continue using complete revision-aware JSON profile documents only.
* Load executable TypeScript or JavaScript household plugins.
* Compile a constrained text overlay into the existing profile patch model.

## Decision Outcome

Folksum provides a line-oriented, revision-aware bookkeeping DSL whose declarations compile into the existing semantic profile patch model. DSL files remain external and private; the public parser accepts only allow-listed declarations, performs no includes or interpolation, and activates compiled profiles only through the existing validator and optimistic revision check.

## Consequences

* A private module can contain only its delta from the built-in profile and can be checked before activation.
* The DSL cannot express behavior beyond the public semantic model; new generic needs require an explicit language and validator change.
* The first DSL version supports categories, transaction fields, deterministic description rules, and declarative exports without filesystem includes, environment interpolation, SQL, templates, or code execution.
