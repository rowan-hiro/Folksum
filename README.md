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
folksum reminders
folksum schedule
```

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

Provider credentials are stored separately in
`~/.folksum/auth.json`. Use the TUI settings screen for API-key or
OAuth login. Never put credentials in the JSON configuration or SQLite database.

The `reminders` and `schedule` commands do not require a configured model or
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
