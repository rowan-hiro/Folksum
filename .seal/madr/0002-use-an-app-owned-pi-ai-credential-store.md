# 2. Use an app-owned pi-ai credential store

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

The TUI needs API-key and OAuth persistence for several Pi providers without coupling the finance application to a coding-agent implementation or a private vendor token format.

## Decision Drivers

* Not recorded.

## Considered Options

* Import Pi Coding Agent's non-public AuthStorage implementation.
* Parse and reuse Codex's private auth.json schema.
* Support environment credentials only, without local login persistence.

## Decision Outcome

Persist the public pi-ai Record<providerId, Credential> contract in a private user-scoped auth.json and let pi-ai own provider login, OAuth refresh, and auth resolution. Keep credentials separate from application config, SQLite sessions, and model tools.

## Consequences

* The store requires app-owned atomic writes, locking, permission enforcement, schema validation, and redaction boundaries.
* ChatGPT subscription login uses the public openai-codex provider OAuth flow rather than reading Codex tokens.
