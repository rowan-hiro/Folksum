# 8. Use Telegram Bot for the first interaction alpha

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

Folksum needs a low-friction integrated-ledger capture experience that a two-person household can use daily for one week before broader frontend investment. The first channel must support natural-language and voice input, compact disambiguation controls, strong identity binding, and local-first persistence without coupling finance behavior to one messaging platform. Household-specific aliases, shortcuts, identities, and preferences must remain outside the public repository.

## Decision Drivers

* Minimize behavior change by reusing the household's existing Telegram workflow.
* Support voice, files, and one-tap card or category disambiguation without a form-first interface.
* Run the alpha from a local process without requiring a public inbound endpoint.
* Keep capture orchestration and Finance IR reusable by later Discord, Lark, web, or Mini App channels.
* Separate publishable mechanisms from private household configuration, data, and credentials.

## Considered Options

* Telegram Bot using long polling in a dedicated private household finance chat.
* Telegram Bot plus a Mini App from the first alpha.
* Discord bot using interactions and modals.
* Lark bot using interactive message cards.
* A standalone web frontend before validating conversational capture.

## Decision Outcome

Use a Telegram Bot with long polling for the first one-week alpha. Implement Telegram only as a generic channel adapter over channel-neutral capture orchestration and Finance IR. Use a dedicated private finance chat with explicit chat and user allowlists; keep the bot token outside Git and SQLite. Defer a Telegram Mini App, Discord, Lark, and standalone web UI until alpha evidence identifies interaction needs that message buttons cannot satisfy. Keep generic engines and adapters public while loading household profiles, aliases, shortcuts, persona, identifiers, and preferences from a separate private customization bundle.

## Consequences

* The alpha can reuse established household habits and avoid deployment of a public webhook endpoint.
* Financial messages traverse Telegram even though SQLite remains the local system of record, so access control and transcript retention require explicit policy.
* Group free-text capture may require Telegram privacy-mode configuration and therefore a dedicated finance-only chat.
* The public repository must define a versioned customization boundary with one-way dependency from private configuration to public application code.
* Later channel adapters can reuse capture behavior without receiving database access or bypassing Finance IR.

## Decision History

<!-- driftseal-reconciliation: 7b450d53-e579-4b04-a488-a5eb021a800b -->
### 2026-08-12T15:59:54.267Z — Intent `2026-08-12-025`

Status: Accepted → Accepted

Implemented the accepted Telegram long-polling alpha with private allowlists and identity mapping, scoped single-use buttons, durable update receipts, deterministic reminder delivery, deferred voice transcription, and no direct database access from the channel adapter.

<!-- driftseal-reconciliation: 00389806-8776-4883-a901-91d6705534ec -->
### 2026-08-13T12:40:05.464Z — Intent `2026-08-13-002`

Status: Accepted → Accepted

Confirmed after merging into the bookkeeping-profile branch: the Telegram long-polling adapter retains private allowlists, scoped single-use actions, durable at-most-once receipts, deterministic reminders, deferred voice handling, and application-owned Finance IR and confirmation boundaries.
