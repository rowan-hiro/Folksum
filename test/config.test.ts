import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
	ApplicationConfigError,
	loadApplicationConfig,
	patchApplicationConfig,
} from "../src/app/config.ts";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-config-"));
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
		thinkingLevel: "low",
		cardTrackingMode: "lightweight",
		voiceTranscription: "off",
		voiceModel: "google/gemini-2.5-flash",
		voiceEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		voiceCommand: "python3",
	});
});

test("does not read pre-release HWM environment aliases", (context) => {
	const directory = createDirectory(context);
	const config = loadApplicationConfig({
		cwd: directory,
		env: {
			HWM_CONFIG_PATH: "old-config.json",
			HWM_DB_PATH: "old.db",
			HWM_PROVIDER: "anthropic",
			HWM_MODEL: "old-model",
		},
	});

	assert.equal(config.configPath, join(directory, ".data/config.json"));
	assert.equal(config.databasePath, ".data/wealth.db");
	assert.equal(config.provider, "openai");
	assert.equal(config.model, undefined);
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
			thinkingLevel: "high",
			cardTrackingMode: "integrated",
			voiceTranscription: "openrouter",
			voiceModel: "openai/gpt-4o-audio-preview",
			voiceEndpoint: "https://openrouter.example/api/v1/chat/completions",
			voiceLanguage: "zh-HK",
			voiceCommand: "/usr/bin/python3",
		}),
	);

	const config = loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: "settings.json" } });
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
		thinkingLevel: "high",
		cardTrackingMode: "integrated",
		voiceTranscription: "openrouter",
		voiceModel: "openai/gpt-4o-audio-preview",
		voiceEndpoint: "https://openrouter.example/api/v1/chat/completions",
		voiceLanguage: "zh-HK",
		voiceCommand: "/usr/bin/python3",
	});
});

test("validates voice transcription settings and keeps the key out of the JSON file", (context) => {
	const directory = createDirectory(context);
	assert.equal(
		loadApplicationConfig({
			cwd: directory,
			env: { FOLKSUM_VOICE_TRANSCRIPTION: "openrouter", FOLKSUM_VOICE_MODEL: "vendor/model" },
		}).voiceModel,
		"vendor/model",
	);
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_VOICE_TRANSCRIPTION: "whisper" } }),
		ApplicationConfigError,
	);
	assert.throws(
		() =>
			loadApplicationConfig({
				cwd: directory,
				env: { FOLKSUM_VOICE_ENDPOINT: "http://openrouter.example/v1/chat/completions" },
			}),
		/must use HTTPS/,
	);
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_VOICE_ENDPOINT: "not-a-url" } }),
		/must be a valid URL/,
	);

	const path = join(directory, "with-key.json");
	writeFileSync(path, JSON.stringify({ voiceApiKey: "sk-secret" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: "with-key.json" } }),
		/Unknown configuration value "voiceApiKey"/,
	);
	assert.throws(
		() =>
			patchApplicationConfig(
				join(directory, "config.json"),
				{ voiceTranscription: "openrouter" } as never,
				{ env: {} },
			),
		/cannot be changed at runtime/,
	);
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
			thinkingLevel: "minimal",
			cardTrackingMode: "lightweight",
		}),
	);

	const config = loadApplicationConfig({
		cwd: directory,
		env: {
			FOLKSUM_CONFIG_PATH: path,
			FOLKSUM_DB_PATH: "environment.db",
			FOLKSUM_HOUSEHOLD_NAME: "Environment Household",
			FOLKSUM_BASE_CURRENCY: "JPY",
			FOLKSUM_CLI_IDENTITY: "environment-owner",
			FOLKSUM_SESSION: "environment-session",
			FOLKSUM_MEMBER_NAME: "Environment Member",
			FOLKSUM_TIMEZONE: "Asia/Tokyo",
			FOLKSUM_PROVIDER: "google",
			FOLKSUM_MODEL: "environment-model",
			FOLKSUM_THINKING_LEVEL: "xhigh",
			FOLKSUM_CARD_TRACKING_MODE: "integrated",
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
	assert.equal(config.thinkingLevel, "xhigh");
	assert.equal(config.cardTrackingMode, "integrated");
});

test("atomically patches writable non-secret settings and preserves other JSON values", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "nested", "config.json");

	patchApplicationConfig(
		path,
		{
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			thinkingLevel: "medium",
			cardTrackingMode: "integrated",
		},
		{ env: {} },
	);
	const firstWrite = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.deepEqual(firstWrite, {
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		thinkingLevel: "medium",
		cardTrackingMode: "integrated",
	});
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

	writeFileSync(
		path,
		JSON.stringify({ ...firstWrite, householdName: "Preserved Household", timezone: "Asia/Tokyo" }),
	);
	patchApplicationConfig(path, { model: "gpt-5.5" }, { env: {} });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		provider: "openai-codex",
		model: "gpt-5.5",
		thinkingLevel: "medium",
		cardTrackingMode: "integrated",
		householdName: "Preserved Household",
		timezone: "Asia/Tokyo",
	});
});

test("rejects writable settings that are overridden by environment variables", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify({ provider: "openai", model: "gpt-4.1" }));

	assert.throws(
		() => patchApplicationConfig(path, { provider: "google" }, { env: { FOLKSUM_PROVIDER: "openai" } }),
		/FOLKSUM_PROVIDER/,
	);
	assert.throws(
		() =>
			patchApplicationConfig(
				path,
				{ thinkingLevel: "high" },
				{ env: { FOLKSUM_THINKING_LEVEL: "low" } },
			),
		/FOLKSUM_THINKING_LEVEL/,
	);
	assert.throws(
		() =>
			patchApplicationConfig(
				path,
				{ cardTrackingMode: "integrated" },
				{ env: { FOLKSUM_CARD_TRACKING_MODE: "lightweight" } },
			),
		/FOLKSUM_CARD_TRACKING_MODE/,
	);
	assert.throws(
		() =>
			patchApplicationConfig(
				path,
				{ databasePath: "other.db" } as never,
				{ env: {} },
			),
		/cannot be changed at runtime/,
	);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		provider: "openai",
		model: "gpt-4.1",
	});
});

test("rejects missing explicit files and invalid JSON settings", (context) => {
	const directory = createDirectory(context);
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: "missing.json" } }),
		ApplicationConfigError,
	);

	const path = join(directory, "invalid.json");
	writeFileSync(path, JSON.stringify({ provider: "openai-codex", thinkingLevel: "max" }));
	const codexConfig = loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } });
	assert.equal(codexConfig.provider, "openai-codex");
	assert.equal(codexConfig.thinkingLevel, "max");

	writeFileSync(path, JSON.stringify({ provider: "kimi-coding" }));
	const kimiConfig = loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } });
	assert.equal(kimiConfig.provider, "kimi-coding");

	writeFileSync(path, JSON.stringify({ provider: "unknown" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } }),
		/Unsupported provider/,
	);

	writeFileSync(path, JSON.stringify({ thinkingLevel: "extreme" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } }),
		/Unsupported thinking level/,
	);

	writeFileSync(path, JSON.stringify({ cardTrackingMode: "automatic" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } }),
		/Unsupported credit-card tracking mode/,
	);

	writeFileSync(path, JSON.stringify({ cardTrackingMode: "lightweight" }));
	assert.throws(
		() =>
			loadApplicationConfig({
				cwd: directory,
				env: { FOLKSUM_CONFIG_PATH: path, FOLKSUM_CARD_TRACKING_MODE: "automatic" },
			}),
		/Unsupported credit-card tracking mode/,
	);

	assert.throws(
		() => patchApplicationConfig(path, { cardTrackingMode: "automatic" as never }, { env: {} }),
		/Unsupported credit-card tracking mode/,
	);

	writeFileSync(path, "not json");
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } }),
		/Could not read configuration file/,
	);

	writeFileSync(path, JSON.stringify({ unexpected: "value" }));
	assert.throws(
		() => loadApplicationConfig({ cwd: directory, env: { FOLKSUM_CONFIG_PATH: path } }),
		/Unknown configuration value/,
	);
});

test("the local reminder command runs from JSON configuration without a model or provider credential", (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ databasePath: "wealth.db", baseCurrency: "USD" }));
	const cleanEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("FOLKSUM_")),
	) as NodeJS.ProcessEnv;
	cleanEnvironment.FOLKSUM_CONFIG_PATH = configPath;

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
