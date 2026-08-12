import assert from "node:assert/strict";
import test from "node:test";

import { ChannelActionRegistry } from "../src/app/channel-actions.ts";
import { ChannelUpdateReceiptStore } from "../src/app/channel-updates.ts";
import { ConversationCoordinator } from "../src/app/conversation.ts";
import { ConfirmationStore } from "../src/app/confirmation.ts";
import { FinanceApplication } from "../src/app/finance-application.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import {
	confirmationCallbackData,
	sanitizeTelegramText,
	splitTelegramText,
	TelegramChannelController,
	type TelegramChannelMessenger,
	type TelegramInlineButton,
} from "../src/channels/telegram-controller.ts";
import type { TelegramConversationAddress } from "../src/channels/telegram-config.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";
import type { PiConfirmationRequest } from "../src/runtime/pi/tools.ts";

class FakeMessenger implements TelegramChannelMessenger {
	readonly messages: Array<{
		address: TelegramConversationAddress;
		text: string;
		buttons?: TelegramInlineButton[][];
	}> = [];
	readonly answers: Array<{ callbackQueryId: string; text: string }> = [];
	readonly cleared: Array<{ address: TelegramConversationAddress; messageId: number }> = [];
	typing = 0;

	async sendMessage(
		address: TelegramConversationAddress,
		text: string,
		buttons?: TelegramInlineButton[][],
	): Promise<void> {
		this.messages.push({ address: { ...address }, text, ...(buttons ? { buttons } : {}) });
	}

	async sendTyping(): Promise<void> {
		this.typing += 1;
	}

	async answerCallback(callbackQueryId: string, text: string): Promise<void> {
		this.answers.push({ callbackQueryId, text });
	}

	async clearButtons(address: TelegramConversationAddress, messageId: number): Promise<void> {
		this.cleared.push({ address: { ...address }, messageId });
	}
}

test("enforces authorization, deduplicates updates, and handles choices and confirmations in scope", async (context) => {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const first = identities.createMember({
		householdId: wealth.household.id,
		displayName: "First",
		role: "owner",
		timezone: "UTC",
	});
	const second = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Second",
		role: "member",
		timezone: "UTC",
	});
	identities.bindChannelIdentity({ memberId: first.id, channel: "telegram", externalId: "101" });
	identities.bindChannelIdentity({ memberId: second.id, channel: "telegram", externalId: "202" });
	const conversationKey = "-1001:root";
	const firstScope = identities.resolve({ channel: "telegram", externalId: "101", conversationKey });
	const application = new FinanceApplication(wealth, new ConfirmationStore(database));
	const proposed = application.submit(
		{
			version: 1,
			kind: "create_account",
			householdId: firstScope.householdId,
			actorId: firstScope.actorId,
			sessionId: firstScope.sessionId,
			source: "agent",
			idempotencyKey: "telegram-account",
			payload: { name: "Telegram Savings", type: "asset" },
		},
		firstScope,
	);
	if (proposed.status !== "confirmation_required") throw new Error("Expected a pending confirmation.");
	const confirmation: PiConfirmationRequest = {
		pendingOperationId: proposed.pendingOperation.id,
		risk: proposed.risk,
		summary: proposed.summary,
		confirmationToken: proposed.confirmationToken,
	};
	const prompts: string[] = [];
	const coordinator = new ConversationCoordinator({
		identities,
		application,
		runtimeFactory: async ({ onChoiceRequired, onConfirmationRequired }) => ({
			async prompt(text, onText) {
				prompts.push(text);
				if (text === "choose") {
					onChoiceRequired({
						requestId: "choice-1",
						prompt: "Which card?",
						options: [
							{ value: "visa", label: "Visa" },
							{ value: "mastercard", label: "Mastercard" },
						],
					});
				} else if (text === "confirm") {
					onConfirmationRequired(confirmation);
				} else if (text.startsWith("User selected an exact option")) {
					onText?.("Selection accepted.");
				} else {
					onText?.("Assistant response.");
				}
			},
			abort() {},
		}),
	});
	const messenger = new FakeMessenger();
	const controller = new TelegramChannelController({
		botId: "9001",
		config: {
			allowedChats: [{ chatId: "-1001" }],
			identities: [
				{ userId: "101", memberId: first.id },
				{ userId: "202", memberId: second.id },
			],
		},
		coordinator,
		actions: new ChannelActionRegistry(),
		receipts: new ChannelUpdateReceiptStore(database),
		messenger,
	});
	const address = { chatId: "-1001" };

	assert.deepEqual(
		await controller.handle({ kind: "text", updateId: "0", userId: "999", address, text: "hello" }),
		{ status: "unauthorized" },
	);
	assert.equal(prompts.length, 0);
	assert.deepEqual(
		await controller.handle({ kind: "text", updateId: "1", userId: "101", address, text: "hello" }),
		{ status: "completed" },
	);
	assert.equal(messenger.messages.at(-1)?.text, "Assistant response.");
	assert.deepEqual(
		await controller.handle({ kind: "text", updateId: "1", userId: "101", address, text: "hello" }),
		{ status: "duplicate" },
	);
	assert.equal(prompts.filter((prompt) => prompt === "hello").length, 1);

	await controller.handle({ kind: "voice", updateId: "2", userId: "101", address });
	assert.match(messenger.messages.at(-1)?.text ?? "", /No audio was downloaded/);
	const promptCount = prompts.length;
	await controller.handle({
		kind: "text",
		updateId: "3",
		userId: "101",
		address,
		text: "sk-proj-abcdefghijklmnop",
	});
	assert.equal(prompts.length, promptCount);
	assert.match(messenger.messages.at(-1)?.text ?? "", /was not sent or stored/);

	await controller.handle({ kind: "text", updateId: "4", userId: "101", address, text: "choose" });
	const choiceMessage = messenger.messages.at(-1);
	const choiceData = choiceMessage?.buttons?.[0]?.[0]?.callbackData;
	assert.ok(choiceData);
	assert.ok(Buffer.byteLength(choiceData, "utf8") <= 64);
	await controller.handle({
		kind: "callback",
		updateId: "5",
		userId: "202",
		address,
		callbackQueryId: "cross-user",
		callbackData: choiceData,
		messageId: 10,
	});
	assert.match(messenger.answers.at(-1)?.text ?? "", /another user or conversation/);
	await controller.handle({
		kind: "callback",
		updateId: "6",
		userId: "101",
		address,
		callbackQueryId: "right-user",
		callbackData: choiceData,
		messageId: 10,
	});
	assert.equal(messenger.messages.at(-1)?.text, "Selection accepted.");
	assert.match(prompts.at(-1) ?? "", /"value":"visa"/);
	await controller.handle({
		kind: "callback",
		updateId: "7",
		userId: "101",
		address,
		callbackQueryId: "replay",
		callbackData: choiceData,
		messageId: 10,
	});
	assert.match(messenger.answers.at(-1)?.text ?? "", /already used/);

	await controller.handle({ kind: "text", updateId: "8", userId: "101", address, text: "confirm" });
	const confirmationData = messenger.messages.at(-1)?.buttons?.[0]?.[0]?.callbackData;
	assert.ok(confirmationData);
	assert.match(confirmationData, /^fc:/);
	assert.doesNotMatch(confirmationData, /secret|telegram-account/);
	await controller.handle({
		kind: "callback",
		updateId: "9",
		userId: "101",
		address,
		callbackQueryId: "confirm",
		callbackData: confirmationData,
		messageId: 11,
	});
	assert.equal(wealth.listAccounts().some((account) => account.name === "Telegram Savings"), true);
	assert.match(messenger.messages.at(-1)?.text ?? "", /^Confirmed:/);
	assert.equal(
		(database.connection.prepare("SELECT COUNT(*) AS count FROM channel_update_receipts").get() as { count: number }).count,
		9,
	);
});

test("keeps callback payloads short and safely chunks plain Telegram text", () => {
	const data = confirmationCallbackData("abcdefghijklmnop", true);
	assert.ok(Buffer.byteLength(data, "utf8") <= 64);
	assert.equal(sanitizeTelegramText("safe\u0000 text\nnext"), "safe text\nnext");
	const chunks = splitTelegramText(`${"😀".repeat(2_500)}\n${"x".repeat(5_000)}`);
	assert.ok(chunks.length >= 3);
	assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
	assert.equal(chunks.join(""), `${"😀".repeat(2_500)}\n${"x".repeat(5_000)}`);
});
