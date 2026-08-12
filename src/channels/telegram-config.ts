import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_TELEGRAM_CONFIG_PATH = ".data/telegram.json";
const ROOT_KEYS = new Set(["version", "allowedChats", "identities"]);
const CHAT_KEYS = new Set(["chatId", "threadId"]);
const IDENTITY_KEYS = new Set(["userId", "memberId", "reminderDestination"]);

export interface TelegramConversationAddress {
	chatId: string;
	threadId?: string;
}

export interface TelegramIdentityConfig {
	userId: string;
	memberId: string;
	reminderDestination?: TelegramConversationAddress;
}

export interface TelegramChannelConfig {
	configPath: string;
	botToken: string;
	allowedChats: TelegramConversationAddress[];
	identities: TelegramIdentityConfig[];
}

export interface LoadTelegramConfigOptions {
	cwd?: string;
	env?: Readonly<Record<string, string | undefined>>;
	platform?: NodeJS.Platform;
}

export class TelegramConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TelegramConfigError";
	}
}

export function loadTelegramConfig(options: LoadTelegramConfigOptions = {}): TelegramChannelConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const configuredPath = env.FOLKSUM_TELEGRAM_CONFIG_PATH;
	if (configuredPath !== undefined && !configuredPath.trim()) {
		throw new TelegramConfigError("FOLKSUM_TELEGRAM_CONFIG_PATH must not be empty.");
	}
	const configPath = resolve(cwd, configuredPath?.trim() ?? DEFAULT_TELEGRAM_CONFIG_PATH);
	const botToken = requireBotToken(env.FOLKSUM_TELEGRAM_BOT_TOKEN);
	const file = readPrivateJson(configPath, options.platform ?? process.platform);
	assertOnlyKeys(file, ROOT_KEYS, "Telegram configuration");
	if (file.version !== 1) throw new TelegramConfigError("Telegram configuration version must be 1.");

	const allowedChats = parseAllowedChats(file.allowedChats);
	const allowedKeys = new Set(allowedChats.map(conversationAddressKey));
	const identities = parseIdentities(file.identities, allowedKeys);

	return { configPath, botToken, allowedChats, identities };
}

export function telegramConversationKey(address: TelegramConversationAddress): string {
	return `${address.chatId}:${address.threadId ?? "root"}`;
}

export function isAllowedTelegramConversation(
	config: Pick<TelegramChannelConfig, "allowedChats">,
	address: TelegramConversationAddress,
): boolean {
	const key = conversationAddressKey(address);
	return config.allowedChats.some((candidate) => conversationAddressKey(candidate) === key);
}

export function findTelegramIdentity(
	config: Pick<TelegramChannelConfig, "identities">,
	userId: string,
): TelegramIdentityConfig | undefined {
	return config.identities.find((identity) => identity.userId === userId);
}

function readPrivateJson(path: string, platform: NodeJS.Platform): Record<string, unknown> {
	let stats;
	try {
		stats = lstatSync(path);
	} catch {
		throw new TelegramConfigError(`Telegram configuration file was not found at ${path}.`);
	}
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new TelegramConfigError(`Telegram configuration path ${path} must be a regular file.`);
	}
	if (platform !== "win32" && (stats.mode & 0o077) !== 0) {
		throw new TelegramConfigError(
			`Telegram configuration file ${path} must not be accessible by group or other users; use mode 0600.`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new TelegramConfigError(`Could not read Telegram configuration ${path}: ${reason}`);
	}
	if (!isRecord(value)) throw new TelegramConfigError("Telegram configuration must contain a JSON object.");
	return value;
}

function requireBotToken(value: string | undefined): string {
	const token = value?.trim();
	if (!token) throw new TelegramConfigError("FOLKSUM_TELEGRAM_BOT_TOKEN is required.");
	if (token.length > 256 || /\s/u.test(token) || !/^\d+:[A-Za-z0-9_-]+$/u.test(token)) {
		throw new TelegramConfigError("FOLKSUM_TELEGRAM_BOT_TOKEN is malformed.");
	}
	return token;
}

function parseAllowedChats(value: unknown): TelegramConversationAddress[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TelegramConfigError("Telegram allowedChats must be a non-empty array.");
	}
	const result = value.map((entry, index) => parseConversationAddress(entry, `allowedChats[${index}]`));
	assertUnique(result.map(conversationAddressKey), "Telegram allowedChats contains a duplicate chat/thread.");
	return result;
}

function parseIdentities(value: unknown, allowedKeys: ReadonlySet<string>): TelegramIdentityConfig[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TelegramConfigError("Telegram identities must be a non-empty array.");
	}
	const result = value.map((entry, index): TelegramIdentityConfig => {
		if (!isRecord(entry)) throw new TelegramConfigError(`identities[${index}] must be an object.`);
		assertOnlyKeys(entry, IDENTITY_KEYS, `identities[${index}]`);
		const userId = requireTelegramInteger(entry.userId, `identities[${index}].userId`, false);
		const memberId = requireString(entry.memberId, `identities[${index}].memberId`);
		const reminderDestination =
			entry.reminderDestination === undefined
				? undefined
				: parseConversationAddress(entry.reminderDestination, `identities[${index}].reminderDestination`);
		if (reminderDestination && !allowedKeys.has(conversationAddressKey(reminderDestination))) {
			throw new TelegramConfigError(
				`identities[${index}].reminderDestination must refer to an allowed chat/thread.`,
			);
		}
		return { userId, memberId, ...(reminderDestination ? { reminderDestination } : {}) };
	});
	assertUnique(result.map((entry) => entry.userId), "Telegram identities contains a duplicate userId.");
	assertUnique(result.map((entry) => entry.memberId), "Telegram identities contains a duplicate memberId.");
	return result;
}

function parseConversationAddress(value: unknown, path: string): TelegramConversationAddress {
	if (!isRecord(value)) throw new TelegramConfigError(`${path} must be an object.`);
	assertOnlyKeys(value, CHAT_KEYS, path);
	const chatId = requireTelegramInteger(value.chatId, `${path}.chatId`, true);
	const threadId =
		value.threadId === undefined
			? undefined
			: requireTelegramInteger(value.threadId, `${path}.threadId`, false);
	return { chatId, ...(threadId ? { threadId } : {}) };
}

function requireTelegramInteger(value: unknown, path: string, allowNegative: boolean): string {
	if (typeof value !== "string") throw new TelegramConfigError(`${path} must be a decimal string.`);
	const pattern = allowNegative ? /^-?[1-9]\d*$/u : /^[1-9]\d*$/u;
	if (!pattern.test(value)) throw new TelegramConfigError(`${path} must be a non-zero decimal string.`);
	const numeric = Number(value);
	if (!Number.isSafeInteger(numeric)) throw new TelegramConfigError(`${path} exceeds Telegram's safe integer range.`);
	return value;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TelegramConfigError(`${path} must be a non-empty string.`);
	}
	return value.trim();
}

function conversationAddressKey(address: TelegramConversationAddress): string {
	return `${address.chatId}:${address.threadId ?? "root"}`;
}

function assertUnique(values: readonly string[], message: string): void {
	if (new Set(values).size !== values.length) throw new TelegramConfigError(message);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
	const unknown = Object.keys(value).find((key) => !keys.has(key));
	if (unknown) throw new TelegramConfigError(`${path} contains unknown property "${unknown}".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
