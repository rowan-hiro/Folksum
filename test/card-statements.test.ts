import assert from "node:assert/strict";
import test from "node:test";

import type { CardTrackingMode } from "../src/core/card-tracking.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthError } from "../src/core/errors.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(cardTrackingMode?: CardTrackingMode): { database: WealthDatabase; service: WealthService } {
	const database = new WealthDatabase(":memory:");
	const service = new WealthService(database, {
		baseCurrency: "HKD",
		...(cardTrackingMode ? { cardTrackingMode } : {}),
	});
	return { database, service };
}

test("allocates card payments and ledger postings atomically", (context) => {
	const { database, service } = createFixture("integrated");
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
	assert.equal(statement.statement.accountingMode, "integrated");
	assert.equal(statement.duplicate, false);
	assert.equal(statement.statement.outstandingAmount, "100.00");

	const payment = service.recordCardPayment({
		statementId: statement.statement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "payment-1",
	});
	assert.equal(payment.payment.accountingMode, "integrated");
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
	if (retry.payment.accountingMode !== "integrated" || payment.payment.accountingMode !== "integrated") {
		throw new Error("Expected integrated card payments.");
	}
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

test("lightweight payments update reminders without touching the ledger or net worth", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());
	assert.equal(service.getCardTrackingMode(), "lightweight");

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "1000.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const statement = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "100.00",
	}).statement;
	assert.equal(statement.accountingMode, "lightweight");

	const transactionsBefore = service.listTransactions().map((transaction) => transaction.id);
	const netWorthBefore = service.getNetWorth("2099-01-01");
	const first = service.recordCardPayment({
		statementId: statement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "lightweight-payment-1",
	});
	if (first.payment.accountingMode !== "lightweight") {
		throw new Error("Expected a lightweight card payment.");
	}
	assert.equal(first.payment.duplicate, false);
	assert.equal(first.payment.amount, "60.00");
	assert.equal(first.payment.fundingAccountId, bank.id);
	assert.equal(first.statement.outstandingAmount, "40.00");
	assert.equal(service.getAccount(bank.id).balance, "1000.00");
	assert.equal(service.getAccount(card.id).balance, "0.00");
	assert.deepEqual(service.listTransactions().map((transaction) => transaction.id), transactionsBefore);
	assert.deepEqual(service.getNetWorth("2099-01-01"), netWorthBefore);

	const retry = service.recordCardPayment({
		statementId: statement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "lightweight-payment-1",
	});
	if (retry.payment.accountingMode !== "lightweight") {
		throw new Error("Expected a lightweight card payment.");
	}
	assert.equal(retry.payment.duplicate, true);
	assert.equal(retry.payment.id, first.payment.id);
	assert.equal(service.getCardStatement(statement.id).outstandingAmount, "40.00");
	assert.equal(
		(database.connection.prepare("SELECT COUNT(*) AS count FROM standalone_statement_payments").get() as {
			count: number;
		}).count,
		1,
	);
	assert.equal(
		(database.connection.prepare("SELECT COUNT(*) AS count FROM statement_payments").get() as { count: number })
			.count,
		0,
	);

	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: statement.id,
				fundingAccountId: bank.id,
				amount: "39.99",
				idempotencyKey: "lightweight-payment-1",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "duplicate");
			return true;
		},
	);
	assert.throws(
		() => service.recordCardPayment({ statementId: statement.id, amount: "40.01" }),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_amount");
			return true;
		},
	);

	const dining = service.createAccount({ name: "Dining", type: "expense" });
	const transactionsBeforeCollision = service.listTransactions().map((transaction) => transaction.id);
	assert.throws(
		() =>
			service.recordExpense({
				description: "Colliding expense",
				amount: "1.00",
				expenseAccountId: dining.id,
				fundingAccountId: bank.id,
				idempotencyKey: "lightweight-payment-1",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "duplicate");
			return true;
		},
	);
	assert.deepEqual(
		service.listTransactions().map((transaction) => transaction.id),
		transactionsBeforeCollision,
	);
});

test("statement mode snapshots survive later mode switches", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "100.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const dining = service.createAccount({ name: "Dining", type: "expense" });
	const lightweightInput = {
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "20.00",
	};
	const lightweight = service.recordCardStatement(lightweightInput).statement;

	service.setCardTrackingMode("integrated");
	service.recordExpense({
		description: "September purchases",
		amount: "30.00",
		expenseAccountId: dining.id,
		fundingAccountId: card.id,
		occurredAt: "2026-08-31",
	});
	const integrated = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-08-01",
		periodEnd: "2026-08-31",
		statementDate: "2026-09-01",
		dueDate: "2026-09-20",
		statementAmount: "30.00",
	}).statement;
	assert.equal(lightweight.accountingMode, "lightweight");
	assert.equal(integrated.accountingMode, "integrated");
	assert.equal(service.recordCardStatement(lightweightInput).statement.accountingMode, "lightweight");

	const standalone = service.recordCardPayment({
		statementId: lightweight.id,
		amount: "5.00",
		occurredAt: "2026-08-10",
	});
	assert.equal(standalone.payment.accountingMode, "lightweight");

	service.setCardTrackingMode("lightweight");
	const ledger = service.recordCardPayment({
		statementId: integrated.id,
		fundingAccountId: bank.id,
		amount: "10.00",
		occurredAt: "2026-09-10",
	});
	assert.equal(ledger.payment.accountingMode, "integrated");
	assert.equal(service.getAccount(bank.id).balance, "90.00");
	assert.equal(service.getAccount(card.id).balance, "-20.00");
	assert.equal(service.getCardStatement(lightweight.id).outstandingAmount, "15.00");
	assert.equal(service.getCardStatement(integrated.id, "2026-09-10").outstandingAmount, "20.00");
});

test("integrated payments cannot create a positive card balance", (context) => {
	const { database, service } = createFixture("integrated");
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "100.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const shopping = service.createAccount({ name: "Shopping", type: "expense" });
	service.recordExpense({
		description: "Card purchases",
		amount: "50.00",
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
	}).statement;
	assert.throws(
		() => service.recordCardPayment({ statementId: statement.id, amount: "1.00" }),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_account");
			return true;
		},
	);

	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: statement.id,
				fundingAccountId: bank.id,
				amount: "60.00",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_amount");
			assert.match(error.message, /current card liability/);
			return true;
		},
	);
	assert.equal(service.getAccount(bank.id).balance, "100.00");
	assert.equal(service.getAccount(card.id).balance, "-50.00");

	service.recordCardPayment({
		statementId: statement.id,
		fundingAccountId: bank.id,
		amount: "50.00",
	});
	assert.equal(service.getAccount(card.id).balance, "0.00");
	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: statement.id,
				fundingAccountId: bank.id,
				amount: "0.01",
			}),
		{ name: "WealthError" },
	);
	assert.equal(service.getAccount(card.id).balance, "0.00");
});

for (const accountingMode of ["lightweight", "integrated"] as const) {
	test(`${accountingMode} statements filter future payments by the report date`, (context) => {
		const { database, service } = createFixture(accountingMode);
		context.after(() => database.close());

		const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "200.00" });
		const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
		if (accountingMode === "integrated") {
			const shopping = service.createAccount({ name: "Shopping", type: "expense" });
			service.recordExpense({
				description: "Statement purchases",
				amount: "100.00",
				expenseAccountId: shopping.id,
				fundingAccountId: card.id,
				occurredAt: "2026-07-31",
			});
		}
		const statement = service.recordCardStatement({
			cardAccountId: card.id,
			periodStart: "2026-07-01",
			periodEnd: "2026-07-31",
			statementDate: "2026-08-01",
			dueDate: "2026-08-20",
			statementAmount: "100.00",
		}).statement;
		service.recordCardPayment({
			statementId: statement.id,
			...(accountingMode === "integrated" ? { fundingAccountId: bank.id } : {}),
			amount: "100.00",
			occurredAt: "2026-08-25",
			idempotencyKey: `${accountingMode}-future-payment`,
		});

		const beforePayment = service.getCardStatement(statement.id, "2026-08-18");
		assert.equal(beforePayment.paidAmount, "0.00");
		assert.equal(beforePayment.outstandingAmount, "100.00");
		assert.equal(beforePayment.status, "due_soon");
		assert.deepEqual(
			service.listCardReminders({ asOf: "2026-08-18", windowDays: 7 }).map((reminder) => reminder.statementId),
			[statement.id],
		);
		assert.equal(service.getCardStatement(statement.id, "2026-08-25").status, "paid");

		assert.throws(
			() =>
				service.recordCardPayment({
					statementId: statement.id,
					...(accountingMode === "integrated" ? { fundingAccountId: bank.id } : {}),
					amount: "0.01",
					occurredAt: "2026-08-10",
				}),
			(error: unknown) => {
				assert.ok(error instanceof WealthError);
				assert.equal(error.code, "invalid_amount");
				assert.match(error.message, /outstanding amount 0\.00/);
				return true;
			},
		);
	});
}

test("integrated backdated payments ignore future card purchases", (context) => {
	const { database, service } = createFixture("integrated");
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "200.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const shopping = service.createAccount({ name: "Shopping", type: "expense" });
	const statement = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "50.00",
	}).statement;
	service.recordExpense({
		description: "Future card purchase",
		amount: "50.00",
		expenseAccountId: shopping.id,
		fundingAccountId: card.id,
		occurredAt: "2026-09-01",
	});

	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: statement.id,
				fundingAccountId: bank.id,
				amount: "50.00",
				occurredAt: "2026-08-10",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_amount");
			assert.match(error.message, /current card liability 0\.00/);
			return true;
		},
	);
	assert.equal(service.getAccount(bank.id).balance, "200.00");
	assert.equal(service.getAccount(card.id).balance, "-50.00");
	assert.equal(service.getCardStatement(statement.id, "2026-08-10").paidAmount, "0.00");
});

test("integrated backdated payments cannot invalidate a later card balance", (context) => {
	const { database, service } = createFixture("integrated");
	context.after(() => database.close());

	const bank = service.createAccount({ name: "Checking", type: "asset", openingBalance: "200.00" });
	const card = service.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const shopping = service.createAccount({ name: "Shopping", type: "expense" });
	service.recordExpense({
		description: "Card purchases",
		amount: "100.00",
		expenseAccountId: shopping.id,
		fundingAccountId: card.id,
		occurredAt: "2026-07-31",
	});
	const firstStatement = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "60.00",
	}).statement;
	const secondStatement = service.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-15",
		periodEnd: "2026-08-01",
		statementDate: "2026-08-02",
		dueDate: "2026-08-25",
		statementAmount: "50.00",
	}).statement;
	service.recordCardPayment({
		statementId: firstStatement.id,
		fundingAccountId: bank.id,
		amount: "60.00",
		occurredAt: "2026-09-10",
	});

	assert.throws(
		() =>
			service.recordCardPayment({
				statementId: secondStatement.id,
				fundingAccountId: bank.id,
				amount: "50.00",
				occurredAt: "2026-08-10",
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "invalid_amount");
			assert.match(error.message, /current card liability 40\.00/);
			return true;
		},
	);
	assert.equal(service.getAccount(bank.id).balance, "140.00");
	assert.equal(service.getAccount(card.id).balance, "-40.00");
	assert.equal(service.getCardStatement(secondStatement.id, "2026-08-10").paidAmount, "0.00");
});
