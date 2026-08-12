import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Terminal } from "@earendil-works/pi-tui";

import { loadApplicationConfig } from "../src/app/config.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import {
	containsLikelyCredential,
	formatAuthStatus,
	runHomeWealthTui,
	sanitizeTerminalText,
	SecretInput,
} from "../src/channels/tui.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";
import { FileCredentialStore } from "../src/runtime/pi/credential-store.ts";
import { createHomeWealthModels } from "../src/runtime/pi/models.ts";
import type { PiRuntimeAdapter } from "../src/runtime/pi/runtime.ts";
import { PiRuntimeSettingsController } from "../src/runtime/pi/settings.ts";

class FakeTerminal implements Terminal {
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;
	started = false;
	stopped = false;
	drained = false;
	output = "";
	private onInput: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.onInput = onInput;
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
	}

	async drainInput(): Promise<void> {
		this.drained = true;
	}

	send(data: string): void {
		this.onInput?.(data);
	}

	write(data: string): void {
		this.output += data;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "home-wealth-tui-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("masks secret input without changing the submitted value", () => {
	const input = new SecretInput();
	const secret = "sk-proj-this-must-never-be-rendered";
	input.focused = true;
	input.handleInput(secret);

	const rendered = input.render(80).join("\n");
	assert.doesNotMatch(rendered, /sk-proj|this-must-never-be-rendered/);
	assert.match(rendered, /•/u);
	assert.equal(input.getValue(), secret);
});

test("blocks common provider credential shapes and redacts auth status text", () => {
	assert.equal(containsLikelyCredential("sk-ant-api03-abcdefghijklmnop"), true);
	assert.equal(containsLikelyCredential("AIzaSyABCDEFGHIJKLMNOPQRSTUV"), true);
	assert.equal(containsLikelyCredential("Record lunch for HKD 38.50"), false);

	const formatted = formatAuthStatus({
		type: "api_key",
		source: "sk-proj-this-must-never-be-rendered\u001b[31m",
	});
	assert.equal(formatted, "api_key via [credential redacted]");
	assert.doesNotMatch(formatted, /sk-proj|this-must-never-be-rendered|\u001b/);
});

test("removes terminal control sequences from untrusted transcript text", () => {
	const malicious = "safe\u001b]52;c;Y2xpcGJvYXJkLXNlY3JldA==\u0007 text\u001b[31m red\u001b[0m";
	const sanitized = sanitizeTerminalText(malicious, 1_000);

	assert.equal(sanitized, "safe text red");
	assert.doesNotMatch(sanitized, /52;c|Y2xpcGJvYXJk|\u001b|\u0007/);
});

test("starts and restores the terminal without requiring model credentials", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}\n");
	const config = loadApplicationConfig({
		cwd: directory,
		env: { HWM_CONFIG_PATH: configPath },
	});
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({
		channel: "cli",
		externalId: "owner",
		conversationKey: "tui-test",
	});
	const models = createHomeWealthModels();
	const settingsController = new PiRuntimeSettingsController({ models, config, env: {} });
	const terminal = new FakeTerminal();

	const running = runHomeWealthTui({
		wealth,
		identities,
		scope,
		database,
		currentDate: "2026-08-12",
		config,
		models,
		settingsController,
		terminal,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	terminal.send("\u0003");
	await running;

	assert.equal(terminal.started, true);
	assert.equal(terminal.drained, true);
	assert.equal(terminal.stopped, true);
});

test("occupies the prompt operation before asynchronous runtime setup", async (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, '{"provider":"openai","model":"gpt-4.1"}\n');
	const config = loadApplicationConfig({
		cwd: directory,
		env: { HWM_CONFIG_PATH: configPath },
	});
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({
		channel: "cli",
		externalId: "owner",
		conversationKey: "prompt-race-test",
	});
	const credentialStore = new FileCredentialStore(join(directory, "auth.json"));
	await credentialStore.modify("openai", async () => ({
		type: "api_key",
		key: "test-only-key",
	}));
	const models = createHomeWealthModels({ credentials: credentialStore });
	const settingsController = new PiRuntimeSettingsController({ models, config, env: {} });
	const terminal = new FakeTerminal();
	let releaseRuntime: (() => void) | undefined;
	const runtimeCanFinish = new Promise<void>((resolve) => {
		releaseRuntime = resolve;
	});
	let promptStarted: (() => void) | undefined;
	const didStartPrompt = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	let factoryCalls = 0;
	let promptCalls = 0;
	const runtime = {
		async prompt(_text: string, onText?: (delta: string) => void): Promise<void> {
			promptCalls += 1;
			promptStarted?.();
			onText?.("Done.");
		},
		abort(): void {},
		confirm(): never {
			throw new Error("No confirmation was expected.");
		},
		reject(): void {},
	} as unknown as PiRuntimeAdapter;

	const running = runHomeWealthTui({
		wealth,
		identities,
		scope,
		database,
		currentDate: "2026-08-12",
		config,
		models,
		settingsController,
		terminal,
		runtimeFactory: async () => {
			factoryCalls += 1;
			await runtimeCanFinish;
			return runtime;
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	terminal.send("first request");
	terminal.send("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	terminal.send("second request");
	terminal.send("\r");
	for (let attempt = 0; attempt < 100 && factoryCalls === 0; attempt += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}

	assert.equal(factoryCalls, 1);
	releaseRuntime?.();
	await didStartPrompt;
	await new Promise<void>((resolve) => setImmediate(resolve));
	terminal.send("\u0003");
	await running;

	assert.equal(factoryCalls, 1);
	assert.equal(promptCalls, 1);
});
