import { run, sequentialize } from "@grammyjs/runner";
import { Bot, InlineKeyboard, type Context } from "grammy";

import { ChannelActionRegistry } from "../app/channel-actions.ts";
import { ChannelUpdateReceiptStore } from "../app/channel-updates.ts";
import { ConversationCoordinator } from "../app/conversation.ts";
import { NotificationOutbox, ReminderScheduler } from "../app/scheduler.ts";
import {
	TelegramChannelController,
	type TelegramChannelMessenger,
	type TelegramInlineButton,
} from "./telegram-controller.ts";
import type {
	TelegramChannelConfig,
	TelegramConversationAddress,
} from "./telegram-config.ts";
import { TelegramReminderService } from "./telegram-reminders.ts";

const REMINDER_INTERVAL_MILLISECONDS = 15 * 60_000;
const GRACEFUL_SHUTDOWN_MILLISECONDS = 10_000;
const FORCED_SHUTDOWN_MILLISECONDS = 2_000;

export class TelegramChannelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TelegramChannelError";
	}
}

export interface RunFolksumTelegramInput {
	config: TelegramChannelConfig;
	coordinator: ConversationCoordinator;
	actions: ChannelActionRegistry;
	receipts: ChannelUpdateReceiptStore;
	scheduler: ReminderScheduler;
	outbox: NotificationOutbox;
}

export async function runFolksumTelegram(input: RunFolksumTelegramInput): Promise<void> {
	const bot = new Bot(input.config.botToken);
	try {
		await bot.init();
		const webhook = await bot.api.getWebhookInfo();
		assertTelegramLongPollingAvailable(webhook);
	} catch (error) {
		if (error instanceof TelegramChannelError) throw error;
		throw new TelegramChannelError(
			"Could not initialize the Telegram bot. Check the token and network connection.",
		);
	}

	const messenger = createGrammyMessenger(bot);
	const accessConfig = {
		allowedChats: input.config.allowedChats,
		identities: input.config.identities,
	};
	const controller = new TelegramChannelController({
		botId: String(bot.botInfo.id),
		config: accessConfig,
		coordinator: input.coordinator,
		actions: input.actions,
		receipts: input.receipts,
		messenger,
	});
	const reminders = new TelegramReminderService({
		scheduler: input.scheduler,
		outbox: input.outbox,
		config: accessConfig,
		resolveScope: (externalId, conversationKey) =>
			input.coordinator.resolve("telegram", externalId, conversationKey),
		send: (address, text) => messenger.sendMessage(address, text),
	});

	input.receipts.failInterrupted("telegram");
	bot.use(sequentialize(telegramUpdateConstraint));
	bot.on("message:text", async (context) => {
		const envelope = requireMessageEnvelope(context);
		await controller.handle({
			kind: "text",
			updateId: String(context.update.update_id),
			...envelope,
			text: context.message.text,
		});
	});
	bot.on("message:voice", async (context) => {
		const envelope = requireMessageEnvelope(context);
		await controller.handle({
			kind: "voice",
			updateId: String(context.update.update_id),
			...envelope,
		});
	});
	bot.on("callback_query:data", async (context) => {
		const message = context.callbackQuery.message;
		if (!message) {
			await context.answerCallbackQuery({ text: "This action is unavailable." });
			return;
		}
		await controller.handle({
			kind: "callback",
			updateId: String(context.update.update_id),
			userId: String(context.from.id),
			address: addressFromMessage(message),
			callbackQueryId: context.callbackQuery.id,
			callbackData: context.callbackQuery.data,
			messageId: message.message_id,
		});
	});
	bot.on("message", async (context) => {
		const envelope = requireMessageEnvelope(context);
		await controller.handle({
			kind: "unsupported",
			updateId: String(context.update.update_id),
			...envelope,
		});
	});
	bot.catch(() => {
		console.error("Telegram update handling failed.");
	});

	const handle = run(bot, {
		runner: {
			fetch: { allowed_updates: ["message", "callback_query"], timeout: 30 },
			maxRetryTime: 60_000,
			retryInterval: "exponential",
			silent: true,
		},
		sink: { concurrency: 8 },
	});
	let reminderTask = runReminderCycle(reminders);
	const reminderTimer = setInterval(() => {
		reminderTask = runReminderCycle(reminders);
	}, REMINDER_INTERVAL_MILLISECONDS);
	const stop = createTelegramStopHandler({
		handle,
		coordinator: input.coordinator,
		actions: input.actions,
		reminderTimer,
		getReminderTask: () => reminderTask,
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);

	console.log(`Folksum Telegram bot @${bot.botInfo.username} is running with long polling.`);
	try {
		try {
			await handle.task();
		} catch {
			throw new TelegramChannelError("Telegram long polling stopped unexpectedly.");
		}
	} finally {
		await stop();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
	}
}

function createGrammyMessenger(bot: Bot): TelegramChannelMessenger {
	return {
		async sendMessage(address, text, buttons) {
			const replyMarkup = buttons ? inlineKeyboard(buttons) : undefined;
			await bot.api.sendMessage(address.chatId, text, {
				...(address.threadId ? { message_thread_id: telegramNumber(address.threadId) } : {}),
				...(replyMarkup ? { reply_markup: replyMarkup } : {}),
			});
		},
		async sendTyping(address) {
			await bot.api.sendChatAction(address.chatId, "typing", {
				...(address.threadId ? { message_thread_id: telegramNumber(address.threadId) } : {}),
			});
		},
		async answerCallback(callbackQueryId, text) {
			await bot.api.answerCallbackQuery(callbackQueryId, { text });
		},
		async clearButtons(address, messageId) {
			await bot.api.editMessageReplyMarkup(address.chatId, messageId, {
				reply_markup: { inline_keyboard: [] },
			});
		},
	};
}

function inlineKeyboard(rows: TelegramInlineButton[][]): InlineKeyboard {
	return new InlineKeyboard(
		rows.map((row) => row.map((button) => InlineKeyboard.text(button.text, button.callbackData))),
	);
}

function requireMessageEnvelope(context: Context): {
	userId: string;
	address: TelegramConversationAddress;
} {
	if (!context.from || !context.message) throw new TelegramChannelError("Telegram message has no sender or chat.");
	return {
		userId: String(context.from.id),
		address: addressFromMessage(context.message),
	};
}

function addressFromMessage(message: {
	chat: { id: number };
	message_thread_id?: number;
}): TelegramConversationAddress {
	return {
		chatId: String(message.chat.id),
		...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
	};
}

function telegramUpdateConstraint(context: Context): string | undefined {
	const userId = context.from?.id;
	const chatId = context.chat?.id;
	if (userId === undefined || chatId === undefined) return undefined;
	const threadId = context.msg?.message_thread_id ?? "root";
	return `telegram:${userId}:${chatId}:${threadId}`;
}

function telegramNumber(value: string): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result)) throw new TelegramChannelError("Telegram identifier exceeds the safe integer range.");
	return result;
}

function runReminderCycle(service: TelegramReminderService): Promise<void> {
	return service.run().then(
		() => undefined,
		() => {
			console.error("Telegram reminder cycle failed.");
		},
	);
}

export function assertTelegramLongPollingAvailable(webhook: { url?: string }): void {
	if (webhook.url) {
		throw new TelegramChannelError(
			"This Telegram bot has an active webhook. Remove it explicitly before starting Folksum long polling.",
		);
	}
}

export function createTelegramStopHandler(input: {
	handle: { stop(): Promise<void> };
	coordinator: { shutdown(): void };
	actions: { clear(): void };
	reminderTimer: NodeJS.Timeout;
	getReminderTask: () => Promise<void>;
	gracefulMilliseconds?: number;
	forcedMilliseconds?: number;
}): () => Promise<void> {
	let stopping: Promise<void> | undefined;
	return () => {
		if (stopping) return stopping;
		stopping = (async () => {
			clearInterval(input.reminderTimer);
			const runnerStop = input.handle.stop();
			const graceful = await settlesBefore(
				runnerStop,
				input.gracefulMilliseconds ?? GRACEFUL_SHUTDOWN_MILLISECONDS,
			);
			if (!graceful) input.coordinator.shutdown();
			await Promise.all([
				settlesBefore(runnerStop, input.forcedMilliseconds ?? FORCED_SHUTDOWN_MILLISECONDS),
				settlesBefore(input.getReminderTask(), input.forcedMilliseconds ?? FORCED_SHUTDOWN_MILLISECONDS),
			]);
			input.coordinator.shutdown();
			input.actions.clear();
		})();
		return stopping;
	};
}

async function settlesBefore(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), milliseconds);
		void promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}
