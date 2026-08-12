import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { ApplicationConfigError, loadApplicationConfig } from "../src/app/config.ts";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "home-wealth-config-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("uses defaults when the default JSON configuration file is absent", (context) => {
	const directory = createDirectory(context);
	const config = loadApplicationConfig({ cwd: directory, env: {} });
	assert.deepEqual(config, {
		configPath: join(directory, ".data/config.json"),
		databasePath: ".data/wealth.db",
		householdName: "My Household",
		baseCurrency: "HKD",
		cliIdentity: "local-owner",
		session: "default",
		memberName: "Local Owner",
		timezone: "Asia/Hong_Kong",
		provider: "openai",
	});
});

test("loads common settings from a JSON file", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "settings.json");
	writeFileSync(
		path,
		JSON.stringify({
			databasePath: "data/custom.db",
			householdName: "The Example Household",
			baseCurrency: "USD",
			cliIdentity: "owner-42",
			session: "personal",
			memberName: "Example Owner",
			timezone: "America/New_York",
			provider: "anthropic",
			model: "example-model",
		}),
	);

	const config = loadApplicationConfig({ cwd: directory, env: { HWM_CONFIG_PATH: "settings.json" } });
	assert.deepEqual(config, {
		configPath: path,
		databasePath: "data/custom.db",
		householdName: "The Example Household",
		baseCurrency: "USD",
		cliIdentity: "owner-42",
		session: "personal",
		memberName: "Example Owner",
		timezone: "America/New_York",
		provider: "anthropic",
		model: "example-model",
	});
});

test("environment variables override individual JSON settings", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			databasePath: "file.db",
			householdName: "File Household",
			baseCurrency: "USD",
			cliIdentity: "file-owner",
			session: "file-session",
			memberName: "File Member",
			timezone: "America/New_York",
			provider: "anthropic",
			model: "file-model",
		}),
	);

	const config = loadApplicationConfig({
		cwd: directory,
		env: {
			HWM_CONFIG_PATH: path,
			HWM_DB_PATH: "environment.db",
			HWM_HOUSEHOLD_NAME: "Environment Household",
			HWM_BASE_CURRENCY: "JPY",
			HWM_CLI_IDENTITY: "environment-owner",
			HWM_SESSION: "environment-session",
			HWM_MEMBER_NAME: "Environment Member",
			HWM_TIMEZONE: "Asia/Tokyo",
			HWM_PROVIDER: "google",
			HWM_MODEL: "environment-model",
		},
	});

	assert.equal(config.databasePath, "environment.db");
	assert.equal(config.householdName, "Environment Household");
	assert.equal(config.baseCurrency, "JPY");
	assert.equal(config.cliIdentity, "environment-owner");
	assert.equal(config.session, "environment-session");
	assert.equal(config.memberName, "Environment Member");
	assert.equal(config.timezone, "Asia/Tokyo");
	assert.equal(config.provider, "google");
	assert.equal(config.model, "environment-model");
});

test("rejects missing explicit files and invalid JSON settings", (context) => {
	const directory = createDirectory(context);
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { HWM_CONFIG_PATH: "missing.json" } }),
		ApplicationConfigError,
	);

	const path = join(directory, "invalid.json");
	writeFileSync(path, JSON.stringify({ provider: "unknown" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { HWM_CONFIG_PATH: path } }),
		/Unsupported provider/,
	);

	writeFileSync(path, "not json");
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { HWM_CONFIG_PATH: path } }),
		/Could not read configuration file/,
	);

	writeFileSync(path, JSON.stringify({ unexpected: "value" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { HWM_CONFIG_PATH: path } }),
		/Unknown configuration value/,
	);
});

test("the local reminder command runs from JSON configuration without a model or provider credential", (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ databasePath: "wealth.db", baseCurrency: "USD" }));
	const cleanEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("HWM_")),
	) as NodeJS.ProcessEnv;
	cleanEnvironment.HWM_CONFIG_PATH = configPath;

	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--experimental-sqlite",
			resolve(import.meta.dirname, "../src/channels/cli.ts"),
			"reminders",
		],
		{ cwd: directory, env: cleanEnvironment, encoding: "utf8", timeout: 10_000 },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /No credit-card repayments/);
	assert.equal(existsSync(join(directory, "wealth.db")), true);
});
