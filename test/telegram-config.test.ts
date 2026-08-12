import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	findTelegramIdentity,
	isAllowedTelegramConversation,
	loadTelegramConfig,
	TelegramConfigError,
	telegramConversationKey,
} from "../src/channels/telegram-config.ts";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-telegram-config-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function writePrivateJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

test("loads a strict private Telegram configuration with string identifiers", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "telegram.json");
	writePrivateJson(path, {
		version: 1,
		allowedChats: [{ chatId: "-1001234567890", threadId: "42" }],
		identities: [
			{
				userId: "123456789",
				memberId: "member-1",
				reminderDestination: { chatId: "-1001234567890", threadId: "42" },
			},
		],
	});
	const config = loadTelegramConfig({
		cwd: directory,
		env: {
			FOLKSUM_TELEGRAM_BOT_TOKEN: TOKEN,
			FOLKSUM_TELEGRAM_CONFIG_PATH: "telegram.json",
		},
		platform: "linux",
	});

	assert.equal(config.botToken, TOKEN);
	assert.equal(config.configPath, path);
	assert.equal(telegramConversationKey(config.allowedChats[0]!), "-1001234567890:42");
	assert.equal(isAllowedTelegramConversation(config, { chatId: "-1001234567890", threadId: "42" }), true);
	assert.equal(isAllowedTelegramConversation(config, { chatId: "-1001234567890" }), false);
	assert.equal(findTelegramIdentity(config, "123456789")?.memberId, "member-1");
});

test("requires the token only from the environment and enforces private file permissions", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "telegram.json");
	writePrivateJson(path, {
		version: 1,
		allowedChats: [{ chatId: "-1001" }],
		identities: [{ userId: "101", memberId: "member-1" }],
	});

	assert.throws(
		() => loadTelegramConfig({ cwd: directory, env: { FOLKSUM_TELEGRAM_CONFIG_PATH: path } }),
		/FOLKSUM_TELEGRAM_BOT_TOKEN is required/,
	);
	chmodSync(path, 0o644);
	assert.throws(
		() =>
			loadTelegramConfig({
				cwd: directory,
				env: { FOLKSUM_TELEGRAM_BOT_TOKEN: TOKEN, FOLKSUM_TELEGRAM_CONFIG_PATH: path },
				platform: "linux",
			}),
		/mode 0600/,
	);
});

test("rejects unknown fields, unsafe mappings, and non-string Telegram identifiers", (context) => {
	const directory = createDirectory(context);
	const path = join(directory, "telegram.json");
	const load = (): ReturnType<typeof loadTelegramConfig> =>
		loadTelegramConfig({
			cwd: directory,
			env: { FOLKSUM_TELEGRAM_BOT_TOKEN: TOKEN, FOLKSUM_TELEGRAM_CONFIG_PATH: path },
			platform: "linux",
		});

	writePrivateJson(path, {
		version: 1,
		botToken: "must-not-be-accepted",
		allowedChats: [{ chatId: "-1001" }],
		identities: [{ userId: "101", memberId: "member-1" }],
	});
	assert.throws(load, /unknown property "botToken"/);

	writePrivateJson(path, {
		version: 1,
		allowedChats: [{ chatId: "-1001" }],
		identities: [
			{
				userId: "101",
				memberId: "member-1",
				reminderDestination: { chatId: "-1002" },
			},
		],
	});
	assert.throws(load, /must refer to an allowed chat/);

	writePrivateJson(path, {
		version: 1,
		allowedChats: [{ chatId: -1001 }],
		identities: [{ userId: "101", memberId: "member-1" }],
	});
	assert.throws(load, TelegramConfigError);
});
