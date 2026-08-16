import { run, sequentialize } from "@grammyjs/runner";
import { Bot, InlineKeyboard, type Context } from "grammy";

import { ChannelActionRegistry } from "../app/channel-actions.ts";
import { ChannelUpdateReceiptStore } from "../app/channel-updates.ts";
import { ConversationCoordinator } from "../app/conversation.ts";
import { NotificationOutbox, ReminderScheduler } from "../app/scheduler.ts";
import type { VoiceTranscriber } from "../app/voice-transcriber.ts";
import {
	TelegramChannelController,
	type TelegramChannelMessenger,
	type TelegramInlineButton,
	type TelegramVoiceDownload,
} from "./telegram-controller.ts";
import type {
	TelegramChannelConfig,
	TelegramConversationAddress,
} from "./telegram-config.ts";
import { TelegramReminderService } from "./telegram-reminders.ts";

const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file";
const VOICE_MAXIMUM_BYTES = 20 * 1024 * 1024;
const VOICE_MAXIMUM_SECONDS = 300;
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
	voiceTranscriber?: VoiceTranscriber;
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
		...(input.voiceTranscriber
			? {
					voice: {
						transcriber: input.voiceTranscriber,
						download: createTelegramVoiceDownloader(bot, input.config.botToken),
						maximumBytes: VOICE_MAXIMUM_BYTES,
						maximumDurationSeconds: VOICE_MAXIMUM_SECONDS,
					},
				}
			: {}),
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
		const voice = context.message.voice;
		await controller.handle({
			kind: "voice",
			updateId: String(context.update.update_id),
			...envelope,
			fileId: voice.file_id,
			...(voice.mime_type ? { mimeType: voice.mime_type } : {}),
			...(Number.isSafeInteger(voice.duration) ? { durationSeconds: voice.duration } : {}),
			...(voice.file_size !== undefined && Number.isSafeInteger(voice.file_size)
				? { fileSizeBytes: voice.file_size }
				: {}),
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
		controller,
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

/**
 * Downloads one voice payload from the Telegram file API.
 *
 * The bot token stays inside this adapter: the controller only receives audio
 * bytes and a declared MIME type, and never learns the download URL.
 */
export function createTelegramVoiceDownloader(
	bot: Pick<Bot, "api">,
	botToken: string,
): (input: {
	fileId: string;
	maximumBytes: number;
	signal: AbortSignal;
}) => Promise<TelegramVoiceDownload> {
	return async ({ fileId, maximumBytes, signal }) => {
		const file = await bot.api.getFile(fileId, asGrammySignal(signal)).catch(() => {
			throw new TelegramChannelError("Telegram refused to describe the voice file.");
		});
		if (!file.file_path) {
			throw new TelegramChannelError("Telegram returned no downloadable path for the voice file.");
		}
		if (file.file_size !== undefined && file.file_size > maximumBytes) {
			throw new TelegramChannelError("The voice file is larger than the transcription limit.");
		}

		const url = `${TELEGRAM_FILE_ROOT}/bot${botToken}/${file.file_path}`;
		let response: Response;
		try {
			response = await fetch(url, { signal });
		} catch {
			if (signal.aborted) throw new TelegramChannelError("The voice download was cancelled.");
			throw new TelegramChannelError("Could not reach the Telegram file API to download the voice message.");
		}
		if (!response.ok) {
			throw new TelegramChannelError(`Telegram returned HTTP ${response.status} for the voice download.`);
		}

		const audio = await readCappedBody(response, maximumBytes);
		const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		return { audio, ...(mimeType ? { mimeType } : {}) };
	};
}

type GrammyAbortSignal = NonNullable<Parameters<Bot["api"]["getFile"]>[1]>;

/**
 * `grammy` declares its cancellation parameter against the `abort-controller`
 * polyfill types, while the runtime value is a standard `AbortSignal`. Only the
 * declarations differ, so the conversion is confined to this helper.
 */
function asGrammySignal(signal: AbortSignal): GrammyAbortSignal {
	return signal as unknown as GrammyAbortSignal;
}

async function readCappedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const body = response.body;
	if (!body) throw new TelegramChannelError("The Telegram voice download returned no content.");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maximumBytes) {
				throw new TelegramChannelError("The voice file is larger than the transcription limit.");
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (total === 0) throw new TelegramChannelError("The Telegram voice download was empty.");

	const audio = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		audio.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return audio;
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
	controller?: { stop(): void };
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
			if (!graceful) {
				input.coordinator.shutdown();
				input.controller?.stop();
			}
			await Promise.all([
				settlesBefore(runnerStop, input.forcedMilliseconds ?? FORCED_SHUTDOWN_MILLISECONDS),
				settlesBefore(input.getReminderTask(), input.forcedMilliseconds ?? FORCED_SHUTDOWN_MILLISECONDS),
			]);
			input.coordinator.shutdown();
			input.controller?.stop();
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
