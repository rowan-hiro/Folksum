import assert from "node:assert/strict";
import test from "node:test";

import { WealthDatabase } from "../src/core/database.ts";
import { WealthError } from "../src/core/errors.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(): { database: WealthDatabase; service: WealthService } {
	const database = new WealthDatabase(":memory:");
	const service = new WealthService(database, {
		householdName: "Test Household",
		baseCurrency: "HKD",
	});
	return { database, service };
}

test("records balanced income, expense, transfer, and reversal transactions", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const bank = service.createAccount({
		name: "Joint Checking",
		type: "asset",
		openingBalance: "1000.00",
	});
	const card = service.createAccount({
		name: "Family Visa",
		type: "liability",
		subtype: "credit_card",
		openingBalance: "100.00",
	});
	const dining = service.createAccount({ name: "Dining", type: "expense" });
	const salary = service.createAccount({ name: "Salary", type: "income" });

	service.recordIncome({
		description: "August salary",
		amount: "500.00",
		incomeAccountId: salary.id,
		destinationAccountId: bank.id,
		occurredAt: "2026-08-01",
	});
	const lunch = service.recordExpense({
		description: "Family lunch",
		amount: "38.50",
		expenseAccountId: dining.id,
		fundingAccountId: card.id,
		occurredAt: "2026-08-02",
	});
	service.recordTransfer({
		description: "Pay Visa",
		amount: "100.00",
		fromAccountId: bank.id,
		toAccountId: card.id,
		occurredAt: "2026-08-03",
	});

	assert.equal(service.getAccount(bank.id).balance, "1400.00");
	assert.equal(service.getAccount(card.id).balance, "-38.50");
	assert.equal(service.getAccount(dining.id).balance, "38.50");
	assert.equal(service.getAccount(salary.id).balance, "-500.00");

	const reversal = service.reverseTransaction({
		transactionId: lunch.transaction.id,
		occurredAt: "2026-08-04",
	});
	assert.equal(reversal.transaction.reversalOf, lunch.transaction.id);
	assert.equal(service.getAccount(card.id).balance, "0.00");
	assert.equal(service.getAccount(dining.id).balance, "0.00");

	for (const transaction of service.listTransactions(20)) {
		assert.equal(
			transaction.postings.reduce((total, posting) => total + posting.amountMinor, 0),
			0,
			`transaction ${transaction.id} must balance`,
		);
	}
});

test("deduplicates retried writes by household idempotency key", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const cash = service.createAccount({ name: "Cash", type: "asset", openingBalance: "100.00" });
	const groceries = service.createAccount({ name: "Groceries", type: "expense" });
	const input = {
		description: "Market",
		amount: "12.50",
		expenseAccountId: groceries.id,
		fundingAccountId: cash.id,
		occurredAt: "2026-08-05",
		idempotencyKey: "message-123:expense-1",
	};

	const first = service.recordExpense(input);
	const retry = service.recordExpense(input);

	assert.equal(first.duplicate, false);
	assert.equal(retry.duplicate, true);
	assert.equal(retry.transaction.id, first.transaction.id);
	assert.equal(service.getAccount(cash.id).balance, "87.50");
	assert.equal(service.getAccount(groceries.id).balance, "12.50");
});

test("rejects cross-currency and invalid account combinations atomically", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const hkdCash = service.createAccount({ name: "HKD Cash", type: "asset", currency: "HKD" });
	const usdCash = service.createAccount({ name: "USD Cash", type: "asset", currency: "USD" });
	const groceries = service.createAccount({ name: "Groceries", type: "expense", currency: "HKD" });

	assert.throws(
		() =>
			service.recordTransfer({
				description: "Invalid transfer",
				amount: "10.00",
				fromAccountId: hkdCash.id,
				toAccountId: usdCash.id,
			}),
		(error: unknown) => {
			assert.ok(error instanceof WealthError);
			assert.equal(error.code, "currency_mismatch");
			return true;
		},
	);

	assert.throws(
		() =>
			service.recordIncome({
				description: "Invalid income",
				amount: "10.00",
				incomeAccountId: groceries.id,
				destinationAccountId: hkdCash.id,
			}),
		{ name: "WealthError" },
	);
	assert.equal(service.getAccount(hkdCash.id).balance, "0.00");
	assert.equal(service.getAccount(usdCash.id).balance, "0.00");
});

test("prevents repeated reversal of an immutable transaction", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const cash = service.createAccount({ name: "Cash", type: "asset", openingBalance: "20.00" });
	const transport = service.createAccount({ name: "Transport", type: "expense" });
	const fare = service.recordExpense({
		description: "Train fare",
		amount: "2.00",
		expenseAccountId: transport.id,
		fundingAccountId: cash.id,
	});

	service.reverseTransaction({ transactionId: fare.transaction.id });
	assert.throws(() => service.reverseTransaction({ transactionId: fare.transaction.id }), {
		name: "WealthError",
	});
	assert.equal(service.getAccount(cash.id).balance, "20.00");
	assert.equal(service.getAccount(transport.id).balance, "0.00");
});
