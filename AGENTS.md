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

## Running the application

Start the full-screen interactive TUI with:

```sh
npm start
```

Open settings with `Ctrl+O` or `/settings`. The `/members` command lists
household members, and `/members add` creates one through an interactive
name, role, and timezone prompt. The TUI can select the provider,
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
`FOLKSUM_CONFIG_PATH` to use another JSON file; a relative path is resolved from
the process working directory. Copy `config.example.json` to `.data/config.json`
as a starting point. Every non-secret `FOLKSUM_*` setting below overrides the
corresponding JSON value. The local-only commands do not require an LLM
credential:

```sh
npm run reminders
npm run schedule
folksum members
folksum members add --name <display-name> [--role owner|member|viewer] [--timezone <iana-timezone>]
```

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
