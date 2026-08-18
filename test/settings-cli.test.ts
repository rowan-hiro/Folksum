import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/channels/cli.ts", import.meta.url));

interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-settings-cli-"));
	writeFileSync(join(directory, "config.json"), "{}\n", "utf8");
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** Runs the CLI against an isolated config and database inside the directory. */
function runCli(
	directory: string,
	args: string[],
	extraEnvironment: Record<string, string> = {},
): CliResult {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--experimental-sqlite", cliPath, ...args],
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH ?? "",
				FOLKSUM_CONFIG_PATH: join(directory, "config.json"),
				FOLKSUM_DB_PATH: join(directory, "wealth.db"),
				...extraEnvironment,
			},
			encoding: "utf8",
		},
	);
	assert.equal(result.error, undefined);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("settings show prints the effective voice transcription settings", (context) => {
	const directory = createDirectory(context);

	const shown = runCli(directory, ["settings", "show"]);
	assert.equal(shown.status, 0, shown.stderr);
	assert.deepEqual(JSON.parse(shown.stdout), {
		voiceTranscription: "off",
		voiceModel: "google/gemini-2.5-flash",
		voiceEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		voiceCommand: "python3",
	});

	const overridden = runCli(directory, ["settings"], { FOLKSUM_VOICE_MODEL: "vendor/model" });
	assert.equal(overridden.status, 0, overridden.stderr);
	assert.deepEqual(JSON.parse(overridden.stdout), {
		voiceTranscription: "off",
		voiceModel: "vendor/model",
		voiceEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		voiceCommand: "python3",
	});
});

test("settings set persists the voice provider and model", (context) => {
	const directory = createDirectory(context);

	const enabled = runCli(directory, ["settings", "set", "voice-transcription", "openrouter"]);
	assert.equal(enabled.status, 0, enabled.stderr);
	assert.deepEqual(JSON.parse(enabled.stdout), {
		status: "updated",
		voiceTranscription: "openrouter",
	});

	const modeled = runCli(directory, ["settings", "set", "voice-model", "openai/gpt-4o-audio-preview"]);
	assert.equal(modeled.status, 0, modeled.stderr);
	assert.deepEqual(JSON.parse(modeled.stdout), {
		status: "updated",
		voiceModel: "openai/gpt-4o-audio-preview",
	});

	assert.deepEqual(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")), {
		voiceTranscription: "openrouter",
		voiceModel: "openai/gpt-4o-audio-preview",
	});

	const shown = runCli(directory, ["settings", "show"]);
	assert.equal(shown.status, 0, shown.stderr);
	assert.deepEqual(JSON.parse(shown.stdout), {
		voiceTranscription: "openrouter",
		voiceModel: "openai/gpt-4o-audio-preview",
		voiceEndpoint: "https://openrouter.ai/api/v1/chat/completions",
		voiceCommand: "python3",
	});
});

test("settings rejects invalid usage, values, and environment-overridden keys", (context) => {
	const directory = createDirectory(context);

	const rejections: Array<{ args: string[]; pattern: RegExp; env?: Record<string, string> }> = [
		{ args: ["settings", "show", "extra"], pattern: /Usage: folksum settings/ },
		{ args: ["settings", "set"], pattern: /Usage: folksum settings/ },
		{ args: ["settings", "set", "voice-model"], pattern: /Usage: folksum settings/ },
		{
			args: ["settings", "set", "voice-model", "a", "b"],
			pattern: /Usage: folksum settings/,
		},
		{ args: ["settings", "set", "model", "gpt-5"], pattern: /Usage: folksum settings/ },
		{
			args: ["settings", "set", "voice-transcription", "whisper"],
			pattern: /Unsupported voice transcription mode/,
		},
		{
			args: ["settings", "set", "voice-model", "  "],
			pattern: /"voiceModel" must be a non-empty string/,
		},
		{
			args: ["settings", "set", "voice-transcription", "openrouter"],
			pattern: /FOLKSUM_VOICE_TRANSCRIPTION/,
			env: { FOLKSUM_VOICE_TRANSCRIPTION: "off" },
		},
		{ args: ["settings", "bogus"], pattern: /Usage: folksum settings/ },
	];
	for (const { args, pattern, env } of rejections) {
		const result = runCli(directory, args, env);
		assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
		assert.match(result.stderr, pattern, `stderr for ${args.join(" ")}`);
	}

	// Failed invocations leave the JSON configuration untouched.
	assert.equal(readFileSync(join(directory, "config.json"), "utf8"), "{}\n");
});
