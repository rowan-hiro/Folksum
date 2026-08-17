import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ApplicationSettingsController } from "../src/app/settings.ts";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-application-settings-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const DEFAULT_VOICE_SETTINGS = {
	voiceTranscription: "off",
	voiceModel: "google/gemini-2.5-flash",
} as const;

test("persists the credit-card tracking mode before applying it live", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({ cardTrackingMode: "lightweight", householdName: "Preserved Household" }),
	);
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight", ...DEFAULT_VOICE_SETTINGS },
		env: {},
	});

	assert.deepEqual(controller.current(), {
		cardTrackingMode: "lightweight",
		...DEFAULT_VOICE_SETTINGS,
	});
	const changed = await controller.update({ cardTrackingMode: "integrated" });

	assert.deepEqual(changed, { cardTrackingMode: "integrated", ...DEFAULT_VOICE_SETTINGS });
	assert.deepEqual(controller.current(), {
		cardTrackingMode: "integrated",
		...DEFAULT_VOICE_SETTINGS,
	});
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		cardTrackingMode: "integrated",
		householdName: "Preserved Household",
	});
});

test("persists voice transcription settings without touching other values", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ householdName: "Preserved Household" }));
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight", ...DEFAULT_VOICE_SETTINGS },
		env: {},
	});

	const changed = await controller.update({
		voiceTranscription: "openrouter",
		voiceModel: " openai/gpt-4o-audio-preview ",
	});

	assert.deepEqual(changed, {
		cardTrackingMode: "lightweight",
		voiceTranscription: "openrouter",
		voiceModel: "openai/gpt-4o-audio-preview",
	});
	assert.deepEqual(controller.current(), changed);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		householdName: "Preserved Household",
		voiceTranscription: "openrouter",
		voiceModel: "openai/gpt-4o-audio-preview",
	});
});

test("rejects invalid voice transcription settings without persisting them", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}\n");
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight", ...DEFAULT_VOICE_SETTINGS },
		env: {},
	});

	await assert.rejects(
		controller.update({ voiceTranscription: "whisper" as never }),
		/Unsupported voice transcription mode/,
	);
	await assert.rejects(
		controller.update({ voiceModel: "   " }),
		/"voiceModel" must be a non-empty string/,
	);
	assert.deepEqual(controller.current(), {
		cardTrackingMode: "lightweight",
		...DEFAULT_VOICE_SETTINGS,
	});
	assert.equal(readFileSync(configPath, "utf8"), "{}\n");
});

test("keeps live application settings unchanged when persistence is rejected", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	const original = JSON.stringify({ cardTrackingMode: "lightweight" });
	writeFileSync(configPath, original);
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight", ...DEFAULT_VOICE_SETTINGS },
		env: { FOLKSUM_CARD_TRACKING_MODE: "lightweight", FOLKSUM_VOICE_MODEL: "locked/model" },
	});

	await assert.rejects(
		controller.update({ cardTrackingMode: "integrated" }),
		/FOLKSUM_CARD_TRACKING_MODE/,
	);
	await assert.rejects(controller.update({ voiceModel: "other/model" }), /FOLKSUM_VOICE_MODEL/);
	assert.deepEqual(controller.current(), {
		cardTrackingMode: "lightweight",
		...DEFAULT_VOICE_SETTINGS,
	});
	assert.equal(readFileSync(configPath, "utf8"), original);
});

test("rejects fields outside the local application-settings boundary", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}\n");
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight", ...DEFAULT_VOICE_SETTINGS },
		env: {},
	});

	await assert.rejects(
		controller.update({ thinkingLevel: "high" } as never),
		/Application setting "thinkingLevel" is not supported/,
	);
	assert.deepEqual(controller.current(), {
		cardTrackingMode: "lightweight",
		...DEFAULT_VOICE_SETTINGS,
	});
	assert.equal(readFileSync(configPath, "utf8"), "{}\n");
});
