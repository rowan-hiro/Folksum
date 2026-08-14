import assert from "node:assert/strict";
import test from "node:test";

import { BookkeepingProfileService } from "../src/app/bookkeeping-profile.ts";
import { ConfirmationStore } from "../src/app/confirmation.ts";
import { FinanceApplication } from "../src/app/finance-application.ts";
import type { FinanceIr } from "../src/app/finance-ir.ts";
import type { IdentityScope } from "../src/app/identity.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import type { PostedTransaction } from "../src/core/types.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture() {
	const database = new WealthDatabase(":memory:");
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	const identities = new SessionIdentityService(database);
	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "classification" });
	const profiles = new BookkeepingProfileService(database);
	const application = new FinanceApplication(wealth, new ConfirmationStore(database), undefined, profiles);
	return { database, wealth, profiles, application, scope };
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

function executedTransaction(result: ReturnType<FinanceApplication["submit"]>): PostedTransaction {
	assert.equal(result.status, "executed");
	return result.result as PostedTransaction;
}

test("bookkeeping classification resolves a bound explicit category and persists typed fields atomically", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.food.dining",
						label: "Dining out",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: dining.id },
					},
				],
			},
			customFields: {
				upsert: [
					{
						id: "reimbursable",
						label: "Reimbursable",
						target: "transaction",
						type: "boolean",
						required: true,
					},
				],
			},
		},
	});

	const posted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "category-expense",
				payload: {
					description: "Team lunch",
					amount: "38.50",
					categoryId: "expense.food.dining",
					customFields: { reimbursable: true },
					fundingAccountId: cash.id,
					occurredAt: "2026-08-12",
				},
			}),
			fixture.scope,
		),
	);

	assert.equal(posted.transaction.postings[0]?.accountId, dining.id);
	assert.deepEqual(posted.transaction.bookkeeping, {
		profileRevision: 1,
		profileHash: fixture.profiles.getActiveProfile(fixture.scope.householdId).profileHash,
		categoryId: "expense.food.dining",
		categoryLabel: "Dining out",
		customFields: { reimbursable: true },
		resolutionSource: "explicit",
		createdAt: posted.transaction.createdAt,
	});
	assert.throws(
		() =>
			fixture.database.connection
				.prepare("UPDATE transaction_bookkeeping SET category_label = 'Changed' WHERE transaction_id = ?")
				.run(posted.transaction.id),
		/Transaction bookkeeping metadata is immutable/,
	);
});

test("bookkeeping classification applies the highest-priority matching rule and explicit field overrides", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.food.dining",
						label: "Dining",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: dining.id },
					},
				],
			},
			customFields: {
				upsert: [
					{
						id: "reimbursable",
						label: "Reimbursable",
						target: "transaction",
						type: "boolean",
						required: false,
					},
				],
			},
			categorizationRules: {
				upsert: [
					{
						id: "merchant.starbucks",
						priority: 100,
						match: { transactionKind: "expense", descriptionContains: "starbucks" },
						assign: { categoryId: "expense.food.dining", fields: { reimbursable: false } },
					},
				],
			},
		},
	});

	const posted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "rule-expense",
				payload: {
					description: "STARBUCKS Central",
					amount: "20.00",
					customFields: { reimbursable: true },
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(posted.transaction.bookkeeping?.categoryId, "expense.food.dining");
	assert.equal(posted.transaction.bookkeeping?.categorizationRuleId, "merchant.starbucks");
	assert.equal(posted.transaction.bookkeeping?.resolutionSource, "rule");
	assert.deepEqual(posted.transaction.bookkeeping?.customFields, { reimbursable: true });
});

test("bookkeeping classification requires declared fields before any ledger write", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			customFields: {
				upsert: [
					{
						id: "project",
						label: "Project",
						target: "transaction",
						type: "text",
						required: true,
					},
				],
			},
		},
	});

	assert.throws(
		() =>
			fixture.application.submit(
				withScope(fixture.scope, {
					kind: "record_expense",
					idempotencyKey: "missing-field",
					payload: {
						description: "Lunch",
						amount: "10.00",
						expenseAccountId: dining.id,
						fundingAccountId: cash.id,
					},
				}),
				fixture.scope,
			),
		/Required transaction custom field "project" is missing/,
	);
	assert.equal(fixture.wealth.listTransactions().length, 0);
});

test("bookkeeping classification keeps the original profile snapshot on idempotent retry and reversal", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.food.dining",
						label: "Dining",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: dining.id },
					},
				],
			},
		},
	});
	const ir = withScope(fixture.scope, {
		kind: "record_expense",
		idempotencyKey: "stable-retry",
		payload: {
			description: "Lunch",
			amount: "12.00",
			categoryId: "expense.food.dining",
			fundingAccountId: cash.id,
		},
	});
	const original = executedTransaction(fixture.application.submit(ir, fixture.scope));
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 1,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.food.dining",
						label: "Meals",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: dining.id },
					},
				],
			},
		},
	});
	const retry = executedTransaction(fixture.application.submit(ir, fixture.scope));
	assert.equal(retry.duplicate, true);
	assert.deepEqual(retry.transaction.bookkeeping, original.transaction.bookkeeping);

	const reversal = fixture.wealth.reverseTransaction({
		transactionId: original.transaction.id,
		idempotencyKey: "stable-reversal",
	});
	assert.equal(reversal.transaction.bookkeeping?.profileRevision, 1);
	assert.equal(reversal.transaction.bookkeeping?.categoryLabel, "Dining");
	assert.equal(reversal.transaction.bookkeeping?.resolutionSource, "reversal");
});

test("bookkeeping classification supports income categories and account-binding inference", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const bank = fixture.wealth.createAccount({ name: "Bank", type: "asset" });
	const salary = fixture.wealth.createAccount({ name: "Salary", type: "income" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "income.salary",
						label: "Employment income",
						kind: "income",
						accountIds: { HKD: salary.id },
					},
				],
			},
		},
	});

	const posted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_income",
				idempotencyKey: "salary-income",
				payload: {
					description: "Monthly salary",
					amount: "1000.00",
					incomeAccountId: salary.id,
					destinationAccountId: bank.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(posted.transaction.bookkeeping?.categoryId, "income.salary");
	assert.equal(posted.transaction.bookkeeping?.resolutionSource, "account_binding");
});

test("bookkeeping classification supports amount bounds, per-person thresholds, and boolean composition", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense" });
	const coffee = fixture.wealth.createAccount({ name: "Coffee", type: "expense" });
	const taxi = fixture.wealth.createAccount({ name: "Taxi", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.food.dining",
						label: "Dining",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: dining.id },
					},
					{
						id: "expense.food.coffee",
						label: "Coffee",
						kind: "expense",
						parentId: "expense.food",
						accountIds: { HKD: coffee.id },
					},
					{
						id: "expense.transport.taxi",
						label: "Taxi",
						kind: "expense",
						parentId: "expense.transport",
						accountIds: { HKD: taxi.id },
					},
				],
			},
			categorizationRules: {
				upsert: [
					{
						id: "brand.starbucks",
						priority: 300,
						match: {
							transactionKind: "expense",
							all: [{ descriptionContains: "starbucks" }, { amount: { lte: "80.00" } }],
						},
						assign: { categoryId: "expense.food.coffee" },
					},
					{
						id: "product.coffee",
						priority: 200,
						match: { transactionKind: "expense", descriptionContains: "coffee" },
						assign: { categoryId: "expense.food.coffee" },
					},
					{
						id: "scenario.shared-taxi",
						priority: 150,
						match: {
							transactionKind: "expense",
							all: [
								{ descriptionContains: "taxi" },
								{ amountPerPerson: { gte: "40.00", participantCount: 2 } },
							],
						},
						assign: { categoryId: "expense.transport.taxi" },
					},
				],
			},
		},
	});

	const coffeePosted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "composed-coffee",
				payload: {
					description: "Starbucks coffee",
					amount: "42.00",
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(coffeePosted.transaction.bookkeeping?.categorizationRuleId, "brand.starbucks");

	const expensiveStarbucks = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "expensive-starbucks",
				payload: {
					description: "Starbucks coffee",
					amount: "90.00",
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(expensiveStarbucks.transaction.bookkeeping?.categorizationRuleId, "product.coffee");

	const amountMiss = fixture.application.submit(
		withScope(fixture.scope, {
			kind: "explain_bookkeeping_match",
			payload: {
				transactionKind: "expense",
				description: "Starbucks coffee",
				amount: "90.00",
				currency: "HKD",
			},
		}),
		fixture.scope,
	);
	assert.equal(amountMiss.status, "executed");
	const missed = amountMiss.result as {
		categorizationRuleId?: string;
		rejected: Array<{ ruleId: string; reason: string; path: string }>;
	};
	assert.equal(missed.categorizationRuleId, "product.coffee");
	assert.equal(missed.rejected[0]?.ruleId, "brand.starbucks");
	assert.equal(missed.rejected[0]?.reason, "amount");
	assert.equal(missed.rejected[0]?.path, "all[1].amount");

	const taxiPosted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "shared-taxi",
				payload: {
					description: "Airport taxi",
					amount: "80.00",
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(taxiPosted.transaction.bookkeeping?.categorizationRuleId, "scenario.shared-taxi");

	const cheapTaxi = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "cheap-taxi",
				payload: {
					description: "Airport taxi",
					amount: "79.99",
					expenseAccountId: dining.id,
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(cheapTaxi.transaction.bookkeeping?.resolutionSource, "account_binding");
	assert.equal(cheapTaxi.transaction.bookkeeping?.categorizationRuleId, undefined);
});

test("bookkeeping classification expands capture shortcuts and explains higher-priority misses", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const cash = fixture.wealth.createAccount({ name: "Cash", type: "asset" });
	const metro = fixture.wealth.createAccount({ name: "Metro", type: "expense" });
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [
					{
						id: "expense.transport.metro",
						label: "Metro",
						kind: "expense",
						parentId: "expense.transport",
						accountIds: { HKD: metro.id },
					},
				],
			},
			captureShortcuts: {
				upsert: [
					{
						id: "mtr",
						label: "MTR",
						transactionKind: "expense",
						description: "MTR",
						amount: "10.00",
						categoryId: "expense.transport.metro",
					},
				],
			},
			categorizationRules: {
				upsert: [
					{
						id: "brand.mtr",
						priority: 300,
						match: { transactionKind: "expense", descriptionContains: "mtr" },
						assign: { categoryId: "expense.transport.metro" },
					},
					{
						id: "product.metro",
						priority: 200,
						match: { transactionKind: "expense", descriptionContains: "metro" },
						assign: { categoryId: "expense.transport.metro" },
					},
				],
			},
		},
	});

	const posted = executedTransaction(
		fixture.application.submit(
			withScope(fixture.scope, {
				kind: "record_expense",
				idempotencyKey: "shortcut-mtr",
				payload: {
					shortcutId: "mtr",
					fundingAccountId: cash.id,
				},
			}),
			fixture.scope,
		),
	);
	assert.equal(posted.transaction.description, "MTR");
	assert.equal(posted.transaction.bookkeeping?.categoryId, "expense.transport.metro");

	const explanation = fixture.application.submit(
		withScope(fixture.scope, {
			kind: "explain_bookkeeping_match",
			payload: {
				transactionKind: "expense",
				description: "MTR metro",
				amount: "10.00",
				currency: "HKD",
			},
		}),
		fixture.scope,
	);
	assert.equal(explanation.status, "executed");
	const explained = explanation.result as {
		categorizationRuleId?: string;
		winnerPath?: string;
		rejected: Array<{ ruleId: string; reason: string }>;
	};
	assert.equal(explained.categorizationRuleId, "brand.mtr");
	assert.equal(explained.winnerPath, "descriptionContains");
	assert.deepEqual(explained.rejected, []);

	const amountMiss = fixture.application.submit(
		withScope(fixture.scope, {
			kind: "explain_bookkeeping_match",
			payload: {
				transactionKind: "expense",
				description: "coffee",
				amount: "12.00",
				currency: "HKD",
			},
		}),
		fixture.scope,
	);
	assert.equal(amountMiss.status, "executed");
	const missed = amountMiss.result as { rejected: Array<{ ruleId: string; reason: string }> };
	assert.equal(missed.rejected[0]?.ruleId, "brand.mtr");
	assert.equal(missed.rejected[0]?.reason, "descriptionContains");
	assert.equal(missed.rejected[1]?.ruleId, "product.metro");
});
