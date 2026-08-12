import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectPersistableAgentMessage } from "../src/runtime/pi/runtime.ts";
import { buildFinanceSystemPrompt } from "../src/runtime/pi/system-prompt.ts";

const projectRoot = new URL("..", import.meta.url).pathname;

test("declares published Pi packages instead of local checkout dependencies", () => {
	const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	};
	assert.equal(packageJson.dependencies["@earendil-works/pi-agent-core"], "0.84.1");
	assert.equal(packageJson.dependencies["@earendil-works/pi-ai"], "0.84.1");
	assert.equal(packageJson.dependencies["@earendil-works/pi-tui"], "0.84.1");
	for (const version of Object.values(packageJson.dependencies)) {
		assert.doesNotMatch(version, /^(?:file|link):|\/pi\//);
	}
});

test("isolates Pi model imports to the runtime adapter and Pi TUI imports to its channel", () => {
	for (const file of listTypeScriptFiles(join(projectRoot, "src"))) {
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+pi\//, file);
		const isRuntimeAdapter = file.includes(`${join("runtime", "pi")}/`);
		const isTuiChannel = file.includes(`${join("channels", "tui")}`);
		if (!isRuntimeAdapter && !isTuiChannel) {
			assert.doesNotMatch(source, /from\s+["']@earendil-works\//, file);
		}
		if (isTuiChannel) {
			assert.doesNotMatch(
				source,
				/from\s+["']@earendil-works\/(?:pi-ai|pi-agent-core)/,
				file,
			);
		}
	}
});

test("exposes the documented finance tool surface through the Pi adapter", () => {
	const source = readFileSync(join(projectRoot, "src/runtime/pi/tools.ts"), "utf8");
	const expectedTools = [
		"create_account",
		"list_accounts",
		"record_expense",
		"record_income",
		"record_transfer",
		"reverse_transaction",
		"list_transactions",
		"record_card_statement",
		"record_card_payment",
		"list_card_reminders",
		"register_asset",
		"record_asset_valuation",
		"get_net_worth",
		"get_spending_summary",
	];
	for (const tool of expectedTools) assert.match(source, new RegExp(`name: ["']${tool}["']`));
	assert.doesNotMatch(source, /name: ["'](?:bash|read|write|edit)["']/);
});

test("tells the model the active card mode without granting settings authority", () => {
	const scope = {
		householdId: "household-1",
		actorId: "member-1",
		sessionId: "session-1",
		channel: "cli" as const,
		role: "owner" as const,
		timezone: "Asia/Hong_Kong",
	};
	const lightweight = buildFinanceSystemPrompt(scope, "2026-08-12", "lightweight");
	const integrated = buildFinanceSystemPrompt(scope, "2026-08-12", "integrated");

	assert.match(lightweight, /credit-card tracking mode: lightweight/);
	assert.match(lightweight, /statements and repayments are standalone reminders/);
	assert.match(integrated, /credit-card tracking mode: integrated/);
	assert.match(integrated, /card purchases and statement repayments use ledger accounts/);
	assert.match(lightweight, /update_runtime_settings only.*provider, model, or thinking level/);
});

test("projects provider messages onto a persistence-safe allowlist", () => {
	const assistant = projectPersistableAgentMessage({
		role: "assistant",
		content: [{ type: "text", text: "Safe response" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4.1",
		usage: {},
		stopReason: "error",
		timestamp: 1,
		errorMessage: 'token endpoint returned {"access_token":"must-not-persist"}',
		diagnostics: [{ message: "refresh-secret-must-not-persist" }],
		responseId: "opaque-provider-response-id",
		deferred: {
			provider: "openai",
			modelId: "gpt-4.1",
			api: "openai-responses",
			id: "provider-secret-must-not-persist",
		},
	} as never);
	const toolResult = projectPersistableAgentMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "safe_tool",
		content: [{ type: "text", text: "Safe tool result" }],
		details: { upstreamCredential: "must-not-persist" },
		isError: false,
		timestamp: 2,
	} as never);

	assert.deepEqual(Object.keys(assistant).sort(), [
		"api",
		"content",
		"model",
		"provider",
		"role",
		"stopReason",
		"timestamp",
		"usage",
	]);
	assert.doesNotMatch(
		JSON.stringify([assistant, toolResult]),
		/must-not-persist|refresh-secret|response-id|diagnostics|errorMessage|deferred|details/,
	);
});

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (path.endsWith(".ts")) files.push(path);
	}
	return files;
}
