import { ChannelActionError, ChannelActionRegistry } from "../app/channel-actions.ts";
import { ChannelUpdateReceiptStore } from "../app/channel-updates.ts";
import {
	ConversationCoordinator,
	ConversationInputError,
	type ConversationTurnResult,
} from "../app/conversation.ts";
import type { IdentityScope } from "../app/identity.ts";
import { containsLikelyCredential } from "../app/input-security.ts";
import type { VoiceTranscriber } from "../app/voice-transcriber.ts";
import {
	findTelegramIdentity,
	isAllowedTelegramConversation,
	telegramConversationKey,
	type TelegramChannelConfig,
	type TelegramConversationAddress,
} from "./telegram-config.ts";

const TELEGRAM_TEXT_LIMIT = 4_000;
const DEFAULT_VOICE_MAXIMUM_BYTES = 20 * 1024 * 1024;
const DEFAULT_VOICE_MAXIMUM_SECONDS = 300;
const VOICE_DISABLED_MESSAGE =
	"Voice transcription is not enabled in this alpha. No audio was downloaded or sent to the model; please send the request as text.";

export interface TelegramInlineButton {
	text: string;
	callbackData: string;
}

export interface TelegramVoiceDownload {
	audio: Uint8Array;
	mimeType?: string;
}

/**
 * Voice capability handed to the controller when transcription is enabled.
 *
 * The controller never sees the bot token: downloading is delegated back to the
 * channel adapter, and transcription is delegated to the runtime transcriber.
 */
export interface TelegramVoiceSupport {
	transcriber: VoiceTranscriber;
	download(input: { fileId: string; maximumBytes: number }): Promise<TelegramVoiceDownload>;
	maximumBytes?: number;
	maximumDurationSeconds?: number;
}

export interface TelegramChannelMessenger {
	sendMessage(
		address: TelegramConversationAddress,
		text: string,
		buttons?: TelegramInlineButton[][],
	): Promise<void>;
	sendTyping(address: TelegramConversationAddress): Promise<void>;
	answerCallback(callbackQueryId: string, text: string): Promise<void>;
	clearButtons(address: TelegramConversationAddress, messageId: number): Promise<void>;
}

interface TelegramInboundBase {
	updateId: string;
	userId: string;
	address: TelegramConversationAddress;
}

export type TelegramInboundUpdate =
	| (TelegramInboundBase & { kind: "text"; text: string })
	| (TelegramInboundBase & {
			kind: "voice";
			fileId: string;
			mimeType?: string;
			durationSeconds?: number;
			fileSizeBytes?: number;
	  })
	| (TelegramInboundBase & { kind: "unsupported" })
	| (TelegramInboundBase & {
			kind: "callback";
			callbackQueryId: string;
			callbackData: string;
			messageId: number;
	  });

export interface TelegramUpdateResult {
	status: "completed" | "duplicate" | "unauthorized" | "failed";
}

export class TelegramChannelController {
	private readonly botId: string;
	private readonly config: Pick<TelegramChannelConfig, "allowedChats" | "identities">;
	private readonly coordinator: ConversationCoordinator;
	private readonly actions: ChannelActionRegistry;
	private readonly receipts: ChannelUpdateReceiptStore;
	private readonly messenger: TelegramChannelMessenger;
	private readonly voice: TelegramVoiceSupport | undefined;
	private readonly voiceMaximumBytes: number;
	private readonly voiceMaximumSeconds: number;

	constructor(input: {
		botId: string;
		config: Pick<TelegramChannelConfig, "allowedChats" | "identities">;
		coordinator: ConversationCoordinator;
		actions: ChannelActionRegistry;
		receipts: ChannelUpdateReceiptStore;
		messenger: TelegramChannelMessenger;
		voice?: TelegramVoiceSupport;
	}) {
		this.botId = requireIdentifier(input.botId, "Telegram bot ID");
		this.config = input.config;
		this.coordinator = input.coordinator;
		this.actions = input.actions;
		this.receipts = input.receipts;
		this.messenger = input.messenger;
		this.voice = input.voice;
		this.voiceMaximumBytes = requirePositiveInteger(
			input.voice?.maximumBytes ?? DEFAULT_VOICE_MAXIMUM_BYTES,
			"Telegram voice size limit",
		);
		this.voiceMaximumSeconds = requirePositiveInteger(
			input.voice?.maximumDurationSeconds ?? DEFAULT_VOICE_MAXIMUM_SECONDS,
			"Telegram voice duration limit",
		);
	}

	async handle(update: TelegramInboundUpdate): Promise<TelegramUpdateResult> {
		const identity = findTelegramIdentity(this.config, update.userId);
		if (!identity || !isAllowedTelegramConversation(this.config, update.address)) {
			if (update.kind === "callback") {
				await this.messenger.answerCallback(update.callbackQueryId, "Not authorized.").catch(() => undefined);
			}
			return { status: "unauthorized" };
		}

		const claim = this.receipts.claim("telegram", `${this.botId}:${requireIdentifier(update.updateId, "Update ID")}`);
		if (!claim.claimed) {
			if (update.kind === "callback") {
				await this.messenger.answerCallback(update.callbackQueryId, "Already handled.").catch(() => undefined);
			}
			return { status: "duplicate" };
		}

		try {
			const scope = this.coordinator.resolve(
				"telegram",
				update.userId,
				telegramConversationKey(update.address),
			);
			await this.processAuthorized(update, scope);
			this.receipts.complete(claim.receipt.id);
			return { status: "completed" };
		} catch (error) {
			if (error instanceof ConversationInputError || error instanceof ChannelActionError) {
				await this.sendHandledError(update, error.message).catch(() => undefined);
				this.receipts.complete(claim.receipt.id);
				return { status: "completed" };
			}
			this.receipts.fail(claim.receipt.id, "Telegram update processing failed.");
			await this.sendHandledError(
				update,
				"Folksum could not process this request. Check the local bot and model configuration, then try again.",
			).catch(() => undefined);
			return { status: "failed" };
		}
	}

	private async processAuthorized(update: TelegramInboundUpdate, scope: IdentityScope): Promise<void> {
		switch (update.kind) {
			case "text": {
				await this.messenger.sendTyping(update.address).catch(() => undefined);
				await this.renderTurn(update.address, await this.coordinator.prompt(scope, update.text));
				return;
			}
			case "voice":
				await this.processVoice(update, scope);
				return;
			case "unsupported":
				await this.sendText(update.address, "This alpha accepts text messages only. Voice transcription and file parsing are not enabled.");
				return;
			case "callback":
				await this.processCallback(update, scope);
		}
	}

	/**
	 * Turns an allow-listed voice message into text and then reuses the ordinary
	 * text turn. Transcription never gains financial authority: the transcript
	 * re-enters through the same coordinator prompt as a typed message.
	 */
	private async processVoice(
		update: Extract<TelegramInboundUpdate, { kind: "voice" }>,
		scope: IdentityScope,
	): Promise<void> {
		const voice = this.voice;
		if (!voice) {
			await this.sendText(update.address, VOICE_DISABLED_MESSAGE);
			return;
		}
		if (update.durationSeconds !== undefined && update.durationSeconds > this.voiceMaximumSeconds) {
			await this.sendText(
				update.address,
				`This voice message is ${update.durationSeconds} seconds long; the limit is ${this.voiceMaximumSeconds} seconds. No audio was downloaded. Please send a shorter message.`,
			);
			return;
		}
		if (update.fileSizeBytes !== undefined && update.fileSizeBytes > this.voiceMaximumBytes) {
			await this.sendText(
				update.address,
				"This voice message is larger than the transcription limit. No audio was downloaded. Please send a shorter message.",
			);
			return;
		}

		await this.messenger.sendTyping(update.address).catch(() => undefined);
		let transcript: string;
		try {
			const download = await voice.download({
				fileId: update.fileId,
				maximumBytes: this.voiceMaximumBytes,
			});
			const mimeType = update.mimeType?.trim() || download.mimeType?.trim();
			const result = await voice.transcriber.transcribe({
				audio: download.audio,
				...(mimeType ? { mimeType } : {}),
			});
			transcript = sanitizeTelegramText(result.text).trim();
		} catch (error) {
			await this.sendText(
				update.address,
				`Voice transcription failed: ${truncateTelegramText(describeVoiceFailure(error), 300)} You can send the request as text instead.`,
			);
			return;
		}

		if (!transcript) {
			await this.sendText(
				update.address,
				"No speech was recognized in that voice message. Please try again or send the request as text.",
			);
			return;
		}
		if (containsLikelyCredential(transcript)) {
			await this.sendText(
				update.address,
				"The transcript looks like a provider credential and was not sent to the model. Configure credentials through the local TUI.",
			);
			return;
		}

		await this.sendText(update.address, `Heard: ${transcript}`);
		await this.messenger.sendTyping(update.address).catch(() => undefined);
		await this.renderTurn(update.address, await this.coordinator.prompt(scope, transcript));
	}

	private async processCallback(
		update: Extract<TelegramInboundUpdate, { kind: "callback" }>,
		scope: IdentityScope,
	): Promise<void> {
		const parsed = parseCallbackData(update.callbackData);
		if (parsed.kind === "confirmation") {
			const request = this.actions.consumeConfirmation(parsed.actionId, scope);
			await this.messenger.answerCallback(update.callbackQueryId, "Processing…");
			await this.messenger.clearButtons(update.address, update.messageId).catch(() => undefined);
			if (parsed.confirmed) {
				const result = this.coordinator.confirm(scope, request);
				await this.sendText(update.address, `Confirmed: ${request.summary} (${result.status}).`);
			} else {
				this.coordinator.reject(scope, request);
				await this.sendText(update.address, `Rejected: ${request.summary}.`);
			}
			return;
		}

		const request = this.actions.consumeChoice(parsed.actionId, scope, parsed.optionIndex);
		await this.messenger.answerCallback(update.callbackQueryId, "Selection received.");
		await this.messenger.clearButtons(update.address, update.messageId).catch(() => undefined);
		await this.messenger.sendTyping(update.address).catch(() => undefined);
		await this.renderTurn(
			update.address,
			await this.coordinator.select(scope, request, parsed.optionIndex),
		);
	}

	private async renderTurn(address: TelegramConversationAddress, turn: ConversationTurnResult): Promise<void> {
		if (turn.text.trim()) await this.sendText(address, turn.text);
		for (const request of turn.confirmations) {
			const actionId = this.actions.register(turn.scope, { kind: "confirmation", request });
			const confirmData = confirmationCallbackData(actionId, true);
			const rejectData = confirmationCallbackData(actionId, false);
			await this.messenger.sendMessage(
				address,
				sanitizeTelegramText(`${request.summary}\nRisk: ${request.risk}. Confirm this operation?`),
				[[
					{ text: "Confirm", callbackData: confirmData },
					{ text: "Reject", callbackData: rejectData },
				]],
			);
		}
		for (const request of turn.choices) {
			const actionId = this.actions.register(turn.scope, { kind: "choice", request });
			const details = request.options
				.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)
				.join("\n");
			const buttons = request.options.map((option, index) => [
				{
					text:
						truncateTelegramText(sanitizeTelegramText(option.label), 64).trim() ||
						`Option ${index + 1}`,
					callbackData: choiceCallbackData(actionId, index),
				},
			]);
			await this.messenger.sendMessage(
				address,
				sanitizeTelegramText(`${request.prompt}\n\n${details}`),
				buttons,
			);
		}
		if (!turn.text.trim() && turn.confirmations.length === 0 && turn.choices.length === 0) {
			await this.sendText(address, "The model returned no response. Please try again.");
		}
	}

	private async sendHandledError(update: TelegramInboundUpdate, message: string): Promise<void> {
		if (update.kind === "callback") {
			await this.messenger.answerCallback(update.callbackQueryId, truncateTelegramText(message, 180));
			return;
		}
		await this.sendText(update.address, message);
	}

	private async sendText(address: TelegramConversationAddress, text: string): Promise<void> {
		for (const chunk of splitTelegramText(text)) {
			await this.messenger.sendMessage(address, chunk);
		}
	}
}

export function splitTelegramText(value: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
	if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("Telegram text limit must be at least 2.");
	let remaining = sanitizeTelegramText(value);
	if (!remaining.trim()) return [];
	const chunks: string[] = [];
	while (remaining.length > limit) {
		const delimiter = Math.max(
			remaining.lastIndexOf("\n", limit - 1),
			remaining.lastIndexOf(" ", limit - 1),
		);
		let cut = delimiter < Math.floor(limit / 2) ? limit : delimiter + 1;
		if (isHighSurrogate(remaining.charCodeAt(cut - 1))) cut -= 1;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export function sanitizeTelegramText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

export function confirmationCallbackData(actionId: string, confirmed: boolean): string {
	return assertCallbackData(`fc:${actionId}:${confirmed ? "1" : "0"}`);
}

export function choiceCallbackData(actionId: string, optionIndex: number): string {
	if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex > 5) {
		throw new Error("Telegram choice index must be between 0 and 5.");
	}
	return assertCallbackData(`fq:${actionId}:${optionIndex}`);
}

type ParsedCallbackData =
	| { kind: "confirmation"; actionId: string; confirmed: boolean }
	| { kind: "choice"; actionId: string; optionIndex: number };

function parseCallbackData(value: string): ParsedCallbackData {
	const match = /^(fc|fq):([A-Za-z0-9_-]{16}):([0-5])$/u.exec(value);
	if (!match) throw new ChannelActionError("This button is invalid or no longer supported.");
	const [, prefix, actionId, argument] = match;
	if (!actionId || argument === undefined) throw new ChannelActionError("This button is invalid.");
	if (prefix === "fc") {
		if (argument !== "0" && argument !== "1") throw new ChannelActionError("This confirmation button is invalid.");
		return { kind: "confirmation", actionId, confirmed: argument === "1" };
	}
	return { kind: "choice", actionId, optionIndex: Number(argument) };
}

function assertCallbackData(value: string): string {
	if (Buffer.byteLength(value, "utf8") > 64) throw new Error("Telegram callback data exceeds 64 bytes.");
	return value;
}

function truncateTelegramText(value: string, maximumLength: number): string {
	if (value.length <= maximumLength) return value;
	let cut = maximumLength - 1;
	if (isHighSurrogate(value.charCodeAt(cut - 1))) cut -= 1;
	return `${value.slice(0, cut)}…`;
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function describeVoiceFailure(error: unknown): string {
	const message = error instanceof Error ? error.message.trim() : "";
	return sanitizeTelegramText(message) || "the transcription service did not return a result.";
}

function requirePositiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
	return value;
}

function requireIdentifier(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 100) throw new Error(`${label} is invalid.`);
	return normalized;
}
