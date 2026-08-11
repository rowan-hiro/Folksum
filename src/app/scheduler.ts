import { randomUUID } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import type { CardStatement } from "../core/types.ts";
import { WealthService } from "../core/wealth-service.ts";
import type { ChannelKind, IdentityScope } from "./identity.ts";
import { MemoryRuleService, type ReminderPolicyRuleValue } from "./memory.ts";

export type NotificationStatus = "pending" | "sent" | "failed";

interface NotificationRow {
	id: string;
	household_id: string;
	recipient_id: string;
	channel: ChannelKind;
	kind: string;
	dedupe_key: string;
	payload_json: string;
	status: NotificationStatus;
	available_at: string;
	attempts: number;
	created_at: string;
	sent_at: string | null;
	error_message: string | null;
}

export interface OutboxNotification {
	id: string;
	householdId: string;
	recipientId: string;
	channel: ChannelKind;
	kind: string;
	dedupeKey: string;
	payload: unknown;
	status: NotificationStatus;
	availableAt: string;
	attempts: number;
	createdAt: string;
	sentAt?: string;
	errorMessage?: string;
}

export interface EnqueueNotificationInput {
	householdId: string;
	recipientId: string;
	channel: ChannelKind;
	kind: string;
	dedupeKey: string;
	payload: unknown;
	availableAt?: string;
}

export interface EnqueueNotificationResult {
	notification: OutboxNotification;
	created: boolean;
}

export interface SchedulerRunInput {
	asOf: string;
	recipients: IdentityScope[];
}

export interface SchedulerRunResult {
	asOf: string;
	statementsEvaluated: number;
	enqueued: number;
	deduplicated: number;
	notifications: OutboxNotification[];
}

export class NotificationOutbox {
	private readonly database: WealthDatabase;

	constructor(database: WealthDatabase) {
		this.database = database;
	}

	enqueue(input: EnqueueNotificationInput): EnqueueNotificationResult {
		const payloadJson = JSON.stringify(input.payload);
		if (payloadJson === undefined) throw new Error("Notification payload must be JSON serializable.");
		const id = randomUUID();
		const now = new Date().toISOString();
		const result = this.database.connection
			.prepare(
				`INSERT INTO notification_outbox
					(id, household_id, recipient_id, channel, kind, dedupe_key, payload_json,
					 status, available_at, attempts, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
				 ON CONFLICT(household_id, recipient_id, channel, dedupe_key) DO NOTHING`,
			)
			.run(
				id,
				input.householdId,
				input.recipientId,
				input.channel,
				input.kind,
				input.dedupeKey,
				payloadJson,
				input.availableAt ?? now,
				now,
			);
		if (result.changes === 1) return { notification: this.get(id), created: true };

		const existing = this.database.connection
			.prepare(
				`SELECT id FROM notification_outbox
				 WHERE household_id = ? AND recipient_id = ? AND channel = ? AND dedupe_key = ?`,
			)
			.get(input.householdId, input.recipientId, input.channel, input.dedupeKey) as { id: string } | undefined;
		if (!existing) throw new Error("Notification deduplication failed to find the existing row.");
		return { notification: this.get(existing.id), created: false };
	}

	get(id: string): OutboxNotification {
		const row = this.database.connection.prepare("SELECT * FROM notification_outbox WHERE id = ?").get(id) as
			| NotificationRow
			| undefined;
		if (!row) throw new Error(`Notification "${id}" was not found.`);
		return mapNotification(row);
	}

	listPending(channel?: ChannelKind, asOf = new Date().toISOString()): OutboxNotification[] {
		const normalizedAsOf = normalizeTimestamp(asOf);
		const rows = channel
			? (this.database.connection
					.prepare(
						`SELECT * FROM notification_outbox
						 WHERE status IN ('pending', 'failed') AND available_at <= ? AND channel = ?
						 ORDER BY available_at, created_at`,
					)
					.all(normalizedAsOf, channel) as unknown as NotificationRow[])
			: (this.database.connection
					.prepare(
						`SELECT * FROM notification_outbox
						 WHERE status IN ('pending', 'failed') AND available_at <= ?
						 ORDER BY available_at, created_at`,
					)
					.all(normalizedAsOf) as unknown as NotificationRow[]);
		return rows.map(mapNotification);
	}

	markSent(id: string, sentAt = new Date().toISOString()): OutboxNotification {
		this.database.connection
			.prepare(
				`UPDATE notification_outbox
				 SET status = 'sent', sent_at = ?, attempts = attempts + 1, error_message = NULL
				 WHERE id = ? AND status IN ('pending', 'failed')`,
			)
			.run(normalizeTimestamp(sentAt), id);
		return this.get(id);
	}

	markFailed(id: string, error: unknown): OutboxNotification {
		const message = error instanceof Error ? error.message : String(error);
		this.database.connection
			.prepare(
				`UPDATE notification_outbox
				 SET status = 'failed', attempts = attempts + 1, error_message = ?
				 WHERE id = ? AND status IN ('pending', 'failed')`,
			)
			.run(message, id);
		return this.get(id);
	}
}

export class ReminderScheduler {
	private readonly wealth: WealthService;
	private readonly memory: MemoryRuleService;
	private readonly outbox: NotificationOutbox;

	constructor(wealth: WealthService, memory: MemoryRuleService, outbox: NotificationOutbox) {
		this.wealth = wealth;
		this.memory = memory;
		this.outbox = outbox;
	}

	run(input: SchedulerRunInput): SchedulerRunResult {
		const asOf = normalizeDate(input.asOf);
		const recipients = input.recipients.filter((scope) => scope.householdId === this.wealth.household.id);
		if (recipients.length !== input.recipients.length) throw new Error("Scheduler recipient belongs to another household.");
		const policy = this.getReminderPolicy(asOf);
		const statements = this.wealth.listCardStatements(asOf).filter((statement) => statement.status !== "paid");
		const notifications: OutboxNotification[] = [];
		let enqueued = 0;
		let deduplicated = 0;

		for (const statement of statements) {
			const dedupeKey = reminderDedupeKey(statement, asOf, policy);
			if (!dedupeKey) continue;
			for (const recipient of recipients) {
				const result = this.outbox.enqueue({
					householdId: recipient.householdId,
					recipientId: recipient.actorId,
					channel: recipient.channel,
					kind: "card_payment_reminder",
					dedupeKey,
					payload: {
						type: "card_payment_reminder",
						statementId: statement.id,
						cardAccountName: statement.cardAccountName,
						dueDate: statement.dueDate,
						daysUntilDue: statement.daysUntilDue,
						status: statement.status,
						currency: statement.currency,
						outstandingAmount: statement.outstandingAmount,
					},
				});
				notifications.push(result.notification);
				if (result.created) enqueued += 1;
				else deduplicated += 1;
			}
		}

		return {
			asOf,
			statementsEvaluated: statements.length,
			enqueued,
			deduplicated,
			notifications,
		};
	}

	private getReminderPolicy(asOf: string): ReminderPolicyRuleValue {
		const rule = this.memory.getRule(
			this.wealth.household.id,
			"reminder_policy",
			"cards",
			`${asOf}T23:59:59.999Z`,
		);
		return rule?.value ?? { daysBefore: [7, 3, 1, 0], overdueDaily: true };
	}
}

function reminderDedupeKey(
	statement: CardStatement,
	asOf: string,
	policy: ReminderPolicyRuleValue,
): string | undefined {
	if (statement.daysUntilDue > 0 && policy.daysBefore.includes(statement.daysUntilDue)) {
		return `card:${statement.id}:before:${statement.daysUntilDue}`;
	}
	if (statement.daysUntilDue === 0 && policy.daysBefore.includes(0)) return `card:${statement.id}:due`;
	if (statement.daysUntilDue < 0 && policy.overdueDaily) return `card:${statement.id}:overdue:${asOf}`;
	return undefined;
}

function mapNotification(row: NotificationRow): OutboxNotification {
	return {
		id: row.id,
		householdId: row.household_id,
		recipientId: row.recipient_id,
		channel: row.channel,
		kind: row.kind,
		dedupeKey: row.dedupe_key,
		payload: JSON.parse(row.payload_json) as unknown,
		status: row.status,
		availableAt: row.available_at,
		attempts: row.attempts,
		createdAt: row.created_at,
		...(row.sent_at ? { sentAt: row.sent_at } : {}),
		...(row.error_message ? { errorMessage: row.error_message } : {}),
	};
}

function normalizeDate(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Date must use YYYY-MM-DD, received "${value}".`);
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (parsed.toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date "${value}".`);
	return value;
}

function normalizeTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp "${value}".`);
	return parsed.toISOString();
}
