import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createHomeWealthModels, getDefaultPiModel } from "../src/runtime/pi/models.ts";
import { PiRuntimeSettingsController } from "../src/runtime/pi/settings.ts";
import { createRuntimeSettingsTool } from "../src/runtime/pi/settings-tool.ts";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "home-wealth-runtime-settings-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("changes provider with a catalog-valid default model and applies it live", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
			householdName: "Preserved Household",
		}),
	);
	const models = createHomeWealthModels();
	const controller = new PiRuntimeSettingsController({
		models,
		config: {
			configPath,
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
		},
		env: {},
	});
	const applied: Array<{ provider: string; model: string; thinkingLevel: string }> = [];
	controller.attach({
		applyRuntimeSettings(model, thinkingLevel) {
			applied.push({ provider: model.provider, model: model.id, thinkingLevel });
		},
	});

	const expectedDefault = getDefaultPiModel(models, "anthropic");
	const changed = await controller.update({ provider: "anthropic", thinkingLevel: "high" });
	assert.deepEqual(changed, {
		provider: "anthropic",
		model: expectedDefault.id,
		thinkingLevel: "high",
	});
	assert.deepEqual(applied.at(-1), {
		provider: "anthropic",
		model: expectedDefault.id,
		thinkingLevel: "high",
	});
	const nextTurn = controller.prepareNextTurn();
	assert.equal(nextTurn.model?.provider, "anthropic");
	assert.equal(nextTurn.model?.id, expectedDefault.id);
	assert.equal(nextTurn.thinkingLevel, "high");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		provider: "anthropic",
		model: expectedDefault.id,
		thinkingLevel: "high",
		householdName: "Preserved Household",
	});
});

test("rejects a model outside the selected provider without changing state or disk", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	const original = JSON.stringify({ provider: "openai", model: "gpt-4.1", thinkingLevel: "low" });
	writeFileSync(configPath, original);
	const controller = new PiRuntimeSettingsController({
		models: createHomeWealthModels(),
		config: {
			configPath,
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
		},
		env: {},
	});

	await assert.rejects(
		controller.update({ provider: "google", model: "gpt-4.1" }),
		/Model google\/gpt-4\.1 is not available/,
	);
	assert.deepEqual(controller.current(), {
		provider: "openai",
		model: "gpt-4.1",
		thinkingLevel: "low",
	});
	assert.equal(readFileSync(configPath, "utf8"), original);
});

test("does not claim a JSON update when an environment override owns the setting", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "gpt-4.1" }));
	const controller = new PiRuntimeSettingsController({
		models: createHomeWealthModels(),
		config: {
			configPath,
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
		},
		env: { HWM_THINKING_LEVEL: "low" },
	});

	await assert.rejects(controller.update({ thinkingLevel: "medium" }), /HWM_THINKING_LEVEL/);
	assert.equal(controller.current().thinkingLevel, "low");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		provider: "openai",
		model: "gpt-4.1",
	});
});

test("exposes one safe conversational tool for runtime settings only", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "gpt-4.1" }));
	const controller = new PiRuntimeSettingsController({
		models: createHomeWealthModels(),
		config: {
			configPath,
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
		},
		env: {},
	});
	const tool = createRuntimeSettingsTool(controller);
	const schema = tool.parameters as { properties: Record<string, unknown> };
	assert.equal(tool.name, "update_runtime_settings");
	assert.deepEqual(Object.keys(schema.properties).sort(), ["model", "provider", "thinkingLevel"]);

	const result = await tool.execute("settings-call", { thinkingLevel: "medium" });
	assert.deepEqual(result.details, {
		status: "updated",
		settings: { provider: "openai", model: "gpt-4.1", thinkingLevel: "medium" },
	});
	const returnedText = result.content[0];
	assert.equal(returnedText?.type, "text");
	if (returnedText?.type === "text") {
		assert.doesNotMatch(returnedText.text, /credential|api.?key|configPath|auth/i);
	}
});

test("does not switch the active chat to a provider without authentication", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "gpt-4.1" }));
	const controller = new PiRuntimeSettingsController({
		models: createHomeWealthModels(),
		config: {
			configPath,
			provider: "openai",
			model: "gpt-4.1",
			thinkingLevel: "low",
		},
		env: {},
	});
	const tool = createRuntimeSettingsTool(controller);

	await assert.rejects(
		tool.execute("settings-call", { provider: "anthropic" }),
		/Sign in through the local TUI/,
	);
	assert.deepEqual(controller.current(), {
		provider: "openai",
		model: "gpt-4.1",
		thinkingLevel: "low",
	});
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		provider: "openai",
		model: "gpt-4.1",
	});
});
