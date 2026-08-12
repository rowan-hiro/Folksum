# Home Wealth Agent Architecture

## 1. Product boundary

Home Wealth Agent is a local-first conversational assistant for a household's
everyday finances. Pi provides the LLM runtime, streaming, tool calling, and
conversation loop. The application owns all financial rules and persistence.

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
Finance Agent App
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
Finance Agent App. They are application components, not Pi tools with direct
database access.

### 3.1 Finance Agent App responsibilities

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

### 3.2 Finance IR

Finance IR is the stable boundary between probabilistic interpretation and
deterministic execution. A mutation contains at least:

```text
version, kind, householdId, actorId, sessionId,
occurredAt, idempotencyKey, payload, source
```

The model may propose an IR payload through a typed tool. Finance Agent App then
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

### 3.5 Pi dependency boundary

`pi-agent-core` and `pi-ai` are external runtime dependencies. Finance Agent App
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

### 4.4 Planned SQLite ledger integrity boundary (schema version 8)

This section is the target design for the next schema migration, not a description
of schema version 7. Version 7 validates transaction balance in `WealthService`
and relies on the absence of mutation APIs for immutability, while SQLite only
checks posting amount, foreign-key existence, and account household/currency
during posting insertion. Version 8 moves the irreducible ledger invariants into
SQLite as a second line of defense against application bugs and accidental direct
SQL.

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

#### 4.4.1 Schema shape and write protocol

Version 8 will denormalize `household_id` and `currency` onto `postings` and use
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

#### 4.4.2 Migration and failure policy

The version 7 to 8 migration runs as one transaction and fails closed. Before
changing the schema it checks every existing transaction for posting count,
integer balance, parent existence, household equality, and currency equality.
Invalid historical data is never repaired, rounded, deleted, or balanced with a
synthetic posting; the migration reports the violated invariant and leaves the
database at version 7.

The migration rebuilds `postings` to add the deferred composite key and new
columns, but avoids rebuilding `transactions`, which is already referenced by
reversals and statement payments. It derives each posting's stable ordinal from
the previous per-transaction `rowid` order and preserves all posting identifiers
and values. Replacement triggers and indexes are installed after the copy. The
migration runs `PRAGMA foreign_key_check`, advances `user_version` only after all
checks pass, and commits atomically. Every process opening the database must
continue to enable `PRAGMA foreign_keys = ON` for its connection.

Automated acceptance tests must prove:

- a valid version 7 file containing ordinary entries, a reversal, and an
  allocated card payment migrates without changing identifiers, balances,
  posting order, or payment links;
- an unbalanced, underspecified, orphaned, or cross-household/currency version 7
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
`HWM_CARD_TRACKING_MODE` may override the JSON file. The setting is local-only and
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
reminder for the same statement, threshold, and channel. The MVP has two delivery
surfaces:

- display due reminders whenever the interactive CLI starts; and
- a non-interactive command suitable for cron or a future notification adapter.

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
| `update_runtime_settings` | yes, non-financial | Persist and apply only provider, model, and thinking level |

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
`~/.home-wealth-manager/auth.json` by default. The directory and file are private
on POSIX systems (`0700` and `0600`), writes are atomic and serialized, and
`HWM_AUTH_PATH` may select a different location. Provider environment credentials
remain available as a non-persistent fallback. Secret values collected by the
login flow never enter SQLite sessions, model messages, tool arguments, or tool
results. Login and logout are local TUI actions; the model can neither read nor
mutate credentials.

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
- The reminder runner is safe to invoke repeatedly.
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
6. the Pi agent exposes only the documented finance tools; and
7. the CLI can run local reminder checks without an LLM API key; and
8. runtime settings and credentials persist separately without exposing secrets
   to the model or session transcript.

## 12. Deferred extensions

- encrypted sync and multiple devices;
- role-based access for household members;
- receipt OCR and bank/card imports;
- FX conversion and historical exchange-rate sources;
- securities, lots, performance, and capital gains;
- push, email, and chat notification adapters; and
- bank payment initiation with strong confirmation and reconciliation.

Each extension must preserve the ledger invariants and receive its own security
and consent design before implementation.
