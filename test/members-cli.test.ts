import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	const directory = mkdtempSync(join(tmpdir(), "folksum-members-cli-"));
	writeFileSync(join(directory, "config.json"), "{}\n", "utf8");
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** Runs the CLI against an isolated config and database inside the directory. */
function runCli(directory: string, args: string[]): CliResult {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--experimental-sqlite", cliPath, ...args],
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH ?? "",
				FOLKSUM_CONFIG_PATH: join(directory, "config.json"),
				FOLKSUM_DB_PATH: join(directory, "wealth.db"),
			},
			encoding: "utf8",
		},
	);
	assert.equal(result.error, undefined);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("members add creates members with default and explicit role and timezone", (context) => {
	const directory = createDirectory(context);

	const withDefaults = runCli(directory, ["members", "add", "--name", "Boyu"]);
	assert.equal(withDefaults.status, 0, withDefaults.stderr);
	const createdDefault = JSON.parse(withDefaults.stdout) as {
		status: string;
		member: { displayName: string; role: string; timezone: string; householdId: string };
	};
	assert.equal(createdDefault.status, "created");
	assert.equal(createdDefault.member.displayName, "Boyu");
	assert.equal(createdDefault.member.role, "member");
	assert.equal(createdDefault.member.timezone, "Asia/Hong_Kong");
	assert.notEqual(createdDefault.member.householdId.length, 0);

	const explicit = runCli(directory, [
		"members",
		"add",
		"--name",
		"Fengmei",
		"--role",
		"viewer",
		"--timezone",
		"Europe/London",
	]);
	assert.equal(explicit.status, 0, explicit.stderr);
	const createdExplicit = JSON.parse(explicit.stdout) as {
		status: string;
		member: { displayName: string; role: string; timezone: string };
	};
	assert.equal(createdExplicit.status, "created");
	assert.equal(createdExplicit.member.role, "viewer");
	assert.equal(createdExplicit.member.timezone, "Europe/London");

	const listed = runCli(directory, ["members"]);
	assert.equal(listed.status, 0, listed.stderr);
	const members = JSON.parse(listed.stdout) as Array<{ displayName: string; role: string }>;
	assert.deepEqual(
		members.map((member) => member.displayName),
		["Local Owner", "Boyu", "Fengmei"],
	);

	// The explicit list action preserves the bare members output.
	const listedExplicit = runCli(directory, ["members", "list"]);
	assert.equal(listedExplicit.status, 0, listedExplicit.stderr);
	assert.deepEqual(JSON.parse(listedExplicit.stdout), members);
});

test("members add rejects missing names, invalid values, and unknown arguments", (context) => {
	const directory = createDirectory(context);

	const rejections: Array<{ args: string[]; pattern: RegExp }> = [
		{ args: ["members", "add"], pattern: /Usage: folksum members/ },
		{ args: ["members", "add", "--role", "member"], pattern: /Usage: folksum members/ },
		{
			args: ["members", "add", "--name", "--role", "member"],
			pattern: /Usage: folksum members/,
		},
		{
			args: ["members", "add", "--name", "X", "--role", "bogus"],
			pattern: /Invalid member role "bogus"/,
		},
		{
			args: ["members", "add", "--name", "X", "--timezone", "Not/AZone"],
			pattern: /Invalid IANA timezone "Not\/AZone"/,
		},
		{
			args: ["members", "add", "--name", "X", "--bogus", "y"],
			pattern: /Usage: folksum members/,
		},
		{ args: ["members", "bogus"], pattern: /Usage: folksum members/ },
		{ args: ["members", "list", "extra"], pattern: /Usage: folksum members/ },
	];
	for (const { args, pattern } of rejections) {
		const result = runCli(directory, args);
		assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
		assert.match(result.stderr, pattern, `stderr for ${args.join(" ")}`);
	}

	// Failed invocations leave the member list untouched.
	const listed = runCli(directory, ["members"]);
	assert.equal(listed.status, 0, listed.stderr);
	const members = JSON.parse(listed.stdout) as Array<{ displayName: string; role: string }>;
	assert.deepEqual(
		members.map((member) => member.displayName),
		["Local Owner"],
	);
});
