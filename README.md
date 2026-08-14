# Folksum

**Financial Intelligence & Record Engine**

Folksum is a local-first conversational household-finance application.
It combines a SQLite double-entry ledger, credit-card reminders, asset valuations,
and net-worth reports with a full-screen LLM-assisted terminal interface.

Financial state and validation stay in the application. The LLM interprets user
requests and calls an application-owned finance API; it is not the source of
financial truth.

## Requirements

- Node.js 22.19.0 or newer
- npm

## Install a release package

After the package is published to npm:

```sh
npm install --global folksum
folksum
```

A locally produced release tarball can be installed in the same way:

```sh
npm install --global ./folksum-0.1.0.tgz
folksum
```

The command opens the TUI by default. Other commands are available for
line-oriented chat and unattended reminder processing:

```sh
folksum chat
folksum telegram
folksum members
folksum reminders
folksum schedule
```

## Telegram alpha

The first interaction alpha runs a Telegram Bot locally with long polling. It
accepts allow-listed text messages, presents one-tap disambiguation and
confirmation buttons, and delivers deterministic credit-card repayment
reminders. It does not require a public URL or webhook.

Create a dedicated private finance group and a bot through BotFather. Disable
the bot's privacy mode if it must receive ordinary group messages. Initialize
Folksum once, list the local household member identifiers, and prepare the
private Telegram configuration:

```sh
folksum members
cp telegram.example.json .data/telegram.json
chmod 600 .data/telegram.json
```

Replace the example chat, topic, user, and member identifiers. `chatId`,
`threadId`, and `userId` are decimal strings so Telegram identifiers are never
rounded. Every reminder destination must also appear in `allowedChats`.
`memberId` must refer to a member returned by `folksum members`.

Configure the model credential through the local TUI, then supply the bot token
only through the environment and start the long-polling process:

```sh
FOLKSUM_TELEGRAM_BOT_TOKEN=<bot-token> folksum telegram
```

Set `FOLKSUM_TELEGRAM_CONFIG_PATH` when the private file is not
`.data/telegram.json`. The bot token is never accepted in JSON, stored in
SQLite, or sent to the model. The private mapping file is rejected on POSIX
systems unless group and other users have no access.

Folksum refuses to start long polling while the bot has an active webhook and
does not remove that webhook automatically. Updates from any chat, topic, or
user outside the explicit allowlists are ignored before session or receipt
state is created. Authorized update IDs are recorded locally so Telegram
redelivery cannot repeat an operation; an update interrupted by a process crash
is marked failed rather than replayed automatically, and the user may resend it
as a new message.

Voice transcription is deliberately disabled in this alpha. Voice files are
not downloaded or sent to the model; the bot asks the user to send text. A
channel-neutral `VoiceTranscriber` interface is reserved for a later local
transcription implementation.

SQLite remains the financial system of record, but messages and bot replies
necessarily traverse Telegram. Provider prompts also leave the machine under
the configured model provider's policy, while the projected conversation
history is retained in local SQLite. Use a dedicated finance-only chat and set
Telegram's transcript retention policy accordingly. Reminder messages never
initiate payments.

## Bookkeeping profiles and exports

Folksum ships a pinned `folksum/default@1` semantic bookkeeping profile. A
household can customize categories, currency-specific account bindings, typed
transaction fields, capture shortcuts, deterministic categorization rules, and
declarative CSV or JSON export profiles. These definitions never alter the
physical ledger schema or its accounting invariants.

Rules match on a description substring, exact-money amount bounds, per-person
thresholds with an explicit participant count, or boolean `all` / `any` / `not`
composition. Capture shortcuts expand into structured expense or income input
before classification. Export profiles may take a transaction-row amount from a
posting role (`pnl`, `funding`, `debit`, or `credit`), emit literal columns,
format dates from an allowlist, and optionally prefix UTF-8 BOM.

The active profile is an immutable SQLite revision. Export an editable,
revision-aware JSON document, change it, and apply it through the same validation
path used by the conversational agent:

```sh
folksum profile show
folksum profile export .data/bookkeeping-profile.json
# Edit .data/bookkeeping-profile.json.
folksum profile apply .data/bookkeeping-profile.json
```

`expectedRevision` in the file prevents an old file from overwriting a newer
agent or file update. Profile and data export commands refuse to replace an
existing output file unless `--force` is explicitly supplied.

An export profile selects transaction or posting rows, allow-listed columns,
filters, reversal handling, and the debit/credit sign convention. It cannot
contain SQL, JavaScript, shell commands, or executable templates. Render to
standard output or provide a private output file:

```sh
folksum export accountant.csv 2026-01-01 2026-12-31
folksum export accountant.csv 2026-01-01 2026-12-31 exports/2026.csv
```

The agent can inspect and propose changes to the active profile, subject to
application-owned confirmation, preview bounded exports, and explain which
current-profile rule would win. It has no tool that writes profile or export
files. Private overlays keep household vocabulary in `.folksum` text; the
compiler emits the semantic profile IR and does not execute overlay code.

For smaller private overlays, Folksum also provides a non-executable bookkeeping
DSL. A private file can upsert or remove categories, typed transaction fields,
deterministic categorization rules, account bindings, and declarative exports
without copying the complete built-in profile:

```sh
folksum profile check-dsl path/to/household.folksum
folksum profile apply-dsl path/to/household.folksum
```

The DSL carries an optimistic `expected-revision` and compiles through the same
profile patch validator used by conversational changes. It has no includes,
interpolation, SQL, templates, or executable code. On success, `apply-dsl`
prints the active revision as `expectedRevision` but never edits the private
`.folksum` file. Update its `expected-revision` directive explicitly before the
next validation or activation; leaving the old value in place produces a stale
revision error. See
[`docs/bookkeeping-dsl.md`](docs/bookkeeping-dsl.md) for the grammar and the
public/private customization boundary.

## Build from source

```sh
npm ci
npm run build
npm start
```

The production build emits ESM JavaScript into `dist/`. It does not require a Pi
source checkout and does not use Node's runtime TypeScript stripping.

Pi is deliberately an external runtime dependency. npm installs the published
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and
`@earendil-works/pi-tui` packages alongside Folksum. Those packages, their
source trees, and `node_modules` are not copied into the Folksum
tarball.

## Configuration and local data

By default, non-secret settings are read from `.data/config.json`, and the SQLite
database is stored at `.data/wealth.db`. These paths are relative to the directory
where the command is run. For cron jobs or launches from multiple directories,
set absolute paths with `FOLKSUM_CONFIG_PATH` and `FOLKSUM_DB_PATH`.

When building from source, `config.example.json` is a complete starting point.
For an installed CLI, create `.data/config.json` in the directory where the
command will run; a minimal model configuration looks like this:

```json
{
  "provider": "openai",
  "model": "gpt-5.6-terra",
  "thinkingLevel": "low"
}
```

Environment variables override individual JSON values:

| Environment variable | JSON key | Default |
| --- | --- | --- |
| `FOLKSUM_CONFIG_PATH` | none | `.data/config.json` |
| `FOLKSUM_DB_PATH` | `databasePath` | `.data/wealth.db` |
| `FOLKSUM_HOUSEHOLD_NAME` | `householdName` | `My Household` |
| `FOLKSUM_BASE_CURRENCY` | `baseCurrency` | `HKD` |
| `FOLKSUM_CLI_IDENTITY` | `cliIdentity` | `local-owner` |
| `FOLKSUM_SESSION` | `session` | `default` |
| `FOLKSUM_MEMBER_NAME` | `memberName` | `Local Owner` |
| `FOLKSUM_TIMEZONE` | `timezone` | `Asia/Hong_Kong` |
| `FOLKSUM_CARD_TRACKING_MODE` | `cardTrackingMode` | `lightweight` |
| `FOLKSUM_PROVIDER` | `provider` | `openai` |
| `FOLKSUM_MODEL` | `model` | none |
| `FOLKSUM_THINKING_LEVEL` | `thinkingLevel` | `low` |
| `FOLKSUM_AUTH_PATH` | none | `~/.folksum/auth.json` |
| `FOLKSUM_TELEGRAM_CONFIG_PATH` | none | `.data/telegram.json` |
| `FOLKSUM_TELEGRAM_BOT_TOKEN` | none | none; required by `folksum telegram` |

Provider credentials are stored separately in
`~/.folksum/auth.json`. Use the TUI settings screen for API-key or
OAuth login. Never put credentials in the JSON configuration or SQLite database.

The `members`, `reminders`, and `schedule` commands do not require a configured model or
provider credential.

## Verify and pack a release

```sh
npm run release:verify
npm pack
```

Release verification performs strict type-checking, the complete test suite, a
clean production build, package-content checks, installation into an isolated
temporary project, dependency resolution checks, and installed CLI smoke tests.
It also verifies that Pi remains an external dependency and that source, tests,
local databases, credentials, intent logs, and `node_modules` are absent from the
tarball.

## License

MIT
