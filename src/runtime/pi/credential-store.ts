import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

const DEFAULT_AUTH_DIRECTORY = ".home-wealth-manager";
const DEFAULT_AUTH_FILENAME = "auth.json";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;

type CredentialFile = Record<string, Credential>;

export interface ResolveCredentialPathOptions {
	env?: Readonly<Record<string, string | undefined>>;
	homeDirectory?: string;
	cwd?: string;
}

export interface FileCredentialStoreOptions extends ResolveCredentialPathOptions {
	path?: string;
	lockTimeoutMs?: number;
	lockRetryMs?: number;
	staleLockMs?: number;
}

export class CredentialStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CredentialStoreError";
	}
}

export function resolveCredentialPath(options: ResolveCredentialPathOptions = {}): string {
	const env = options.env ?? process.env;
	const configuredPath = env.HWM_AUTH_PATH;
	if (configuredPath !== undefined) {
		if (!configuredPath.trim()) {
			throw new CredentialStoreError("HWM_AUTH_PATH must not be empty.");
		}
		return resolve(options.cwd ?? process.cwd(), configuredPath.trim());
	}

	return resolve(options.homeDirectory ?? homedir(), DEFAULT_AUTH_DIRECTORY, DEFAULT_AUTH_FILENAME);
}

/**
 * Persistent pi-ai credentials with process-local and adjacent-file locking.
 * The file remains compatible with pi-ai's canonical Record<providerId, Credential> schema.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	private readonly lockPath: string;
	private readonly lockTimeoutMs: number;
	private readonly lockRetryMs: number;
	private readonly staleLockMs: number;
	private readonly secureDefaultDirectory: boolean;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(input: string | FileCredentialStoreOptions = {}) {
		const options = typeof input === "string" ? { path: input } : input;
		this.path = resolve(
			options.path ??
				resolveCredentialPath({
					...(options.env ? { env: options.env } : {}),
					...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
					...(options.cwd ? { cwd: options.cwd } : {}),
				}),
		);
		this.lockPath = `${this.path}.lock`;
		this.lockTimeoutMs = positiveDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
		this.lockRetryMs = positiveDuration(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
		this.staleLockMs = positiveDuration(options.staleLockMs, DEFAULT_STALE_LOCK_MS, "staleLockMs");
		this.secureDefaultDirectory =
			options.path === undefined && (options.env ?? process.env).HWM_AUTH_PATH === undefined;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		assertProviderId(providerId);
		options?.signal?.throwIfAborted();
		const credentials = await this.readFile();
		options?.signal?.throwIfAborted();
		return cloneCredential(credentials[providerId]);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = await this.readFile();
		options?.signal?.throwIfAborted();
		return Object.entries(credentials)
			.map(([providerId, credential]) => ({ providerId, type: credential.type }))
			.sort((left, right) => left.providerId.localeCompare(right.providerId));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		assertProviderId(providerId);
		return this.enqueueMutation(async () => {
			const lock = await this.acquireLock(options?.signal);
			try {
				const credentials = await this.readFile();
				const current = credentials[providerId];
				const next = await fn(cloneCredential(current));
				options?.signal?.throwIfAborted();
				if (next === undefined) return cloneCredential(current);
				assertCredential(next, providerId);
				credentials[providerId] = cloneCredential(next) as Credential;
				await this.writeFile(credentials, lock.assertOwned);
				return cloneCredential(next);
			} finally {
				await lock.release();
			}
		}, options?.signal);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		assertProviderId(providerId);
		return this.enqueueMutation(async () => {
			const lock = await this.acquireLock(options?.signal);
			try {
				const credentials = await this.readFile();
				if (!(providerId in credentials)) return;
				delete credentials[providerId];
				options?.signal?.throwIfAborted();
				await this.writeFile(credentials, lock.assertOwned);
			} finally {
				await lock.release();
			}
		}, options?.signal);
	}

	private enqueueMutation<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const queued = this.mutationTail.catch(() => undefined).then(async () => {
			signal?.throwIfAborted();
			return task();
		});
		this.mutationTail = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private async readFile(): Promise<CredentialFile> {
		if (!(await this.secureExistingCredentialPath())) {
			return Object.create(null) as CredentialFile;
		}
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return Object.create(null) as CredentialFile;
			throw new CredentialStoreError(`Could not read credential file ${this.path}.`, {
				cause: safeCause(error),
			});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(contents) as unknown;
		} catch {
			throw new CredentialStoreError(`Credential file ${this.path} contains invalid JSON.`);
		}
		return parseCredentialFile(parsed, this.path);
	}

	private async writeFile(
		credentials: CredentialFile,
		assertOwned: () => Promise<void>,
	): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await this.secureCredentialDirectory();
		const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		let handle;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await assertOwned();
			await rename(temporaryPath, this.path);
			await chmod(this.path, 0o600);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
			throw new CredentialStoreError(`Could not write credential file ${this.path}.`, {
				cause: safeCause(error),
			});
		}
	}

	private async acquireLock(signal?: AbortSignal): Promise<{
		assertOwned: () => Promise<void>;
		release: () => Promise<void>;
	}> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await this.secureCredentialDirectory();
		const token = randomUUID();
		const startedAt = Date.now();

		while (true) {
			signal?.throwIfAborted();
			let handle;
			try {
				handle = await open(this.lockPath, "wx", 0o600);
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) {
					throw new CredentialStoreError(`Could not acquire credential lock ${this.lockPath}.`, {
						cause: safeCause(error),
					});
				}

				await this.removeStaleLock();
				if (Date.now() - startedAt >= this.lockTimeoutMs) {
					throw new CredentialStoreError(`Timed out waiting for credential lock ${this.lockPath}.`);
				}
				await delay(this.lockRetryMs, undefined, signal ? { signal } : undefined);
				continue;
			}

			try {
				await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), "utf8");
				await handle.sync();
			} catch (error) {
				await handle.close().catch(() => undefined);
				await unlink(this.lockPath).catch(() => undefined);
				throw new CredentialStoreError(`Could not initialize credential lock ${this.lockPath}.`, {
					cause: safeCause(error),
				});
			}
			await handle.close();
			const heartbeat = setInterval(
				() => void this.refreshLock(token),
				Math.max(10, Math.floor(this.staleLockMs / 3)),
			);
			heartbeat.unref();
			return {
				assertOwned: async () => this.assertLockOwnership(token),
				release: async () => {
					clearInterval(heartbeat);
					await this.releaseLock(token);
				},
			};
		}
	}

	private async removeStaleLock(): Promise<void> {
		try {
			const lockStat = await lstat(this.lockPath);
			if (Date.now() - lockStat.mtimeMs <= this.staleLockMs) return;
			let ownerPid: number | undefined;
			try {
				const rawLock = await readFile(this.lockPath, "utf8");
				const lock = JSON.parse(rawLock) as { pid?: unknown };
				if (Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) ownerPid = Number(lock.pid);
			} catch {
				// A malformed abandoned lock can be recovered after the stale threshold.
			}
			if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
			const currentStat = await lstat(this.lockPath);
			if (currentStat.dev !== lockStat.dev || currentStat.ino !== lockStat.ino) return;
			await unlink(this.lockPath);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return;
			throw new CredentialStoreError(`Could not inspect credential lock ${this.lockPath}.`, {
				cause: safeCause(error),
			});
		}
	}

	private async releaseLock(token: string): Promise<void> {
		let rawLock: string;
		try {
			rawLock = await readFile(this.lockPath, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return;
			throw new CredentialStoreError(`Could not release credential lock ${this.lockPath}.`, {
				cause: safeCause(error),
			});
		}

		let lock: { token?: unknown };
		try {
			lock = JSON.parse(rawLock) as { token?: unknown };
		} catch {
			// A malformed or replaced lock is not ours to remove.
			return;
		}
		if (lock.token !== token) return;
		try {
			await unlink(this.lockPath);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return;
			throw new CredentialStoreError(`Could not release credential lock ${this.lockPath}.`, {
				cause: safeCause(error),
			});
		}
	}

	private async assertLockOwnership(token: string): Promise<void> {
		try {
			const rawLock = await readFile(this.lockPath, "utf8");
			const lock = JSON.parse(rawLock) as { token?: unknown };
			if (lock.token === token) {
				const now = new Date();
				await utimes(this.lockPath, now, now);
				return;
			}
		} catch {}
		throw new CredentialStoreError(`Credential lock ownership was lost for ${this.lockPath}.`);
	}

	private async refreshLock(token: string): Promise<void> {
		try {
			const rawLock = await readFile(this.lockPath, "utf8");
			const lock = JSON.parse(rawLock) as { token?: unknown };
			if (lock.token !== token) return;
			const now = new Date();
			await utimes(this.lockPath, now, now);
		} catch {
			// The mutation checks ownership again before replacing the credential file.
		}
	}

	private async secureExistingCredentialPath(): Promise<boolean> {
		let fileStat;
		try {
			fileStat = await lstat(this.path);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return false;
			throw new CredentialStoreError(`Could not inspect credential file ${this.path}.`, {
				cause: safeCause(error),
			});
		}
		if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
			throw new CredentialStoreError(`Credential path ${this.path} must be a regular file.`);
		}
		assertOwnedByCurrentUser(fileStat.uid, this.path);
		if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
			await chmod(this.path, 0o600);
		}
		await this.secureCredentialDirectory();
		return true;
	}

	private async secureCredentialDirectory(): Promise<void> {
		if (!this.secureDefaultDirectory || process.platform === "win32") return;
		const directory = dirname(this.path);
		try {
			const directoryStat = await lstat(directory);
			if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
				throw new CredentialStoreError(`Credential directory ${directory} must be a directory.`);
			}
			assertOwnedByCurrentUser(directoryStat.uid, directory);
			if ((directoryStat.mode & 0o077) !== 0) await chmod(directory, 0o700);
		} catch (error) {
			if (error instanceof CredentialStoreError) throw error;
			throw new CredentialStoreError(`Could not secure credential directory ${directory}.`, {
				cause: safeCause(error),
			});
		}
	}
}

function parseCredentialFile(value: unknown, path: string): CredentialFile {
	if (!isPlainObject(value)) {
		throw new CredentialStoreError(`Credential file ${path} must contain a JSON object.`);
	}
	const credentials = Object.create(null) as CredentialFile;
	for (const [providerId, credential] of Object.entries(value)) {
		assertProviderId(providerId, path);
		assertCredential(credential, providerId, path);
		credentials[providerId] = credential;
	}
	return credentials;
}

function assertCredential(value: unknown, providerId: string, path?: string): asserts value is Credential {
	const location = path ? ` in ${path}` : "";
	if (!isPlainObject(value)) {
		throw new CredentialStoreError(`Credential for provider ${providerId}${location} must be a JSON object.`);
	}
	if (value.type === "api_key") {
		const unknownKey = Object.keys(value).find((key) => !["type", "key", "env"].includes(key));
		if (unknownKey) {
			throw new CredentialStoreError(
				`Credential for provider ${providerId}${location} has unsupported fields.`,
			);
		}
		if (value.key !== undefined && (typeof value.key !== "string" || !value.key)) {
			throw new CredentialStoreError(
				`API key credential for provider ${providerId}${location} has an invalid key.`,
			);
		}
		if (value.env !== undefined) {
			if (!isPlainObject(value.env) || Object.values(value.env).some((item) => typeof item !== "string")) {
				throw new CredentialStoreError(
					`API key credential for provider ${providerId}${location} has invalid environment values.`,
				);
			}
		}
		return;
	}

	if (value.type === "oauth") {
		if (typeof value.refresh !== "string" || !value.refresh) {
			throw new CredentialStoreError(
				`OAuth credential for provider ${providerId}${location} has an invalid refresh token.`,
			);
		}
		if (typeof value.access !== "string" || !value.access) {
			throw new CredentialStoreError(
				`OAuth credential for provider ${providerId}${location} has an invalid access token.`,
			);
		}
		if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) {
			throw new CredentialStoreError(
				`OAuth credential for provider ${providerId}${location} has an invalid expiry.`,
			);
		}
		return;
	}

	throw new CredentialStoreError(`Credential for provider ${providerId}${location} has an unsupported type.`);
}

function assertProviderId(providerId: string, path?: string): void {
	if (typeof providerId !== "string" || !providerId.trim() || providerId !== providerId.trim()) {
		const location = path ? ` in ${path}` : "";
		throw new CredentialStoreError(`Credential provider ID${location} must be a non-empty trimmed string.`);
	}
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
	return credential === undefined ? undefined : structuredClone(credential);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function safeCause(error: unknown): Error | undefined {
	if (!(error instanceof Error)) return undefined;
	let code: string | undefined;
	if ("code" in error && typeof error.code === "string") {
		code = error.code;
	}
	const safe = new Error(code ? `Storage operation failed (${code}).` : "Storage operation failed.");
	if (code) Object.assign(safe, { code });
	return safe;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) {
		throw new CredentialStoreError(`${name} must be a positive number.`);
	}
	return value;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, "ESRCH");
	}
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
	if (process.platform === "win32" || typeof process.getuid !== "function") return;
	if (uid !== process.getuid()) {
		throw new CredentialStoreError(`Credential path ${path} is not owned by the current user.`);
	}
}
