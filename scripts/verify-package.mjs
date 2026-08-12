import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "folksum-package-"));
const commandTimeout = parseTimeout(process.env.FOLKSUM_PACKAGE_VERIFY_TIMEOUT_MS);
const externalDependencies = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
	"@grammyjs/runner",
	"grammy",
];

const expectedDependencyVersions = {
	"@earendil-works/pi-agent-core": "0.84.1",
	"@earendil-works/pi-ai": "0.84.1",
	"@earendil-works/pi-tui": "0.84.1",
	"@grammyjs/runner": "2.0.3",
	grammy: "1.45.1",
};

try {
	const packDirectory = join(workspace, "pack");
	const cacheDirectory = process.env.FOLKSUM_PACKAGE_VERIFY_NPM_CACHE
		? resolve(process.env.FOLKSUM_PACKAGE_VERIFY_NPM_CACHE)
		: join(workspace, "npm-cache");
	mkdirSync(packDirectory);

	const packOutput = runNpm(
		[
			"pack",
			"--json",
			"--silent",
			"--pack-destination",
			packDirectory,
			"--cache",
			cacheDirectory,
		],
		projectRoot,
	);
	const packResult = parsePackResult(packOutput);
	assert.equal(packResult.length, 1, "npm pack must produce exactly one package");
	const artifact = packResult[0];
	assert.ok(artifact, "npm pack did not describe its artifact");
	assert.equal(artifact.name, "folksum");
	assert.equal(artifact.filename, `folksum-${artifact.version}.tgz`);
	assert.deepEqual(artifact.bundled ?? [], [], "runtime dependencies must not be bundled");

	const packagedPaths = artifact.files.map((file) => file.path);
	for (const requiredPath of [
		"LICENSE",
		"README.md",
		"config.example.json",
		"telegram.example.json",
		"dist/channels/cli.js",
		"package.json",
	]) {
		assert.ok(packagedPaths.includes(requiredPath), `package is missing ${requiredPath}`);
	}
	for (const path of packagedPaths) {
		assert.match(
			path,
			/^(?:LICENSE|README\.md|config\.example\.json|telegram\.example\.json|package\.json|dist\/.*\.js)$/,
			`unexpected package entry: ${path}`,
		);
		assert.doesNotMatch(
			path,
			/(?:^|\/)(?:node_modules|src|test|\.data|\.intent-log|\.decision-log)(?:\/|$)|(?:^|\/)(?:auth\.json|\.env)$|\.db(?:-shm|-wal)?$|\.tsx?$/,
			`development, dependency, or sensitive file leaked into package: ${path}`,
		);
	}
	const cliEntry = artifact.files.find((file) => file.path === "dist/channels/cli.js");
	assert.ok(cliEntry, "package is missing its CLI entry");
	if (process.platform !== "win32") {
		assert.ok((cliEntry.mode & 0o111) !== 0, "packaged CLI must be executable");
	}

	const tarballPath = join(packDirectory, artifact.filename);
	assert.ok(existsSync(tarballPath), `npm pack did not create ${tarballPath}`);

	const installDirectory = join(workspace, "install");
	mkdirSync(installDirectory);
	runNpm(
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
			"--cache",
			cacheDirectory,
			tarballPath,
		],
		installDirectory,
	);

	const packageDirectory = join(installDirectory, "node_modules", "folksum");
	const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	assert.equal(manifest.name, "folksum");
	assert.equal(manifest.private, undefined, "publishable manifest must not be private");
	assert.equal(manifest.bin?.folksum, "dist/channels/cli.js");
	assert.deepEqual(manifest.files, ["dist", "config.example.json", "telegram.example.json", "README.md"]);
	assert.equal(manifest.engines?.node, ">=22.19.0");
	assert.equal(manifest.bundleDependencies, undefined);
	assert.equal(manifest.bundledDependencies, undefined);
	for (const dependency of externalDependencies) {
		assert.equal(manifest.dependencies?.[dependency], expectedDependencyVersions[dependency]);
	}
	for (const lifecycle of ["install", "postinstall", "prepare"]) {
		assert.equal(manifest.scripts?.[lifecycle], undefined, `consumer lifecycle ${lifecycle} is not allowed`);
	}

	const compiledFiles = listFiles(join(packageDirectory, "dist")).filter((path) => path.endsWith(".js"));
	const compiledSource = compiledFiles.map((path) => readFileSync(path, "utf8")).join("\n");
	assert.doesNotMatch(
		compiledSource,
		/(?:from\s+|import\s*\()(["'])\.{1,2}\/[^"']+\.(?:ts|tsx|mts|cts)\1/,
		"compiled output contains a relative TypeScript import",
	);
	assert.match(compiledSource, /Folksum/, "compiled output is missing the product identity");
	assert.match(
		compiledSource,
		/Financial Intelligence & Record Engine/,
		"compiled output is missing the product tagline",
	);
	assert.doesNotMatch(
		compiledSource,
		/(?:hearthworth|home[-_ ]?wealth|hwm_|\.home-wealth-manager)/i,
		"compiled output contains the retired product identity",
	);
	for (const dependency of externalDependencies) {
		assert.match(
			compiledSource,
			new RegExp(`from\\s+["']${escapeRegExp(dependency)}(?:/[^"']*)?["']`),
			`${dependency} is not preserved as a bare external import`,
		);
		assert.equal(
			resolveInstalledPackageVersion(installDirectory, dependency),
			expectedDependencyVersions[dependency],
		);
	}

	const localExecutable = join(
		installDirectory,
		"node_modules",
		".bin",
		process.platform === "win32" ? "folksum.cmd" : "folksum",
	);
	assert.ok(existsSync(localExecutable), "local npm install did not create the CLI executable");

	const globalPrefix = join(workspace, "global");
	runNpm(
		[
			"install",
			"--global",
			"--prefix",
			globalPrefix,
			"--no-audit",
			"--no-fund",
			"--cache",
			cacheDirectory,
			tarballPath,
		],
		workspace,
	);
	const globalExecutable =
		process.platform === "win32"
			? join(globalPrefix, "folksum.cmd")
			: join(globalPrefix, "bin", "folksum");
	assert.ok(existsSync(globalExecutable), "global npm install did not create the CLI executable");
	const globalPackageDirectory =
		process.platform === "win32"
			? join(globalPrefix, "node_modules", "folksum")
			: join(globalPrefix, "lib", "node_modules", "folksum");
	assert.ok(existsSync(globalPackageDirectory), "global npm install did not install the package");

	const smokeDirectory = join(workspace, "smoke");
	mkdirSync(smokeDirectory);
	const databasePath = join(smokeDirectory, "wealth.db");
	const authPath = join(smokeDirectory, "auth.json");
	const environment = cleanRuntimeEnvironment();
	environment.FOLKSUM_DB_PATH = databasePath;
	environment.FOLKSUM_AUTH_PATH = authPath;
	environment.FOLKSUM_TIMEZONE = "UTC";

	const reminders = run(globalExecutable, ["reminders"], smokeDirectory, environment);
	assert.match(reminders, /No credit-card repayments/);
	const members = JSON.parse(run(globalExecutable, ["members"], smokeDirectory, environment));
	assert.equal(members.length, 1);
	assert.equal(members[0]?.role, "owner");
	const schedule = run(globalExecutable, ["schedule"], smokeDirectory, environment);
	const scheduleResult = JSON.parse(schedule);
	assert.equal(scheduleResult.statementsEvaluated, 0);
	assert.deepEqual(scheduleResult.notifications, []);
	assert.ok(existsSync(databasePath), "installed CLI did not initialize its configured database");
	assert.equal(existsSync(authPath), false, "local-only commands must not create a credential file");
	assert.equal(
		existsSync(join(globalPackageDirectory, ".data")),
		false,
		"installed CLI wrote application data into its package directory",
	);

	const defaultDataDirectory = join(workspace, "default-data");
	mkdirSync(defaultDataDirectory);
	const defaultEnvironment = cleanRuntimeEnvironment();
	defaultEnvironment.FOLKSUM_AUTH_PATH = join(defaultDataDirectory, "auth.json");
	defaultEnvironment.FOLKSUM_TIMEZONE = "UTC";
	const defaultReminders = run(
		globalExecutable,
		["reminders"],
		defaultDataDirectory,
		defaultEnvironment,
	);
	assert.match(defaultReminders, /No credit-card repayments/);
	assert.ok(
		existsSync(join(defaultDataDirectory, ".data", "wealth.db")),
		"default database was not created relative to the command working directory",
	);

	console.log(
		`Verified ${artifact.filename}: ${packagedPaths.length} files, external Pi dependencies, and installed CLI smoke tests.`,
	);
} finally {
	rmSync(workspace, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}

function runNpm(arguments_, cwd) {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath) return run(process.execPath, [npmExecPath, ...arguments_], cwd, process.env);
	return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, cwd, process.env);
}

function run(command, arguments_, cwd, env) {
	const result = spawnSync(command, arguments_, {
		cwd,
		encoding: "utf8",
		env,
		shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
		timeout: commandTimeout,
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		[`Command failed: ${command} ${arguments_.join(" ")}`, result.stdout, result.stderr]
			.filter(Boolean)
			.join("\n"),
	);
	return result.stdout;
}

function parsePackResult(output) {
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	assert.ok(start >= 0 && end >= start, `npm pack did not return JSON:\n${output}`);
	return JSON.parse(output.slice(start, end + 1));
}

function listFiles(directory) {
	const files = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

function resolveInstalledPackageVersion(installDirectory, dependency) {
	const manifestPath = join(
		installDirectory,
		"node_modules",
		...dependency.split("/"),
		"package.json",
	);
	assert.ok(existsSync(manifestPath), `${dependency} was not installed as an external dependency`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.name, dependency);
	return manifest.version;
}

function cleanRuntimeEnvironment() {
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	for (const key of Object.keys(environment)) {
		if (
			key.startsWith("FOLKSUM_") ||
			/^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|KIMI|MOONSHOT|AWS)_/.test(key)
		) {
			delete environment[key];
		}
	}
	return environment;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTimeout(value) {
	if (value === undefined) return 300_000;
	const timeout = Number(value);
	assert.ok(Number.isSafeInteger(timeout) && timeout > 0, "FOLKSUM_PACKAGE_VERIFY_TIMEOUT_MS must be a positive integer");
	return timeout;
}
