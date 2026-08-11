import assert from "node:assert/strict";
import test from "node:test";

import { WealthDatabase } from "../src/core/database.ts";
import { WealthError } from "../src/core/errors.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(): { database: WealthDatabase; service: WealthService } {
	const database = new WealthDatabase(":memory:");
	const service = new WealthService(database, { baseCurrency: "HKD" });
	return { database, service };
}

test("allocates card payments and ledger postings atomically", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "1000.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const shopping = service.createAccount({ name: "Shopping", type: "expense" });
	service.recordExpense({
		description: "Statement purchases",
		amount: "100.00",
		expenseAccountId: shopping.id,
		fundingAccountId: card.id,
		occurredAt: "2026-07-31",
	});

	const statement = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "100.00",
		minimumPayment: "10.00",
	});
	assert.equal(statement.duplicate, false);
	assert.equal(statement.statement.outstandingAmount, "100.00");

	const payment = service.recordCardPayment({
		statementId: statement.statement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "payment-1",
	});
	assert.equal(payment.statement.outstandingAmount, "40.00");
	assert.equal(service.getAccount(bank.id).balance, "940.00");
	assert.equal(service.getAccount(card.id).balance, "-40.00");

	const retry = service.recordCardPayment({
		statementId: statement.statement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "payment-1",
	});
	assert.equal(retry.payment.duplicate, true);
	assert.equal(retry.payment.transaction.id, payment.payment.transaction.id);
	assert.equal(service.getAccount(bank.id).balance, "940.00");

	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: statement.statement.id,
				fundingAccountId: bank.id,
				amount: "40.01",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_amount");
			return true;
		},
	);
	assert.equal(service.getCardStatement(statement.statement.id).outstandingAmount, "40.00");
});

test("classifies reminder boundaries and excludes paid or distant statements", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "100.00" });
	const card = service.createAccount({ name: "Mastercard", type: "liability", subtype: "credit_card" });

	function addStatement(statementDate: string, dueDate: string): string {
		return service.recordCardStatement({
			cardAccountId: card.id,
			periodStart: "2026-01-01",
			periodEnd: statementDate,
			statementDate,
			dueDate,
			statementAmount: "5.00",
		}).statement.id;
	}

	const overdue = addStatement("2026-06-01", "2026-08-10");
	const dueToday = addStatement("2026-06-02", "2026-08-11");
	const dueSoon = addStatement("2026-06-03", "2026-08-18");
	const distant = addStatement("2026-06-04", "2026-08-19");
	const paid = addStatement("2026-06-05", "2026-08-12");
	service.recordCardPayment({
		statementId: paid,
		fundingAccountId: bank.id,
		amount: "5.00",
		occurredAt: "2026-08-09",
		idempotencyKey: "paid-statement",
	});

	const reminders = service.listCardReminders({ asOf: "2026-08-11", windowDays: 7 });
	assert.deepEqual(
		reminders.map((reminder) => [reminder.statementId, reminder.status, reminder.daysUntilDue]),
		[
			[overdue, "overdue", -1],
			[dueToday, "due_today", 0],
			[dueSoon, "due_soon", 7],
		],
	);
	assert.ok(!reminders.some((reminder) => reminder.statementId === distant));
	assert.ok(!reminders.some((reminder) => reminder.statementId === paid));
});

test("deduplicates identical statements and rejects conflicting replacements", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const input = {
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "50.00",
	};

	const first = service.recordCardStatement(input);
	const retry = service.recordCardStatement(input);
	assert.equal(retry.duplicate, true);
	assert.equal(retry.statement.id, first.statement.id);

	assert.throws(
		() => service.recordCardStatement({ ...input, statementAmount: "51.00" }),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "duplicate");
			return true;
		},
	);
});
