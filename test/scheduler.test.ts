import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRuleService } from "../src/app/memory.ts";
import { NotificationOutbox, ReminderScheduler } from "../src/app/scheduler.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

test("schedules policy thresholds and deduplicates repeated cron runs", (context) => {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const memory = new MemoryRuleService(database);
	const outbox = new NotificationOutbox(database);
	const scheduler = new ReminderScheduler(wealth, memory, outbox);

	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "telegram", externalId: "telegram-1" });
	const scope = identities.resolve({ channel: "telegram", externalId: "telegram-1", conversationKey: "chat-1" });
	const card = wealth.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	wealth.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-18",
		statementAmount: "100.00",
	});

	const first = scheduler.run({ asOf: "2026-08-11", recipients: [scope] });
	assert.equal(first.enqueued, 1);
	assert.equal(first.deduplicated, 0);
	assert.match(first.notifications[0]?.dedupeKey ?? "", /before:7$/);

	const repeated = scheduler.run({ asOf: "2026-08-11", recipients: [scope] });
	assert.equal(repeated.enqueued, 0);
	assert.equal(repeated.deduplicated, 1);
	assert.equal(scheduler.run({ asOf: "2026-08-12", recipients: [scope] }).enqueued, 0);
	assert.equal(scheduler.run({ asOf: "2026-08-15", recipients: [scope] }).enqueued, 1);
	assert.equal(scheduler.run({ asOf: "2026-08-19", recipients: [scope] }).enqueued, 1);
	assert.equal(scheduler.run({ asOf: "2026-08-20", recipients: [scope] }).enqueued, 1);
	assert.equal(outbox.listPending("telegram", "2026-08-20T23:59:59.999Z").length, 4);
});

test("uses a typed household reminder policy and supports outbox delivery state", (context) => {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const memory = new MemoryRuleService(database);
	const outbox = new NotificationOutbox(database);
	const scheduler = new ReminderScheduler(wealth, memory, outbox);

	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "default" });
	memory.setRule(scope, {
		kind: "reminder_policy",
		key: "cards",
		value: { daysBefore: [5, 0], overdueDaily: false },
	});
	const card = wealth.createAccount({ name: "Mastercard", type: "liability", subtype: "credit_card" });
	wealth.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-18",
		statementAmount: "20.00",
	});

	assert.equal(scheduler.run({ asOf: "2026-08-11", recipients: [scope] }).enqueued, 0);
	const dueInFive = scheduler.run({ asOf: "2026-08-13", recipients: [scope] });
	assert.equal(dueInFive.enqueued, 1);
	assert.equal(scheduler.run({ asOf: "2026-08-19", recipients: [scope] }).enqueued, 0);

	const notification = dueInFive.notifications[0];
	if (!notification) throw new Error("Expected a notification.");
	const failed = outbox.markFailed(notification.id, new Error("offline"));
	assert.equal(failed.status, "failed");
	assert.equal(failed.attempts, 1);
	const sent = outbox.markSent(notification.id, "2026-08-13T12:00:00.000Z");
	assert.equal(sent.status, "sent");
	assert.equal(sent.attempts, 2);
	assert.equal(outbox.listPending("cli", "2026-08-14T00:00:00.000Z").length, 0);
});
