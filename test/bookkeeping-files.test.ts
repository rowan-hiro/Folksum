import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
	BookkeepingFileError,
	parseBookkeepingProfileFile,
	readBookkeepingProfileFile,
	serializeBookkeepingProfileFile,
	writeBookkeepingExportFile,
	writeBookkeepingProfileFile,
} from "../src/app/bookkeeping-files.ts";
import { BookkeepingProfileService, getDefaultBookkeepingProfile } from "../src/app/bookkeeping-profile.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

const cliPath = resolve(import.meta.dirname, "../src/channels/cli.ts");

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-bookkeeping-files-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("bookkeeping profile files round-trip an expected revision and refuse implicit overwrite", (context) => {
	const directory = createDirectory(context);
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database);
	const identities = new SessionIdentityService(database);
	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "files" });
	const active = new BookkeepingProfileService(database).getActiveProfile(scope.householdId);
	const path = join(directory, "profile.json");

	writeBookkeepingProfileFile(path, active);
	assert.deepEqual(readBookkeepingProfileFile(path), parseBookkeepingProfileFile(serializeBookkeepingProfileFile(active)));
	assert.throws(() => writeBookkeepingProfileFile(path, active), BookkeepingFileError);
	writeBookkeepingProfileFile(path, active, { overwrite: true });
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.throws(
		() => parseBookkeepingProfileFile('{"fileFormatVersion":1,"expectedRevision":0,"profile":{},"extra":true}'),
		/unknown property "extra"/,
	);

	const exportPath = join(directory, "exports", "data.csv");
	writeBookkeepingExportFile(exportPath, { content: "Amount\n12.30\n" });
	assert.equal(readFileSync(exportPath, "utf8"), "Amount\n12.30\n");
});

test("bookkeeping profile and export CLI commands apply revisioned files and write deterministic output", (context) => {
	const directory = createDirectory(context);
	const databasePath = join(directory, "wealth.db");
	const configPath = join(directory, "config.json");
	const profilePath = join(directory, "profile.json");
	const exportPath = join(directory, "ledger.json");
	writeFileSync(
		configPath,
		JSON.stringify({ databasePath, baseCurrency: "HKD", cliIdentity: "owner", session: "files" }),
	);
	const environment = cleanFolksumEnvironment();
	environment.FOLKSUM_CONFIG_PATH = configPath;

	const initial = runCli(directory, environment, ["profile"]);
	assert.equal(initial.status, 0, initial.stderr);
	const initialDocument = parseBookkeepingProfileFile(initial.stdout);
	assert.equal(initialDocument.expectedRevision, 0);
	const profile = getDefaultBookkeepingProfile();
	writeFileSync(
		profilePath,
		JSON.stringify(
			{
				fileFormatVersion: 1,
				expectedRevision: 0,
				profile: {
					...profile,
					exportProfiles: [
						{
							id: "simple.json",
							label: "Simple JSON",
							format: "json",
							rowMode: "transactions",
							reversals: "include",
							amountSign: "debit-positive",
							columns: [
								{ header: "date", source: "transaction.date" },
								{ header: "description", source: "transaction.description" },
							],
						},
					],
				},
			},
			null,
			"\t",
		),
	);
	const applied = runCli(directory, environment, ["profile", "apply", profilePath]);
	assert.equal(applied.status, 0, applied.stderr);
	assert.deepEqual(JSON.parse(applied.stdout), {
		status: "activated",
		revision: 1,
		profileHash: JSON.parse(applied.stdout).profileHash,
	});

	const database = new WealthDatabase(databasePath);
	const wealth = new WealthService(database);
	const cash = wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = wealth.createAccount({ name: "Dining", type: "expense" });
	wealth.recordExpense({
		description: "CLI lunch",
		amount: "23.40",
		expenseAccountId: dining.id,
		fundingAccountId: cash.id,
		occurredAt: "2026-08-12",
	});
	database.close();

	const exported = runCli(directory, environment, [
		"export",
		"simple.json",
		"2026-08-12",
		"2026-08-12",
		exportPath,
	]);
	assert.equal(exported.status, 0, exported.stderr);
	assert.deepEqual(JSON.parse(readFileSync(exportPath, "utf8")), [
		{ date: "2026-08-12", description: "CLI lunch" },
	]);

	const refused = runCli(directory, environment, [
		"export",
		"simple.json",
		"2026-08-12",
		"2026-08-12",
		exportPath,
	]);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /Could not create/);
	const replaced = runCli(directory, environment, [
		"export",
		"simple.json",
		"2026-08-12",
		"2026-08-12",
		exportPath,
		"--force",
	]);
	assert.equal(replaced.status, 0, replaced.stderr);
});

function cleanFolksumEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("FOLKSUM_")),
	) as NodeJS.ProcessEnv;
}

function runCli(directory: string, env: NodeJS.ProcessEnv, args: string[]) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", "--experimental-sqlite", cliPath, ...args],
		{ cwd: directory, env, encoding: "utf8", timeout: 10_000 },
	);
}
