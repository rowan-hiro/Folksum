# Agent instructions

## Project overview

Folksum, the Financial Intelligence & Record Engine, is a local-first,
conversational household-finance application.
It records expenses, income, transfers, credit-card statements and repayments,
asset valuations, reminders, and net-worth reports. SQLite is the system of
record; financial mutations are auditable and use a double-entry ledger.

The LLM is an interpretation layer, not the source of financial truth. The Pi
runtime handles model interaction and tool calling, while application code owns
identity, validation, confirmation policy, calculations, persistence, and
scheduling. Keep finance behavior behind the application-defined Finance IR and
do not give Pi tools direct database access.

Important product constraints:

- Preserve exact amounts: accept decimal strings at boundaries and store scaled
  integer minor units. Do not use floating-point values for ledger calculations.
- Balance every transaction within one currency and never combine currencies
  without an explicit exchange-rate source and valuation time.
- Correct posted transactions by reversal instead of deletion.
- Treat credit-card tracking modes as distinct accounting boundaries. Lightweight
  statements and repayments never mutate the ledger; integrated card activity
  does, and an existing statement keeps the mode captured when it was created.
- Keep data local by default and do not place provider credentials in SQLite.
- Reminders do not initiate payments. Bank connections, trading, tax
  calculation, and personalized investment advice are outside the MVP.

See `docs/architecture.md` for the full domain model, security boundaries, tool
surface, and acceptance criteria.

## Repository layout

- `src/channels/cli.ts` is the executable entry point for the TUI, legacy
  line-oriented chat, reminder checks, and scheduled reminder generation.
- `src/channels/tui.ts` owns the local `pi-tui` presentation layer, including
  model settings, provider login, streaming output, and confirmations.
- `src/app/` contains Finance IR orchestration, identity and session handling,
  confirmation policy, memory rules, and scheduling.
- `src/core/` contains SQLite persistence, exact-money helpers, domain types,
  and deterministic wealth and ledger services.
- `src/runtime/pi/` is the narrow adapter to `pi-agent-core` and `pi-ai`. It also
  owns the non-secret runtime-settings controller and the user-scoped credential
  store. Keep provider-specific model behavior out of the finance domain.
- `test/` contains Node test-runner suites for the domain and runtime boundary.
- `.intent-log/` and `.decision-log/` contain DriftSeal records and must be
  committed with the changes they describe.

## Development and build

The project is a publishable ESM TypeScript CLI managed with npm. It requires
Node.js 22.19.0 or newer because it uses the built-in SQLite module. Use the
committed `package-lock.json` for reproducible source installs:

```sh
npm ci
```

`tsconfig.json` performs development type-checking, while `tsconfig.build.json`
emits production JavaScript into `dist/` and rewrites relative `.ts` imports to
`.js`. The build is intentionally not a bundle: published Pi packages remain
normal runtime dependencies and are never copied into this package.

```sh
npm run build
```

Use the source-running development command for rapid local iteration:

```sh
npm run dev
```

Run strict type-checking separately with:

```sh
npm run typecheck
```

Run the complete automated test suite with:

```sh
npm test
```

Before reporting a code change as complete, run both `npm run typecheck` and
`npm test`. Tests use Node's built-in test runner and TypeScript stripping; the
production CLI runs emitted JavaScript without type-stripping or SQLite flags.

For release work, run `npm run release:verify`. It builds and packs the project,
checks the package allowlist, installs the tarball into an isolated temporary
project, verifies that Pi resolves as an external dependency, and smoke-tests the
installed CLI. `npm pack` creates the final tarball; never add
`bundledDependencies`, Pi source, or `node_modules` to it.

## Running the application

Start the full-screen interactive TUI with:

```sh
npm start
```

Open settings with `Ctrl+O` or `/settings`. The TUI can select the provider,
model, thinking level, and credit-card tracking mode, and can run the
provider-owned API-key or OAuth login flow. Non-secret choices are persisted in
the JSON configuration file. Provider
credentials are kept separately in `~/.folksum/auth.json`; override
that location with `FOLKSUM_AUTH_PATH` when needed. The credential directory and
file are created with `0700` and `0600` permissions on POSIX systems.
`kimi-coding` supports both `KIMI_API_KEY` and the Kimi Code subscription
device-code OAuth flow through this settings screen.

The model may update only provider, model, and thinking level through the
`update_runtime_settings` tool. Credit-card tracking mode and credentials are
local-only settings: the model can observe the active accounting behavior but
cannot change it. Credentials must never be pasted into chat or exposed to the
model; configure them through the local TUI login flow. Existing provider
credential environment variables remain supported by `pi-ai`.

The legacy line-oriented chat remains available for scripting or basic
terminals and requires a configured model:

```sh
FOLKSUM_MODEL=<installed-pi-model-id> npm run chat
```

Common settings are loaded from `.data/config.json` when it exists. Set
`FOLKSUM_CONFIG_PATH` to use another JSON file; a relative path is resolved from the
process working directory. Copy `config.example.json` to `.data/config.json` as
a starting point. Every non-secret `FOLKSUM_*` setting below overrides the
corresponding JSON value. The local-only commands do not require an LLM
credential:

```sh
npm run reminders
npm run schedule
```

Runtime configuration, in descending precedence:

1. An environment variable.
2. The corresponding key in the JSON configuration file.
3. The built-in default.

| Environment variable | JSON key | Default | Purpose |
| --- | --- | --- | --- |
| `FOLKSUM_CONFIG_PATH` | none | `.data/config.json` | JSON configuration file path |
| `FOLKSUM_DB_PATH` | `databasePath` | `.data/wealth.db` | SQLite database path |
| `FOLKSUM_HOUSEHOLD_NAME` | `householdName` | `My Household` | Name used when initializing the household |
| `FOLKSUM_BASE_CURRENCY` | `baseCurrency` | `HKD` | Initial household base currency |
| `FOLKSUM_CLI_IDENTITY` | `cliIdentity` | `local-owner` | External identity for the CLI channel |
| `FOLKSUM_SESSION` | `session` | `default` | CLI conversation key |
| `FOLKSUM_MEMBER_NAME` | `memberName` | `Local Owner` | Name used when creating the initial member |
| `FOLKSUM_TIMEZONE` | `timezone` | `Asia/Hong_Kong` | Timezone used for the initial member and reminders |
| `FOLKSUM_CARD_TRACKING_MODE` | `cardTrackingMode` | `lightweight` | Credit-card accounting mode: `lightweight` or `integrated` |
| `FOLKSUM_PROVIDER` | `provider` | `openai` | Pi model provider: `openai`, `openai-codex`, `anthropic`, `google`, or `kimi-coding` |
| `FOLKSUM_MODEL` | `model` | none | Pi model ID; required before sending a chat prompt |
| `FOLKSUM_THINKING_LEVEL` | `thinkingLevel` | `low` | Pi reasoning level from `off` through `max`, subject to model support |
| `FOLKSUM_AUTH_PATH` | none | `~/.folksum/auth.json` | User-scoped provider credential file |

<!-- driftseal -->
<!-- driftseal-version: 5 -->

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (`driftseal`) to prevent agent drift. Every work round:

1. **Write intent first**, before modifying, creating, or deleting files, or
   making any other change that may need a rollback:
   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.
   Add one `--decision <id>` for each existing decision this round may change.
   Single-step commands that only build, check, or record work already done
   (compiling, running tests, `git add`/`git commit`) need no intent.
2. **Execute only the intent.** Scope change? Close the current intent
   (`driftseal end -s partial|abandoned -n "<why>"`) and `driftseal begin` a new one.
3. **Verify, then close**: run the declared verification, then
   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<verify output>"`.
   Never report success without closing the intent.
   Before closing a linked intent as `completed` or `partial`, reconcile every
   declared decision with `driftseal decision update <id> --status <status> --note "<why>"`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   Do not edit a decision after reconciling it; run `decision update` again so
   the final content hash is recorded. Interrupted reconciliation is recovered
   by the next linked `decision update` or successful `end`. Closing as
   `failed` or `abandoned` cancels pending recovery for that intent.
   An authorized Git commit that only stages and records the verified changes and
   just-closed log finalizes that round without requiring a new intent. Any content
   change made while preparing the commit does require a new intent.
4. **Re-anchor after context loss**: run `driftseal status` and `driftseal log --last 3` before
   doing anything else. The open intent is the source of truth.

Log: `.intent-log/events.jsonl` (override with `$DRIFTSEAL_HOME`); commit it with the code.
<!-- /driftseal -->

<!-- driftseal-decisions -->
<!-- driftseal-decisions-version: 5 -->

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history: a rejected or deferred path worth
revisiting, non-obvious rationale behind a long-lived or costly-to-reverse accepted
choice, or a deprecated or superseded decision. Do not record routine, local,
readily reversible choices.

`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --option "<considered option>" --consequence "<result>"`

Add one `--driver`, `--option`, or `--consequence` flag per item. Use
`--status proposed|accepted|rejected|deferred|deprecated|superseded` when needed.
Use `proposed` for a choice still under active consideration. Use `deferred`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with `driftseal decision list --status deferred --count`,
then review them with `driftseal decision list --status deferred`.
When an intent declares an existing decision with `--decision <id>`, use
`driftseal decision update` to record its status transition or explicit confirmation.
Commit `.decision-log/` with the code.
<!-- /driftseal-decisions -->
