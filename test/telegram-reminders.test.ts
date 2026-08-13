import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { MemoryRuleService } from "../src/app/memory.ts";
import { NotificationOutbox, ReminderScheduler } from "../src/app/scheduler.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { TelegramReminderService } from "../src/channels/telegram-reminders.ts";
import { telegramConversationKey } from "../src/channels/telegram-config.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(context: TestContext) {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const member = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "UTC",
	});
	identities.bindChannelIdentity({ memberId: member.id, channel: "telegram", externalId: "101" });
	const card = wealth.createAccount({ name: "Joint Visa", type: "liability", subtype: "credit_card" });
	wealth.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-18",
		statementAmount: "1234.50",
	});
	const outbox = new NotificationOutbox(database);
	const scheduler = new ReminderScheduler(wealth, new MemoryRuleService(database), outbox);
	const destination = { chatId: "-1001" };
	const config = {
		identities: [{ userId: "101", memberId: member.id, reminderDestination: destination }],
	};
	return {
		database,
		identities,
		member,
		outbox,
		scheduler,
		destination,
		config,
		resolveScope: (externalId: string, conversationKey: string) =>
			identities.resolve({ channel: "telegram", externalId, conversationKey }),
	};
}

test("renders and delivers exact reminder amounts without calling a model", async (context) => {
	const fixture = createFixture(context);
	const sent: Array<{ address: { chatId: string }; text: string }> = [];
	const service = new TelegramReminderService({
		scheduler: fixture.scheduler,
		outbox: fixture.outbox,
		config: fixture.config,
		resolveScope: fixture.resolveScope,
		send: async (address, text) => {
			sent.push({ address, text });
		},
	});

	const result = await service.run(new Date("2026-08-11T12:00:00.000Z"));
	assert.deepEqual(result, { enqueued: 1, deduplicated: 0, sent: 1, failed: 0 });
	assert.equal(sent[0]?.address.chatId, "-1001");
	assert.match(sent[0]?.text ?? "", /Joint Visa: HKD 1234\.50/);
	assert.match(sent[0]?.text ?? "", /does not initiate a payment/);
	assert.equal(fixture.outbox.listPending("telegram", "2026-08-12T00:00:00.000Z", 5).length, 0);
	assert.equal(telegramConversationKey(fixture.destination), "-1001:root");
});

test("backs off failed Telegram reminders and stops after five attempts", async (context) => {
	const fixture = createFixture(context);
	let sendAttempts = 0;
	const service = new TelegramReminderService({
		scheduler: fixture.scheduler,
		outbox: fixture.outbox,
		config: fixture.config,
		resolveScope: fixture.resolveScope,
		retryBaseMilliseconds: 60_000,
		maxAttempts: 5,
		send: async () => {
			sendAttempts += 1;
			throw new Error("upstream response with sensitive details");
		},
	});
	const times = [0, 1, 3, 7, 15].map(
		(minutes) => new Date(Date.parse("2026-08-11T12:00:00.000Z") + minutes * 60_000),
	);
	for (const now of times) await service.run(now);
	await service.run(new Date("2026-08-11T13:00:00.000Z"));

	assert.equal(sendAttempts, 5);
	const row = fixture.database.connection
		.prepare("SELECT id FROM notification_outbox WHERE recipient_id = ?")
		.get(fixture.member.id) as { id: string };
	const notification = fixture.outbox.get(row.id);
	assert.equal(notification.status, "failed");
	assert.equal(notification.attempts, 5);
	assert.equal(notification.errorMessage, "Telegram reminder delivery failed.");
	assert.equal(fixture.outbox.listPending("telegram", "2026-08-12T00:00:00.000Z", 5).length, 0);
});
