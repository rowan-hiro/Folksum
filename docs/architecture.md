# Folksum Architecture

## 1. Product boundary

Folksum, the Financial Intelligence & Record Engine, is a local-first
conversational assistant for a household's everyday finances. Pi provides the
LLM runtime, streaming, tool calling, and conversation loop. The application
owns all financial rules and persistence.

The MVP supports:

- natural-language expense, income, and transfer entry;
- credit-card statement tracking and repayment reminders;
- cash, liability, property, and investment account management;
- point-in-time asset valuations and net-worth summaries; and
- an auditable local history of every financial mutation.

The MVP does not connect to banks, initiate payments, trade securities, calculate
tax, or give personalized investment advice. Those capabilities require separate
connectors, consent, and security reviews.

## 2. Design principles

1. **The model interprets; deterministic code decides.** The LLM may turn a
   sentence into tool arguments, but it never calculates balances, bill status,
   or net worth itself.
2. **Use a double-entry ledger.** Every transaction has balanced postings in one
   currency. This makes transfers, liabilities, corrections, and audits explicit.
3. **Use decimal strings at boundaries and scaled integers in the ledger.** Users
   and tools exchange exact values such as `"38.50"`. The application validates
   the currency scale and stores that value as `3850` minor units. Floating-point
   values never enter the ledger.
4. **Never merge currencies implicitly.** Reports return one total per currency
   unless an explicit exchange-rate source and valuation time are supplied.
5. **Prefer reversal over deletion.** A correction creates a linked reversing
   transaction, preserving what happened and why.
6. **Keep data local by default.** SQLite is the system of record. Only context
   selected for a model request leaves the process.
7. **Separate reminders from payments.** The agent can identify and notify about
   an amount due. It cannot move money in the MVP.

## 3. System shape

```text
Telegram / Web / TUI / CLI
        |
        v
Folksum Application
        |
        |-- Session / Identity
        |-- Finance System Prompt
        |-- Finance IR
        |-- Confirmation Policy
        |-- Memory / Rules
        `-- Scheduler
        |
        v
+---------------------+
| pi-agent-core       |
|                     |
| agent loop          |
| messages/state      |
| tool calling        |
| model interaction   |
+----------+----------+
           |
           v
         pi-ai
           |
           v
 OpenAI / Anthropic / Gemini
```

The finance domain and SQLite repository sit behind Finance IR execution inside
the Folksum Application. They are application components, not Pi tools with direct
database access.

### 3.1 Folksum Application responsibilities

| Component | Responsibility |
| --- | --- |
| Channel adapters | Normalize Telegram, Web, TUI, and CLI events into one application request and render streamed responses or confirmation prompts |
| Session / Identity | Resolve channel identity to household, member, role, timezone, and conversation session |
| Finance System Prompt | Describe finance behavior and tool protocol without embedding account balances or business rules |
| Finance IR | Represent a validated, versioned financial read or mutation independently of the model and channel |
| Confirmation Policy | Classify risk and issue application-owned pending operations that the model cannot self-confirm |
| Memory / Rules | Store typed account aliases, categorization rules, preferences, and reminder policy separately from chat history |
| Scheduler | Run deterministic reminder jobs and write channel-neutral notifications to an outbox |
| Runtime adapter | Translate application capabilities into Pi tools and Pi events into application stream events |
| Runtime settings | Validate and persist the selected provider, model, and thinking level without exposing credentials to the model |
| Credential store | Implement the `pi-ai` credential contract in a private user-scoped `auth.json`, independently of finance data and transcripts |
| Finance services | Enforce ledger, card-statement, valuation, reporting, and idempotency invariants |

Channel adapters never instantiate Pi directly. They call one application service
that owns identity resolution, session loading, confirmation state, and runtime
selection. A scheduler job normally does not call an LLM: due-date calculation and
notification rendering are deterministic.

#### 3.1.1 Telegram alpha channel

The first external channel is a Telegram Bot using `grammy` and long polling.
The process requires no public inbound endpoint and refuses to run while an
outgoing webhook is configured. A strict private JSON file maps allow-listed
Telegram user IDs to existing household members and allow-listed chat/topic
destinations. The bot token is environment-only and never enters JSON, SQLite,
logs, model messages, or tool results.

The adapter resolves `userId` plus `chatId:threadId-or-root` through the common
session service. Runner concurrency is serialized by that same user/chat/topic
key, so one conversation stays ordered while unrelated household members may be
processed concurrently. Each prompt uses a short-lived Pi runtime restored from
the session transcript; the channel does not receive Finance IR or database
authority.

Confirmation and finite disambiguation choices are channel-neutral application
events. Telegram callback payloads carry only a random 16-character, in-memory,
single-use action ID and a bounded choice bit/index; they never carry a pending
operation token or financial payload. Consumption rechecks actor and session.
Restarting the process intentionally invalidates old buttons. A choice resumes
the same model session but has no confirmation authority; a financial mutation
still passes through Finance IR and the confirmation policy.

The reminder loop runs immediately and every fifteen minutes, evaluates each
recipient's local date, and renders the existing outbox payload without an LLM.
Failures use bounded exponential retry and stop after five attempts. Voice
updates are acknowledged without calling `getFile`; the application defines a
`VoiceTranscriber` interface for a future local implementation but does not
download or persist voice data in this alpha.

### 3.2 Finance IR

Finance IR is the stable boundary between probabilistic interpretation and
deterministic execution. A mutation contains at least:

```text
version, kind, householdId, actorId, sessionId,
occurredAt, idempotencyKey, payload, source
```

The model may propose an IR payload through a typed tool. The Folksum Application then
resolves account aliases, validates amounts and dates, applies household rules,
calculates the risk class, and either executes it or creates a pending operation.
The ledger never consumes raw model text or unchecked tool arguments.

Read operations use the same identity scope but do not create pending operations.
IR versions are explicit so stored pending operations and scheduled jobs can be
migrated without depending on a model transcript.

### 3.3 Confirmation policy

Confirmation is an application state transition, not a tool argument. A pending
operation is bound to the household, actor, session, canonical IR hash, expiry,
and single-use nonce. Telegram buttons, Web actions, and CLI prompts all confirm
the same pending-operation record. Text emitted by the model, including a field
such as `confirmed: true`, has no authority.

The default policy is:

| Risk | Examples | Default |
| --- | --- | --- |
| Read | balances, reminders, spending reports | execute |
| Low | complete everyday expense or income entry | execute and echo normalized result |
| Medium | create an account, register a statement, record a valuation | request confirmation unless a household rule allows it |
| High | reverse a transaction, allocate a card repayment, any future external side effect | always request explicit confirmation |

Changing these defaults is a typed household rule and remains auditable.

### 3.4 Memory and rules

Memory is structured application data, not an unbounded prompt suffix. Initial
rule types include account aliases, default payment accounts, merchant-category
rules, member preferences, timezone, and reminder thresholds. A rule records its
author, provenance, creation time, and optional expiry. Free-form conversation
summaries may help the model but never override typed financial or confirmation
rules.

### 3.5 Bookkeeping profiles and exports

Folksum provides a pinned `folksum/default@1` semantic profile. A household may
activate complete, validated revisions containing category hierarchies,
currency-specific category-to-account bindings, typed custom fields,
deterministic categorization rules, channel-neutral capture shortcuts, and
declarative export profiles. User profiles cannot add SQLite columns, redefine
account types, introduce Finance IR mutation kinds, or weaken exact-money,
balance, currency, confirmation, idempotency, or reversal rules.

The active SQLite revision is the runtime source of truth. Revisions contain a
normalized full profile, SHA-256 hash, author, source, and monotonically
increasing household revision number; revision rows are immutable. An editable
JSON file contains `fileFormatVersion`, `expectedRevision`, and the complete
profile. Both `profile apply` and the agent's typed patch tool use the same
application validator and optimistic revision check, so a stale file or
conversation cannot silently overwrite a newer change.

A private deployment may instead use the public bookkeeping DSL as a compact
overlay on the active revision. The parser accepts only allow-listed category,
field, rule, shortcut, export, and removal declarations, then compiles them into the same
profile patch model. It performs no includes, interpolation, SQL, templates, or
code execution. `profile check-dsl` validates without mutation;
`profile apply-dsl` explicitly activates the compiled full revision and rewrites
`expected-revision` in the source file. Household
values remain in the external DSL file rather than the public repository.

Categorization rules keep `transactionKind` and exactly one predicate:
`descriptionContains`, exact-money `amount` bounds, `amountPerPerson` bounds with
an explicit participant count, or boolean `all` / `any` / `not` composition.
Amount bounds are decimal strings and convert with the transaction currency at
match time; per-person comparisons multiply threshold minor units by the
participant count rather than dividing the amount. Capture shortcuts expand into
description, amount, category, and field values before classification; explicit
capture arguments override the shortcut. Expense and income interpretation then
uses this precedence: an explicit category, the highest-priority matching rule,
then an account-binding lookup. Explicit custom-field values override rule
assignments. Required fields, field types, category kind, household, currency,
and account bindings are validated before a ledger write. The transaction stores
the applied profile revision/hash, category id and label, matched rule, custom
fields, and resolution source atomically with its postings. Idempotent retries
retain the original snapshot; reversals copy it and identify reversal resolution
rather than reclassifying against the current profile. `explain_bookkeeping_match`
is a read of the current profile and never writes explanation text onto ledger
rows.

Export profiles are a non-executable projection DSL. They select transaction or
posting row mode, CSV or JSON, allow-listed columns, category/account/source
filters, reversal handling, and an explicit debit/credit sign convention.
Transaction-row amounts may be taken from an allowlisted posting role (`pnl`,
`funding`, `debit`, or `credit`). Columns may use a literal string instead of a
source, an allowlisted date format, and an optional UTF-8 BOM. Amounts are
formatted directly from integer minor units. The model may request a bounded
read-only preview, while arbitrary-path file writes remain available only through
an explicit local CLI command.

### 3.6 Pi dependency boundary

`pi-agent-core` and `pi-ai` are external runtime dependencies. The Folksum Application
imports their published package APIs through a narrow adapter. Application code
must not:

- live under the Pi source tree;
- import relative files from a local `pi/` checkout;
- require Pi coding-agent filesystem or shell tools;
- store domain state in Pi message history; or
- modify or fork Pi to add finance behavior.

The Pi agent receives only application-defined finance tools. Mutating execution
is sequential, while safe read-only reports may run in parallel. Replacing or
upgrading Pi affects the runtime adapter, not Finance IR or finance services.

The release build uses TypeScript emission rather than application bundling.
Bare `@earendil-works/pi-*` imports remain in the emitted JavaScript, and npm
installs the exact published Pi packages as runtime dependencies. The Folksum
tarball contains its own `dist/` output but never Pi source, Pi package contents,
or `node_modules`.

## 4. Accounting model

### 4.1 Accounts

Every account belongs to a household and has one currency and one of these
types:

| Type | Normal balance | Examples |
| --- | --- | --- |
| `asset` | debit | bank account, cash, property, brokerage account |
| `liability` | credit | credit card, mortgage, personal loan |
| `income` | credit | salary, interest, refund income |
| `expense` | debit | groceries, transport, utilities |
| `equity` | credit | opening balances, retained household equity |

Postings use a signed integer `amount_minor`: debit is positive and credit is
negative. API and tool inputs remain decimal strings, and formatted outputs always
restore the currency's fixed scale (`3850` HKD minor units becomes `"38.50"`). The
postings for a transaction must sum to zero and use the same currency.

Examples:

```text
Lunch paid with a credit card
  Dining expense       +3,800
  Credit-card liability -3,800

Salary received
  Bank asset          +2,000,000
  Salary income       -2,000,000

Credit-card repayment (integrated mode)
  Credit-card liability +120,000
  Bank asset            -120,000
```

### 4.2 Corrections and idempotency

Transactions are immutable after posting. A reversal contains opposite postings
and links to the original transaction. Each import or external caller may provide
an idempotency key; reusing the same key returns the existing transaction instead
of creating a duplicate.

### 4.3 Multi-currency behavior

An account has exactly one currency. A transaction is balanced within exactly
one currency. A currency conversion is represented as two linked balanced
transactions plus explicit rate metadata; conversion entry is outside the MVP.
Net-worth and spending reports return a map keyed by currency.

### 4.4 Channel update receipts (schema version 9)

Schema version 9 adds `channel_update_receipts` for at-most-once handling at an
external channel boundary. After Telegram chat and user allowlists pass, the
application atomically claims the bot/update identifier before resolving a
session or invoking a model. A duplicate returns the existing terminal or
processing receipt and performs no work. Successful handling marks the receipt
completed; a handled user error is also terminal, while an internal failure or
interrupted process is marked failed. Failed receipts are not automatically
reclaimed because a model or Telegram response may have completed before the
process lost local acknowledgement. The user must resend the request as a new
Telegram update.

Receipts store identifiers and bounded, generic failure categories, not raw
messages, tool payloads, provider diagnostics, credentials, or callback tokens.
They add channel idempotency around the existing Finance IR and ledger
idempotency boundaries rather than replacing either one.

### 4.5 Planned SQLite ledger integrity boundary (schema version 10)

This section is the target design for the next schema migration, not a description
of current schema version 9. Version 9 validates transaction balance in `WealthService`
and relies on the absence of mutation APIs for immutability, while SQLite only
checks posting amount, foreign-key existence, and account household/currency
during posting insertion. Schema version 8 added immutable bookkeeping profile
revisions and transaction classification snapshots, and version 9 adds channel
update receipts without changing ledger storage. Version 10 moves the
irreducible ledger invariants into SQLite as a second line of defense against
application bugs and accidental direct SQL.

The database boundary will enforce all of the following:

- every posted transaction has at least two non-zero integer postings;
- postings sum to exactly zero using SQLite integer arithmetic;
- the transaction, every posting account, and every posting share one household
  and currency;
- no posting can be appended after its transaction header is posted;
- transaction headers and postings cannot be updated or deleted; and
- an account's household, currency, and type cannot change after the account has
  a posting.

The application still validates these rules before writing so it can return
domain-specific errors. It must sum safe-integer posting amounts with `BigInt`,
not JavaScript `number`, to avoid cancellation near the safe-integer boundary.
Database validation is authoritative if application validation is bypassed.
SQLite `SUM` remains an integer operation: integer overflow aborts the write
instead of falling back to an approximate floating-point total.

#### 4.5.1 Schema shape and write protocol

Version 10 will denormalize `household_id` and `currency` onto `postings` and use
composite foreign keys to bind those values to both parents:

```text
postings(transaction_id, household_id, currency)
  -> transactions(id, household_id, currency)
     DEFERRABLE INITIALLY DEFERRED

postings(account_id, household_id, currency)
  -> accounts(id, household_id, currency)
```

Matching unique indexes on the parent column sets make these valid SQLite parent
keys. The transaction foreign key is deferred so a writer can construct a
complete journal entry before publishing its immutable header. The account
foreign key remains immediate so an invalid account scope fails at the posting
that introduced it. Each posting also receives an explicit zero-based `ordinal`;
reads order by it instead of relying on SQLite `rowid`.

All ledger writers use one central protocol:

1. Start `BEGIN IMMEDIATE` and perform the full application validation, including
   a `BigInt` balance check.
2. Generate the transaction identifier, then insert every posting with its
   household, currency, and ordinal while the deferred transaction parent is
   temporarily absent.
3. Insert the transaction header last. An `AFTER INSERT` trigger rejects fewer
   than two postings, a non-zero integer sum, or a household/currency mismatch.
4. Insert any dependent domain record, such as a statement-payment allocation,
   in the same outer transaction.
5. Commit. Deferred foreign-key validation closes the orphan-posting gap; any
   trigger, uniqueness, dependent-write, or commit failure rolls back the entire
   operation.

A `BEFORE INSERT` trigger on `postings` rejects an insert when its transaction
header already exists. Separate `BEFORE UPDATE` and `BEFORE DELETE` triggers make
both `transactions` and `postings` immutable. An account trigger freezes
`household_id`, `currency`, and `type` once any posting references the account.
Existing idempotency-key uniqueness, reversal links, and `ON DELETE RESTRICT`
relationships remain unchanged.

#### 4.5.2 Migration and failure policy

The version 9 to 10 migration runs as one transaction and fails closed. Before
changing the schema it checks every existing transaction for posting count,
integer balance, parent existence, household equality, and currency equality.
Invalid historical data is never repaired, rounded, deleted, or balanced with a
synthetic posting; the migration reports the violated invariant and leaves the
database at version 9.

The migration rebuilds `postings` to add the deferred composite key and new
columns, but avoids rebuilding `transactions`, which is already referenced by
reversals and statement payments. It derives each posting's stable ordinal from
the previous per-transaction `rowid` order and preserves all posting identifiers
and values. Replacement triggers and indexes are installed after the copy. The
migration runs `PRAGMA foreign_key_check`, advances `user_version` only after all
checks pass, and commits atomically. Every process opening the database must
continue to enable `PRAGMA foreign_keys = ON` for its connection.

Automated acceptance tests must prove:

- a valid version 9 file containing ordinary entries, a reversal, and an
  allocated card payment migrates without changing identifiers, balances,
  posting order, or payment links;
- an unbalanced, underspecified, orphaned, or cross-household/currency version 9
  database fails migration without changing its schema version or contents;
- direct SQL cannot commit an orphan, a zero- or one-posting transaction, an
  unbalanced entry, a cross-scope entry, or a posting appended to a published
  transaction;
- direct SQL cannot update or delete transactions/postings or reclassify an
  account that has postings, and every rejected operation leaves no partial
  state;
- all service paths, including opening balances, income, expenses, transfers,
  reversals, and card-payment allocation, still commit atomically; and
- the pathological posting set `[MAX_SAFE_INTEGER, 2, -MAX_SAFE_INTEGER, -1]`
  is rejected because its exact sum is one, and a SQLite integer-sum overflow
  also fails closed.

These controls protect the database from faulty or unintended application SQL.
They do not attempt to defend against an administrator who can replace the
database file, disable foreign-key enforcement, or drop schema triggers.

## 5. Credit-card statements and reminders

A credit card has an account for identity and currency, plus statement settings.
The local `cardTrackingMode` application setting chooses how new card activity is
recorded. Its default is `lightweight`; the TUI can switch it to `integrated`, and
`FOLKSUM_CARD_TRACKING_MODE` may override the JSON file. The setting is local-only and
is not exposed through the model's runtime-settings tool.

Each statement snapshots the active accounting mode when it is created. Changing
the setting affects new statements and new unallocated activity, but never
rewrites an existing statement or infers historical postings from its aggregate
amount. This prevents one statement from mixing accounting semantics across a
settings change.

| Behavior | `lightweight` | `integrated` |
| --- | --- | --- |
| Everyday card purchases | Not entered against the card ledger; daily bookkeeping stays separate | Post expense debit and card-liability credit |
| Statement | Aggregate obligation and reminder source | Reconciliation and reminder source; never an additional ledger balance |
| Repayment | Standalone statement allocation; optional funding-account metadata; no ledger mutation | Atomic bank-to-card ledger transaction and statement allocation |
| Spending and net worth | Read ledger only; standalone statement totals are shown only as obligations | Read ledger only; statement totals are not counted again |

Lightweight mode rejects a credit card as the funding account for an everyday
expense and rejects a credit-card opening ledger balance. Integrated mode requires
the card purchases to exist in the ledger before their repayments: a payment that
would make the card liability positive fails without a partial allocation. Generic
transfers involving a credit-card account are rejected in both modes so repayments
cannot bypass statement allocation.

A statement stores:

- statement period and statement date;
- due date and timezone;
- statement amount and minimum payment in minor units;
- its immutable accounting-mode snapshot; and
- either standalone repayment allocations or allocations linked to ledger
  transactions, according to that snapshot.

Outstanding amount is derived as `statement amount - allocated payments`; status is
derived as `open`, `due_soon`, `paid`, or `overdue`. It is not trusted as mutable
source data.

The version 6 to 7 migration snapshots legacy statements as `lightweight` because
their aggregate totals may not have corresponding card-purchase postings. Existing
payment allocations are copied into standalone payment records, while their
historical ledger transactions remain unchanged. This preserves balances and
idempotent retries without treating incomplete legacy ledgers as reconciled.

The default reminder policy emits reminders 7, 3, and 1 day before the due date,
on the due date, and once per day while overdue. A delivery record deduplicates a
reminder for the same statement, threshold, and channel. The MVP has three delivery
surfaces:

- display due reminders whenever the interactive CLI starts; and
- a non-interactive command suitable for cron; and
- deterministic Telegram delivery from the long-running alpha process, with
  bounded retry and no model call.

Recording a repayment and its allocation is atomic in both modes. The application
rejects over-allocation, idempotency conflicts, and currency mismatches. Switching
modes preserves all historical ledger entries and standalone obligations; reports
must label the two views and never combine them in a way that double counts debt.

## 6. Asset management and net worth

Cash-like accounts use their ledger balance. A non-cash asset account may have a
series of dated market valuations. Net-worth calculation uses the latest valuation
at or before the requested time in place of that account's book balance.
Liabilities continue to use ledger balances.

Every result includes:

- valuation timestamp;
- totals per currency;
- asset and liability breakdowns; and
- stale-valuation warnings when a configured freshness threshold is exceeded.

The MVP accepts manually entered total valuations. Holdings, quantities, live
prices, and automatic price feeds are later extensions.

## 7. Pi tool surface

| Tool | Mutation | Purpose |
| --- | --- | --- |
| `create_account` | yes | Create an asset, liability, income, expense, or equity account |
| `list_accounts` | no | Resolve account names and show balances |
| `record_expense` | yes | Post an asset-funded expense, or an integrated-mode card expense |
| `record_income` | yes | Post income received into an asset account |
| `record_transfer` | yes | Move value between compatible asset/liability accounts |
| `reverse_transaction` | yes | Correct a posted transaction without erasing history |
| `list_transactions` | no | Review recent activity and resolve correction targets |
| `record_card_statement` | yes | Register a card statement and due date |
| `record_card_payment` | yes | Allocate a standalone repayment, or post and allocate it in integrated mode |
| `list_card_reminders` | no | Return due-soon and overdue statements |
| `register_asset` | yes | Mark a non-cash asset account for valuation tracking |
| `record_asset_valuation` | yes | Store a dated total valuation |
| `get_net_worth` | no | Calculate household net worth per currency |
| `get_spending_summary` | no | Aggregate expense postings over a date range |
| `get_bookkeeping_profile` | no | Read the active semantic profile revision |
| `update_bookkeeping_profile` | yes | Patch categories, fields, rules, shortcuts, or export profiles |
| `preview_bookkeeping_export` | no | Render a bounded read-only export preview |
| `explain_bookkeeping_match` | no | Explain which current-profile rule would win |
| `update_runtime_settings` | yes, non-financial | Persist and apply only provider, model, and thinking level |
| `request_user_choice` | no, interaction only | Pause a supported channel turn for one bounded finite choice |

Tools return machine-readable details and concise text for the model. Errors are
explicit; the model must not claim a write succeeded after a tool error.

## 8. Natural-language behavior

The system prompt requires the agent to:

- use a tool before asserting that financial data was saved or retrieved;
- ask a concise question when amount, currency, account, or date is ambiguous;
- echo the normalized amount, date, and account after a successful write;
- never invent account identifiers, balances, bills, or valuations;
- explain that a reminder is not a completed payment; and
- avoid presenting reports as financial, tax, or legal advice.

In integrated mode, a clear request such as "Lunch was HKD 38 on my Visa today"
may be recorded without a second confirmation. In lightweight mode the agent keeps
that daily entry separate from the card obligation and must not post it to the card
ledger. Destructive correction uses a reversal, and all future external side
effects such as bank payment require explicit confirmation outside the LLM
conversation.

## 9. Storage and privacy

SQLite runs in WAL mode with foreign keys enabled. Schema migrations are
monotonic and execute in transactions. Non-secret runtime settings are stored in
the local JSON configuration file, with environment variables taking precedence.
The TUI and an allow-listed model tool can update provider, model, and thinking
level; changes are validated against the installed Pi catalog before an atomic
JSON replacement. The TUI can also update `cardTrackingMode`, but that application
setting is handled by a separate local controller and is never readable or
writable through the model tool.

The database and non-secret JSON configuration contain no LLM credentials.
Provider API keys and OAuth tokens use the `pi-ai` credential schema in
`~/.folksum/auth.json` by default. The directory and file are private
on POSIX systems (`0700` and `0600`), writes are atomic and serialized, and
`FOLKSUM_AUTH_PATH` may select a different location. Provider environment credentials
remain available as a non-persistent fallback. Secret values collected by the
login flow never enter SQLite sessions, model messages, tool arguments, or tool
results. Login and logout are local TUI actions; the model can neither read nor
mutate credentials.

Telegram uses a separate strict private JSON file for chat/topic allowlists and
user-to-member bindings. That file must be owner-only on POSIX systems. The bot
token is accepted only through `FOLKSUM_TELEGRAM_BOT_TOKEN`; it is not a valid
property in either JSON configuration. Authorized Telegram text necessarily
traverses Telegram and then the selected model provider, while the projected Pi
conversation remains in local SQLite. Voice payloads do not leave Telegram in
the alpha because the adapter never downloads them.

Bookkeeping profile files are explicit revision-aware import/export documents,
not a second live configuration source. Active profile revisions and immutable
per-transaction bookkeeping snapshots remain in SQLite. Local profile and data
exports are created with private file permissions and refuse implicit overwrite;
the model can preview an export but cannot choose or write a filesystem path.

The runtime projects Pi messages onto an explicit persistence allowlist, omitting
provider diagnostics, deferred handles, response identifiers, and tool details.
The TUI strips terminal control sequences from all untrusted transcript text
before rendering it, including streamed output and restored history.

Application logs exclude raw prompts, account notes, and tool payloads by default.
Backups must copy the SQLite database using the SQLite backup API or a documented
safe snapshot procedure. Device encryption and file permissions remain part of
deployment hardening.

## 10. Failure and safety behavior

- A ledger write and all of its postings commit atomically.
- An integrated statement payment, its ledger transaction, and its allocation
  commit atomically; a lightweight payment commits only its standalone allocation.
- Validation failures do not partially mutate data.
- A categorized ledger write and its applied profile metadata commit atomically.
- Stale profile files or agent patches fail revision checks without activation.
- Export definitions cannot execute code, and exact amounts never pass through
  floating-point conversion.
- The reminder runner is safe to invoke repeatedly.
- Telegram update receipts prevent redelivery from re-running handled work;
  interrupted receipts fail closed and require a new user message.
- Telegram callbacks are short-lived, single-use, and bound to the originating
  actor and session; restarting the process invalidates them.
- Telegram reminder delivery retries at most five times and never initiates a
  payment.
- Missing or stale valuations produce warnings, not fabricated estimates.
- Missing provider credentials leave the TUI available for local login and
  settings, but prevent model prompts. They do not prevent reminder commands.
- The TUI and CLI handle interruption without corrupting the database or leaving
  the terminal in raw mode.

## 11. MVP acceptance criteria

The first runnable version is complete when automated tests prove that:

1. expense, income, transfer, and reversal transactions remain balanced;
2. duplicate idempotency keys do not duplicate transactions;
3. both card-tracking modes persist across restart, retain a statement-level mode
   snapshot, reduce the correct statement without over-allocation, and never
   double count ledger balances;
4. reminder boundaries distinguish future, due-today, paid, and overdue bills;
5. net worth uses the latest eligible asset valuation and stays separated by
   currency;
6. the Pi agent exposes only the documented finance tools;
7. the CLI can run local reminder checks without an LLM API key;
8. runtime settings and credentials persist separately without exposing secrets
   to the model or session transcript; and
9. profile revisions, categorization metadata, file concurrency, and declarative
   export behavior preserve the accounting and runtime boundaries; and
10. Telegram allowlists, receipts, scoped callbacks, reminder retries, and
    graceful shutdown preserve the same Finance IR and credential boundaries.

## 12. Deferred extensions

- encrypted sync and multiple devices;
- role-based access for household members;
- receipt OCR and bank/card imports;
- FX conversion and historical exchange-rate sources;
- securities, lots, performance, and capital gains;
- local voice transcription, Telegram Mini Apps, webhooks, and additional chat
  notification adapters;
- push and email notification adapters; and
- bank payment initiation with strong confirmation and reconciliation.

Each extension must preserve the ledger invariants and receive its own security
and consent design before implementation.
