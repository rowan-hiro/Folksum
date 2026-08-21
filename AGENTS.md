# Agent instructions

## Project overview

Folksum, the Financial Intelligence & Record Engine, is a local-first,
conversational household-finance application.
It records expenses, income, transfers, credit-card statements and repayments,
asset valuations, reminders, and net-worth reports. SQLite is the system of
record; financial mutations are auditable and use a double-entry ledger.
Households can activate revisioned semantic bookkeeping profiles for categories,
typed fields, capture shortcuts, amount-aware categorization rules, and
declarative exports without changing the physical ledger schema.

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
- `src/channels/telegram*.ts` contains the allow-listed long-polling Telegram
  adapter, callback rendering, and deterministic reminder delivery.
- `src/app/` contains Finance IR orchestration, identity and session handling,
  confirmation policy, memory rules, and scheduling.
- `src/core/` contains SQLite persistence, exact-money helpers, domain types,
  and deterministic wealth and ledger services.
- `src/runtime/pi/` is the narrow adapter to `pi-agent-core` and `pi-ai`. It also
  owns the non-secret runtime-settings controller and the user-scoped credential
  store. Keep provider-specific model behavior out of the finance domain.
- `src/runtime/voice/` runs the bundled Python transcription script as a
  short-lived child process. The finance domain sees only the channel-neutral
  `VoiceTranscriber` interface in `src/app/voice-transcriber.ts`.
- `python/folksum_transcribe.py` is the standard-library-only transcription
  script. It reads audio from standard input, posts it to the configured
  OpenRouter endpoint, and writes exactly one JSON result to standard output.
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

Open settings with `Ctrl+O` or `/settings`. The `/members` command lists
household members, and `/members add` creates one through an interactive
name, role, and timezone prompt. The TUI can select the provider,
model, thinking level, credit-card tracking mode, and the voice
transcription provider and model, and can run the
provider-owned API-key or OAuth login flow. Non-secret choices are persisted in
the JSON configuration file. Voice settings apply to Telegram voice messages
and take effect on the next telegram process start. Provider
credentials are kept separately in `~/.folksum/auth.json`; override
that location with `FOLKSUM_AUTH_PATH` when needed. The credential directory and
file are created with `0700` and `0600` permissions on POSIX systems.
`kimi-coding` supports both `KIMI_API_KEY` and the Kimi Code subscription
device-code OAuth flow through this settings screen.

The model may update only provider, model, and thinking level through the
`update_runtime_settings` tool. Credit-card tracking mode, voice transcription
settings, and credentials are
local-only settings: the model can observe the active accounting behavior but
cannot change it. Credentials must never be pasted into chat or exposed to the
model; configure them through the local TUI login flow. Existing provider
credential environment variables remain supported by `pi-ai`.

The legacy line-oriented chat remains available for scripting or basic
terminals and requires a configured model:

```sh
FOLKSUM_MODEL=<installed-pi-model-id> npm run chat
```

The Telegram alpha uses long polling from a dedicated private finance chat.
Configure provider credentials in the local TUI, copy `telegram.example.json`
to a private `0600` file, map Telegram users to IDs from `folksum members`, and
pass the bot token only through the environment:

```sh
FOLKSUM_TELEGRAM_BOT_TOKEN=<bot-token> npm run telegram
```

The process refuses to replace an active webhook. Voice transcription is opt-in
and disabled by default: while `voiceTranscription` is `off` no voice file is
downloaded. Setting it to `openrouter` downloads an allow-listed voice message
and passes the audio to the bundled Python script `python/folksum_transcribe.py`,
which posts it to the configured OpenRouter endpoint and returns the transcript
on standard output. The transcript is echoed to the chat and then handled as an
ordinary text turn, so confirmation policy, Finance IR, and the
credential-shaped-input check still apply. The transcription key is accepted
only through `FOLKSUM_VOICE_API_KEY`, never through JSON, SQLite, a command-line
argument, or the model. The script needs Python 3 with only the standard
library, plus `ffmpeg` to convert Telegram's Ogg/Opus audio to WAV.

Common settings are loaded from `.data/config.json` when it exists. Set
`FOLKSUM_CONFIG_PATH` to use another JSON file; a relative path is resolved from the
process working directory. Copy `config.example.json` to `.data/config.json` as
a starting point. Every non-secret `FOLKSUM_*` setting below overrides the
corresponding JSON value. The local-only commands do not require an LLM
credential:

```sh
npm run reminders
npm run schedule
folksum members
folksum members add --name <display-name> [--role owner|member|viewer] [--timezone <iana-timezone>]
folksum settings show
folksum settings set <voice-transcription|voice-model> <value>
```

`folksum settings show` prints the effective voice transcription settings, and
`settings set` persists the voice provider (`off` or `openrouter`) or model to
the JSON configuration file. Keys overridden by their environment variable
cannot be changed through either the command or the TUI settings screen.

Bookkeeping profiles use revision-aware JSON documents or constrained DSL
overlays. Households can declare categories, typed fields, capture shortcuts,
amount-aware categorization rules, and declarative exports. These commands
inspect, export, validate, and explicitly apply them; data exports use a named
declarative profile:

```sh
folksum profile show
folksum profile export .data/bookkeeping-profile.json
folksum profile apply .data/bookkeeping-profile.json
folksum profile check-dsl .data/bookkeeping.folksum
folksum profile apply-dsl .data/bookkeeping.folksum
folksum export <profile-id> <from> <to> [output-path]
```

`profile apply-dsl` returns the active revision as `expectedRevision` but never
rewrites the private `.folksum` source. The user must update its
`expected-revision` directive explicitly before the next check or apply.

Both profile and data export commands refuse to replace an existing file unless
the user explicitly supplies `--force`. The model can inspect and propose profile
patches, preview exports, and explain rule matches, but it cannot write local
files.

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
| `FOLKSUM_TELEGRAM_CONFIG_PATH` | none | `.data/telegram.json` | Private Telegram chat/user/member mapping |
| `FOLKSUM_TELEGRAM_BOT_TOKEN` | none | none | Environment-only Telegram bot credential |
| `FOLKSUM_VOICE_TRANSCRIPTION` | `voiceTranscription` | `off` | Voice transcription mode: `off` or `openrouter` |
| `FOLKSUM_VOICE_MODEL` | `voiceModel` | `google/gemini-2.5-flash` | Audio-capable model used for transcription |
| `FOLKSUM_VOICE_ENDPOINT` | `voiceEndpoint` | `https://openrouter.ai/api/v1/chat/completions` | HTTPS transcription endpoint |
| `FOLKSUM_VOICE_LANGUAGE` | `voiceLanguage` | none | Optional BCP 47 language hint |
| `FOLKSUM_VOICE_COMMAND` | `voiceCommand` | `python3` | Interpreter used to run the transcription script |
| `FOLKSUM_VOICE_API_KEY` | none | none | Environment-only transcription credential |

<!-- driftseal -->
<!-- driftseal-version: 2.0 -->
<!-- driftseal-log-language: en -->

## Agent protocol: outcome write-ahead log

This repository uses DriftSeal (`driftseal`) to prevent agent drift. This
`AGENTS.md` protocol is the source of truth; use the CLI by default, with MCP
and lifecycle hooks as optional adapters.

**Log language:** `en`. Write outcome-log prose (outcome, extension, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.

1. **Write the outcome first**, before changing durable project content:
   `driftseal begin "<coherent delivery outcome>" --accept "<observable result>" --verify "<exact command that proves the cumulative contract>"`.
   Repeat `--accept` for independently observable criteria and add one
   `--decision <id>` for each existing MADR this outcome may change.
   Record outcomes for changes intended to persist in the project: code,
   configuration, documentation, dependencies, and equivalent files, inside or
   outside Git. Git operations, checks, temporary auxiliary work, and external
   state changes are exempt when they do not write durable project content here.
2. **Extend only the same outcome.** For another step toward the same coherent
   delivery goal, append `driftseal extend "<addition>"`. It may add
   `--accept`, `--decision`, and a replacement `--verify`; adding acceptance
   requires a replacement verifier that proves the complete accumulated contract.
   Every extension invalidates earlier verification and MADR reconciliation. If
   the delivery goal changes, close the current outcome honestly and begin a new one.
   One open outcome belongs to one worktree, or one configured non-Git project
   root. Every agent changing durable content in the same root re-anchors and
   continues it; separate worktrees hold separate outcomes.
3. **Reconcile, verify, then close.** After the final extension, reconcile every
   linked MADR with `driftseal decision update`. Inspect `driftseal status`,
   then run `driftseal verify` for an acceptance-bound outcome. A verifier
   without matching local provenance is untrusted and requires
   `--allow-tracked-command` after inspection. Finish with
   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>"`.
   Completed outcomes require fresh successful verification bound to both the
   current contract hash and Git-visible workspace. Never report success without
   closing the outcome.
4. **Re-anchor after context loss or handoff:** run `driftseal status` and
   `driftseal log --last 3` before changing durable content. Resume the open
   outcome when it still matches; otherwise close it and begin a new one.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
`.seal/outcomes/events.jsonl` (or its configured equivalent) directly. Use
`reclaim`/`unreclaim` for visibility markers and `absorb` after merge
collisions. These operations preserve append-only single-lineage history.

Seal root: `.seal/` (override with `$DRIFTSEAL_HOME`); outcome log:
`.seal/outcomes/events.jsonl`; commit `.seal/` with the code.
<!-- /driftseal -->

<!-- driftseal-decisions -->
<!-- driftseal-decisions-version: 2.0 -->
<!-- driftseal-log-language: en -->

## Agent protocol: decision log

Record a MADR only when it preserves context that the outcome log and Git cannot
recover: rejected or deferred paths worth revisiting, non-obvious rationale for
long-lived or costly-to-reverse choices, and deprecated or superseded decisions.
Do not record routine, local, readily reversible choices.

**Log language:** `en`. Write decision-log prose (title, context,
outcome, drivers, options, consequences, and update notes) in that language.
Keep MADR section headings, status tokens, and ids in English.

`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"`

Use `proposed|accepted|rejected|deferred|deprecated|superseded` statuses. Link
existing MADRs from `begin` or `extend`, then reconcile each linked record
with `driftseal decision update` before successful or partial closure. After a
merge, `driftseal absorb` remaps colliding ids; it never auto-merges concurrent
edits of a shared MADR.
Commit `.seal/madr/` with the code.
<!-- /driftseal-decisions -->
