import { dateInTimezone } from "../app/conversation.ts";
import type { IdentityScope } from "../app/identity.ts";
import {
	NotificationOutbox,
	ReminderScheduler,
	type OutboxNotification,
} from "../app/scheduler.ts";
import type {
	TelegramChannelConfig,
	TelegramConversationAddress,
} from "./telegram-config.ts";
import { telegramConversationKey } from "./telegram-config.ts";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MILLISECONDS = 60_000;
const MAX_RETRY_DELAY_MILLISECONDS = 15 * 60_000;

export interface TelegramReminderSender {
	(address: TelegramConversationAddress, text: string): Promise<void>;
}

export interface TelegramReminderCycleResult {
	enqueued: number;
	deduplicated: number;
	sent: number;
	failed: number;
}

export class TelegramReminderService {
	private readonly scheduler: ReminderScheduler;
	private readonly outbox: NotificationOutbox;
	private readonly config: Pick<TelegramChannelConfig, "identities">;
	private readonly resolveScope: (externalId: string, conversationKey: string) => IdentityScope;
	private readonly send: TelegramReminderSender;
	private readonly maxAttempts: number;
	private readonly retryBaseMilliseconds: number;
	private activeCycle: Promise<TelegramReminderCycleResult> | undefined;

	constructor(input: {
		scheduler: ReminderScheduler;
		outbox: NotificationOutbox;
		config: Pick<TelegramChannelConfig, "identities">;
		resolveScope: (externalId: string, conversationKey: string) => IdentityScope;
		send: TelegramReminderSender;
		maxAttempts?: number;
		retryBaseMilliseconds?: number;
	}) {
		this.scheduler = input.scheduler;
		this.outbox = input.outbox;
		this.config = input.config;
		this.resolveScope = input.resolveScope;
		this.send = input.send;
		this.maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.retryBaseMilliseconds = input.retryBaseMilliseconds ?? DEFAULT_RETRY_BASE_MILLISECONDS;
		if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) {
			throw new Error("Telegram reminder maximum attempts must be a positive integer.");
		}
		if (!Number.isSafeInteger(this.retryBaseMilliseconds) || this.retryBaseMilliseconds <= 0) {
			throw new Error("Telegram reminder retry base must be a positive integer.");
		}
	}

	run(now = new Date()): Promise<TelegramReminderCycleResult> {
		if (this.activeCycle) return this.activeCycle;
		const cycle = this.runCycle(now).finally(() => {
			if (this.activeCycle === cycle) this.activeCycle = undefined;
		});
		this.activeCycle = cycle;
		return cycle;
	}

	private async runCycle(now: Date): Promise<TelegramReminderCycleResult> {
		let enqueued = 0;
		let deduplicated = 0;
		for (const identity of this.config.identities) {
			const destination = identity.reminderDestination;
			if (!destination) continue;
			const scope = this.resolveScope(identity.userId, telegramConversationKey(destination));
			const result = this.scheduler.run({
				asOf: dateInTimezone(scope.timezone, now),
				recipients: [scope],
				availableAt: now.toISOString(),
			});
			enqueued += result.enqueued;
			deduplicated += result.deduplicated;
		}

		let sent = 0;
		let failed = 0;
		const destinations = new Map(
			this.config.identities
				.filter((identity) => identity.reminderDestination !== undefined)
				.map((identity) => [identity.memberId, identity.reminderDestination] as const),
		);
		const pending = this.outbox.listPending("telegram", now.toISOString(), this.maxAttempts);
		for (const notification of pending) {
			const destination = destinations.get(notification.recipientId);
			if (!destination) {
				this.failDelivery(notification, now, "Telegram reminder destination is not configured.");
				failed += 1;
				continue;
			}
			try {
				await this.send(destination, formatTelegramReminder(notification));
				this.outbox.markSent(notification.id, now.toISOString());
				sent += 1;
			} catch {
				this.failDelivery(notification, now, "Telegram reminder delivery failed.");
				failed += 1;
			}
		}
		return { enqueued, deduplicated, sent, failed };
	}

	private failDelivery(notification: OutboxNotification, now: Date, reason: string): void {
		const delay = Math.min(
			this.retryBaseMilliseconds * 2 ** notification.attempts,
			MAX_RETRY_DELAY_MILLISECONDS,
		);
		this.outbox.markFailed(notification.id, reason, new Date(now.getTime() + delay).toISOString());
	}
}

export function formatTelegramReminder(notification: OutboxNotification): string {
	if (notification.kind !== "card_payment_reminder" || !isCardReminderPayload(notification.payload)) {
		throw new Error(`Unsupported Telegram notification kind "${notification.kind}".`);
	}
	const payload = notification.payload;
	const timing =
		payload.daysUntilDue > 0
			? `due in ${payload.daysUntilDue} day${payload.daysUntilDue === 1 ? "" : "s"}`
			: payload.daysUntilDue === 0
				? "due today"
				: `${Math.abs(payload.daysUntilDue)} day${payload.daysUntilDue === -1 ? "" : "s"} overdue`;
	return [
		"Credit-card repayment reminder",
		`${payload.cardAccountName}: ${payload.currency} ${payload.outstandingAmount}`,
		`Due ${payload.dueDate} (${timing}). This reminder does not initiate a payment.`,
	].join("\n");
}

interface CardReminderPayload {
	type: "card_payment_reminder";
	cardAccountName: string;
	dueDate: string;
	daysUntilDue: number;
	currency: string;
	outstandingAmount: string;
}

function isCardReminderPayload(value: unknown): value is CardReminderPayload {
	if (!isRecord(value)) return false;
	return (
		value.type === "card_payment_reminder" &&
		typeof value.cardAccountName === "string" &&
		typeof value.dueDate === "string" &&
		Number.isSafeInteger(value.daysUntilDue) &&
		typeof value.currency === "string" &&
		typeof value.outstandingAmount === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
