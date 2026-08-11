import assert from "node:assert/strict";
import test from "node:test";

import { ConfirmationError, ConfirmationStore } from "../src/app/confirmation.ts";
import { FinanceApplication } from "../src/app/finance-application.ts";
import type { FinanceIr } from "../src/app/finance-ir.ts";
import type { IdentityScope } from "../src/app/identity.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(): {
	database: WealthDatabase;
	wealth: WealthService;
	application: FinanceApplication;
	scope: IdentityScope;
} {
	const database = new WealthDatabase(":memory:");
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const application = new FinanceApplication(wealth, new ConfirmationStore(database));
	const scope: IdentityScope = {
		householdId: wealth.household.id,
		actorId: "member-1",
		sessionId: "session-1",
		channel: "cli",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	};
	return { database, wealth, application, scope };
}

function withScope<T extends Omit<FinanceIr, "version" | "householdId" | "actorId" | "sessionId" | "source">>(
	scope: IdentityScope,
	ir: T,
): FinanceIr {
	return {
		version: 1,
		householdId: scope.householdId,
		actorId: scope.actorId,
		sessionId: scope.sessionId,
		source: "agent",
		...ir,
	} as FinanceIr;
}

test("executes low-risk IR immediately and routes reads through the application", (context) => {
	const { database, wealth, application, scope } = createFixture();
	context.after(() => database.close());

	const cash = wealth.createAccount({ name: "Cash", type: "asset", openingBalance: "100.00" });
	const dining = wealth.createAccount({ name: "Dining", type: "expense" });
	const expense = application.submit(
		withScope(scope, {
			kind: "record_expense",
			idempotencyKey: "ir-expense-1",
			payload: {
				description: "Lunch",
				amount: "38.50",
				expenseAccountId: dining.id,
				fundingAccountId: cash.id,
				occurredAt: "2026-08-11",
			},
		}),
		scope,
	);
	assert.equal(expense.status, "executed");
	assert.equal(wealth.getAccount(cash.id).balance, "61.50");

	const read = application.submit(withScope(scope, { kind: "list_accounts", payload: {} }), scope);
	assert.equal(read.status, "executed");
	assert.ok(Array.isArray(read.result));
});

test("binds medium-risk confirmation to identity, session, IR hash, and one-time token", (context) => {
	const { database, wealth, application, scope } = createFixture();
	context.after(() => database.close());

	const proposed = application.submit(
		withScope(scope, {
			kind: "create_account",
			idempotencyKey: "create-account-1",
			payload: { name: "Savings", type: "asset", currency: "HKD", openingBalance: "10.00" },
		}),
		scope,
	);
	assert.equal(proposed.status, "confirmation_required");
	assert.equal(wealth.findAccountByName("Savings"), undefined);
	if (proposed.status !== "confirmation_required") throw new Error("Expected confirmation.");

	const wrongScope = { ...scope, actorId: "member-2" };
	assert.throws(() => application.confirm(proposed.confirmationToken, wrongScope), ConfirmationError);
	assert.equal(wealth.findAccountByName("Savings"), undefined);

	const confirmed = application.confirm(proposed.confirmationToken, scope);
	assert.equal(confirmed.status, "executed");
	assert.equal(wealth.findAccountByName("Savings")?.balance, "10.00");
	assert.throws(() => application.confirm(proposed.confirmationToken, scope), /already executed/);
});

test("does not mutate the ledger before high-risk card payment confirmation", (context) => {
	const { database, wealth, application, scope } = createFixture();
	context.after(() => database.close());

	const bank = wealth.createAccount({ name: "Checking", type: "asset", openingBalance: "100.00" });
	const card = wealth.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const statement = wealth.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "50.00",
	}).statement;

	const proposed = application.submit(
		withScope(scope, {
			kind: "record_card_payment",
			idempotencyKey: "card-payment-1",
			payload: {
				statementId: statement.id,
				fundingAccountId: bank.id,
				amount: "50.00",
				occurredAt: "2026-08-11",
			},
		}),
		scope,
	);
	assert.equal(proposed.status, "confirmation_required");
	assert.equal(wealth.getAccount(bank.id).balance, "100.00");
	assert.equal(wealth.getCardStatement(statement.id).outstandingAmount, "50.00");
	if (proposed.status !== "confirmation_required") throw new Error("Expected confirmation.");

	application.confirm(proposed.confirmationToken, scope);
	assert.equal(wealth.getAccount(bank.id).balance, "50.00");
	assert.equal(wealth.getCardStatement(statement.id).outstandingAmount, "0.00");
});

test("prevents viewers and mismatched household scopes from mutating", (context) => {
	const { database, application, scope } = createFixture();
	context.after(() => database.close());

	const ir = withScope(scope, {
		kind: "create_account",
		idempotencyKey: "viewer-create",
		payload: { name: "Hidden", type: "asset" },
	});
	assert.throws(() => application.submit(ir, { ...scope, role: "viewer" }), /Viewer role/);
	assert.throws(() => application.submit(ir, { ...scope, householdId: "other-household" }), /identity scope/);
});
