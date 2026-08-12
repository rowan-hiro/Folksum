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

test("persists the credit-card tracking mode before applying it live", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({ cardTrackingMode: "lightweight", householdName: "Preserved Household" }),
	);
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight" },
		env: {},
	});

	assert.deepEqual(controller.current(), { cardTrackingMode: "lightweight" });
	const changed = await controller.update({ cardTrackingMode: "integrated" });

	assert.deepEqual(changed, { cardTrackingMode: "integrated" });
	assert.deepEqual(controller.current(), { cardTrackingMode: "integrated" });
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		cardTrackingMode: "integrated",
		householdName: "Preserved Household",
	});
});

test("keeps live application settings unchanged when persistence is rejected", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	const original = JSON.stringify({ cardTrackingMode: "lightweight" });
	writeFileSync(configPath, original);
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight" },
		env: { FOLKSUM_CARD_TRACKING_MODE: "lightweight" },
	});

	await assert.rejects(
		controller.update({ cardTrackingMode: "integrated" }),
		/FOLKSUM_CARD_TRACKING_MODE/,
	);
	assert.deepEqual(controller.current(), { cardTrackingMode: "lightweight" });
	assert.equal(readFileSync(configPath, "utf8"), original);
});

test("rejects fields outside the local application-settings boundary", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}\n");
	const controller = new ApplicationSettingsController({
		config: { configPath, cardTrackingMode: "lightweight" },
		env: {},
	});

	await assert.rejects(
		controller.update({ thinkingLevel: "high" } as never),
		/Application setting "thinkingLevel" is not supported/,
	);
	assert.deepEqual(controller.current(), { cardTrackingMode: "lightweight" });
	assert.equal(readFileSync(configPath, "utf8"), "{}\n");
});
