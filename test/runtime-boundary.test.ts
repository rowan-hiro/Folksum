import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url).pathname;

test("declares published Pi packages instead of local checkout dependencies", () => {
	const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	};
	assert.equal(packageJson.dependencies["@earendil-works/pi-agent-core"], "0.84.1");
	assert.equal(packageJson.dependencies["@earendil-works/pi-ai"], "0.84.1");
	for (const version of Object.values(packageJson.dependencies)) {
		assert.doesNotMatch(version, /^(?:file|link):|\/pi\//);
	}
});

test("isolates Pi imports to the runtime adapter and never imports the checkout", () => {
	for (const file of listTypeScriptFiles(join(projectRoot, "src"))) {
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+pi\//, file);
		if (!file.includes(`${join("runtime", "pi")}/`)) {
			assert.doesNotMatch(source, /from\s+["']@earendil-works\//, file);
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

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (path.endsWith(".ts")) files.push(path);
	}
	return files;
}
