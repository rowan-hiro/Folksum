import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	CredentialStoreError,
	FileCredentialStore,
	resolveCredentialPath,
} from "../src/runtime/pi/credential-store.ts";
import {
	createHomeWealthModels,
	DEFAULT_PI_MODELS,
	getDefaultPiModel,
	SUPPORTED_PI_PROVIDERS,
} from "../src/runtime/pi/models.ts";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "home-wealth-auth-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("resolves the default auth path and HWM_AUTH_PATH override", (context) => {
	const directory = createDirectory(context);
	assert.equal(
		resolveCredentialPath({ homeDirectory: directory, env: {} }),
		join(directory, ".home-wealth-manager", "auth.json"),
	);
	assert.equal(
		resolveCredentialPath({ cwd: directory, env: { HWM_AUTH_PATH: "private/credentials.json" } }),
		join(directory, "private", "credentials.json"),
	);
	assert.throws(() => resolveCredentialPath({ env: { HWM_AUTH_PATH: " " } }), CredentialStoreError);
});

test("persists credentials atomically with private permissions", async (context) => {
	const directory = createDirectory(context);
	const authDirectory = join(directory, ".home-wealth-manager");
	const authPath = join(authDirectory, "auth.json");
	const store = new FileCredentialStore(authPath);

	await store.modify("openai", async () => ({ type: "api_key", key: "test-secret" }));

	assert.deepEqual(await store.read("openai"), { type: "api_key", key: "test-secret" });
	assert.equal(existsSync(`${authPath}.lock`), false);
	assert.deepEqual(
		JSON.parse(readFileSync(authPath, "utf8")),
		{ openai: { type: "api_key", key: "test-secret" } },
	);
	if (process.platform !== "win32") {
		assert.equal(statSync(authDirectory).mode & 0o777, 0o700);
		assert.equal(statSync(authPath).mode & 0o777, 0o600);
	}
});

test("serializes concurrent mutations without losing updates", async (context) => {
	const authPath = join(createDirectory(context), "auth.json");
	const firstStore = new FileCredentialStore(authPath);
	const secondStore = new FileCredentialStore(authPath);
	let releaseFirst: (() => void) | undefined;
	const firstCanFinish = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted: (() => void) | undefined;
	const firstDidStart = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});

	const first = firstStore.modify("openai", async () => {
		firstStarted?.();
		await firstCanFinish;
		return { type: "api_key", key: "openai-secret" };
	});
	await firstDidStart;
	const second = secondStore.modify("anthropic", async () => ({
		type: "api_key",
		key: "anthropic-secret",
	}));
	releaseFirst?.();
	await Promise.all([first, second]);

	assert.deepEqual(await firstStore.list(), [
		{ providerId: "anthropic", type: "api_key" },
		{ providerId: "openai", type: "api_key" },
	]);
	assert.deepEqual(await firstStore.read("anthropic"), {
		type: "api_key",
		key: "anthropic-secret",
	});
});

test("list exposes only metadata and delete removes one provider", async (context) => {
	const store = new FileCredentialStore(join(createDirectory(context), "auth.json"));
	await store.modify("openai", async () => ({ type: "api_key", key: "never-list-this" }));
	await store.modify("openai-codex", async () => ({
		type: "oauth",
		refresh: "refresh-secret",
		access: "access-secret",
		expires: 1_900_000_000_000,
	}));

	const listed = await store.list();
	assert.deepEqual(listed, [
		{ providerId: "openai", type: "api_key" },
		{ providerId: "openai-codex", type: "oauth" },
	]);
	assert.doesNotMatch(JSON.stringify(listed), /never-list-this|refresh-secret|access-secret/);

	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
	assert.equal((await store.read("openai-codex"))?.type, "oauth");
});

test("rejects malformed JSON and invalid credential shapes without exposing secrets", async (context) => {
	const directory = createDirectory(context);
	const authPath = join(directory, "auth.json");
	writeFileSync(authPath, "{not-json");
	const store = new FileCredentialStore(authPath);
	await assert.rejects(store.list(), /contains invalid JSON/);

	writeFileSync(
		authPath,
		JSON.stringify({ openai: { type: "api_key", key: 42, secretValue: "must-not-leak" } }),
	);
	await assert.rejects(store.read("openai"), (error: unknown) => {
		assert.ok(error instanceof CredentialStoreError);
		assert.doesNotMatch(error.message, /must-not-leak/);
		return true;
	});
});

test("repairs existing auth file permissions before reading secrets", async (context) => {
	if (process.platform === "win32") context.skip("POSIX permission bits are not available on Windows.");
	const directory = createDirectory(context);
	const authPath = join(directory, "auth.json");
	writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "old-secret" } }));
	chmodSync(authPath, 0o644);
	const store = new FileCredentialStore(authPath);

	assert.deepEqual(await store.read("openai"), { type: "api_key", key: "old-secret" });
	assert.equal(statSync(authPath).mode & 0o777, 0o600);
});

test("repairs the default credential directory before reading secrets", async (context) => {
	if (process.platform === "win32") context.skip("POSIX permission bits are not available on Windows.");
	const directory = createDirectory(context);
	const authDirectory = join(directory, ".home-wealth-manager");
	const authPath = join(authDirectory, "auth.json");
	mkdirSync(authDirectory, { mode: 0o755 });
	writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "old-secret" } }));
	chmodSync(authPath, 0o644);
	const store = new FileCredentialStore({ homeDirectory: directory, env: {} });

	await store.read("openai");
	assert.equal(statSync(authDirectory).mode & 0o777, 0o700);
	assert.equal(statSync(authPath).mode & 0o777, 0o600);
});

test("recovers an abandoned stale lock before writing", async (context) => {
	const directory = createDirectory(context);
	const authPath = join(directory, "auth.json");
	const lockPath = `${authPath}.lock`;
	writeFileSync(lockPath, JSON.stringify({ token: "abandoned" }));
	const staleTime = new Date(Date.now() - 60_000);
	utimesSync(lockPath, staleTime, staleTime);
	const store = new FileCredentialStore({
		path: authPath,
		lockTimeoutMs: 250,
		lockRetryMs: 5,
		staleLockMs: 50,
	});

	await store.modify("google", async () => ({ type: "api_key", key: "google-secret" }));
	assert.deepEqual(await store.list(), [{ providerId: "google", type: "api_key" }]);
	assert.equal(existsSync(lockPath), false);
});

test("does not steal a stale-looking lock from a live process", async (context) => {
	const directory = createDirectory(context);
	const authPath = join(directory, "auth.json");
	const lockPath = `${authPath}.lock`;
	writeFileSync(lockPath, JSON.stringify({ token: "paused-owner", pid: process.pid }));
	const staleTime = new Date(Date.now() - 60_000);
	utimesSync(lockPath, staleTime, staleTime);
	const store = new FileCredentialStore({
		path: authPath,
		lockTimeoutMs: 30,
		lockRetryMs: 5,
		staleLockMs: 10,
	});

	await assert.rejects(
		store.modify("openai", async () => ({ type: "api_key", key: "new-secret" })),
		/Timed out waiting for credential lock/,
	);
	assert.equal(existsSync(lockPath), true);
});

test("shared model registry installs exactly the supported providers", () => {
	const models = createHomeWealthModels();
	assert.deepEqual(
		models.getProviders().map((provider) => provider.id),
		[...SUPPORTED_PI_PROVIDERS],
	);
	for (const provider of SUPPORTED_PI_PROVIDERS) {
		assert.equal(getDefaultPiModel(models, provider).id, DEFAULT_PI_MODELS[provider]);
	}

	const kimi = models.getProvider("kimi-coding");
	assert.equal(kimi?.auth.apiKey?.name, "Kimi API key");
	assert.equal(kimi?.auth.oauth?.loginLabel, "Sign in with Kimi Code");
	assert.equal(kimi?.auth.oauth?.isSubscription, true);
	assert.equal(getDefaultPiModel(models, "kimi-coding").id, "kimi-for-coding");
});
