import assert from "node:assert/strict";
import test from "node:test";

import { BookkeepingExportService } from "../src/app/bookkeeping-export.ts";
import {
	BookkeepingProfileService,
	getDefaultBookkeepingProfile,
	validateBookkeepingProfile,
} from "../src/app/bookkeeping-profile.ts";
import { ConfirmationStore } from "../src/app/confirmation.ts";
import { FinanceApplication } from "../src/app/finance-application.ts";
import type { FinanceIr } from "../src/app/finance-ir.ts";
import type { IdentityScope } from "../src/app/identity.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import type { PostedTransaction } from "../src/core/types.ts";
import { WealthService } from "../src/core/wealth-service.ts";
import { createFinanceTools } from "../src/runtime/pi/tools.ts";

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
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "export" });
	const profiles = new BookkeepingProfileService(database);
	const application = new FinanceApplication(wealth, new ConfirmationStore(database), undefined, profiles);
	const exporter = new BookkeepingExportService(wealth, profiles);
	const cash = wealth.createAccount({ name: "Cash", type: "asset" });
	const dining = wealth.createAccount({ name: "Dining", type: "expense" });
	profiles.patchProfile(scope, {
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
						id: "project",
						label: "Project",
						target: "transaction",
						type: "text",
						required: false,
					},
				],
			},
			exportProfiles: {
				upsert: [
					{
						id: "accountant.csv",
						label: "Accountant CSV",
						format: "csv",
						rowMode: "postings",
						reversals: "include",
						amountSign: "debit-positive",
						delimiter: ",",
						filters: { categoryIds: ["expense.food.dining"] },
						columns: [
							{ header: "Date", source: "transaction.date" },
							{ header: "Description", source: "transaction.description" },
							{ header: "Category", source: "bookkeeping.categoryId" },
							{ header: "Account", source: "posting.accountName" },
							{ header: "Amount", source: "posting.amount" },
							{ header: "Project", source: "customFields.project" },
						],
					},
					{
						id: "audit.json",
						label: "Audit JSON",
						format: "json",
						rowMode: "transactions",
						reversals: "exclude",
						amountSign: "debit-positive",
						columns: [
							{ header: "id", source: "transaction.id" },
							{ header: "description", source: "transaction.description" },
							{ header: "profileRevision", source: "bookkeeping.profileRevision" },
							{ header: "project", source: "customFields.project" },
						],
					},
				],
			},
		},
	});
	return { database, wealth, scope, profiles, application, exporter, cash, dining };
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

function recordExpense(
	fixture: ReturnType<typeof createFixture>,
	idempotencyKey: string,
	description: string,
	amount: string,
	project: string,
): PostedTransaction {
	const result = fixture.application.submit(
		withScope(fixture.scope, {
			kind: "record_expense",
			idempotencyKey,
			payload: {
				description,
				amount,
				categoryId: "expense.food.dining",
				customFields: { project },
				fundingAccountId: fixture.cash.id,
				occurredAt: "2026-08-12",
			},
		}),
		fixture.scope,
	);
	assert.equal(result.status, "executed");
	return result.result as PostedTransaction;
}

test("bookkeeping export renders deterministic posting CSV with exact signed amounts and reversals", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const first = recordExpense(fixture, "coffee", "Coffee, beans", "12.30", "alpha");
	recordExpense(fixture, "lunch", "=SUM(1,1)", "38.50", "beta");
	fixture.wealth.reverseTransaction({
		transactionId: first.transaction.id,
		occurredAt: "2026-08-13",
		idempotencyKey: "reverse-coffee",
	});

	const artifact = fixture.exporter.render({
		householdId: fixture.scope.householdId,
		exportProfileId: "accountant.csv",
		from: "2026-08-12",
		to: "2026-08-13",
	});
	assert.equal(artifact.totalRows, 6);
	assert.equal(artifact.truncated, false);
	assert.match(artifact.content, /^Date,Description,Category,Account,Amount,Project\n/);
	assert.match(
		artifact.content,
		/2026-08-12,"Coffee, beans",expense\.food\.dining,Dining,12\.30,alpha/,
	);
	assert.match(
		artifact.content,
		/2026-08-12,"Coffee, beans",expense\.food\.dining,Cash,-12\.30,alpha/,
	);
	assert.match(artifact.content, /2026-08-13,"Reversal: Coffee, beans"/);
	assert.match(artifact.content, /"'=SUM\(1,1\)"/);
	assert.doesNotMatch(artifact.content, /12\.299999/);
});

test("bookkeeping export renders transaction JSON and bounded read-only tool previews", async (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	recordExpense(fixture, "coffee", "Coffee", "12.30", "alpha");
	recordExpense(fixture, "lunch", "Lunch", "38.50", "beta");
	const artifact = fixture.exporter.render({
		householdId: fixture.scope.householdId,
		exportProfileId: "audit.json",
		from: "2026-08-12",
		to: "2026-08-12",
	});
	const parsed = JSON.parse(artifact.content) as Array<Record<string, unknown>>;
	assert.equal(parsed.length, 2);
	assert.deepEqual(parsed.map((row) => row.project), ["alpha", "beta"]);
	assert.deepEqual(parsed.map((row) => row.profileRevision), [1, 1]);

	const tools = createFinanceTools({
		application: fixture.application,
		scope: fixture.scope,
		cardTrackingMode: "lightweight",
	});
	const preview = tools.find((tool) => tool.name === "preview_bookkeeping_export");
	assert.ok(preview);
	const result = await preview.execute("preview", {
		exportProfileId: "audit.json",
		from: "2026-08-12",
		to: "2026-08-12",
		limit: 1,
	});
	const content = result.content.find((item) => item.type === "text");
	if (!content || content.type !== "text") throw new Error("Expected preview tool text.");
	const payload = JSON.parse(content.text) as {
		status: string;
		result: { totalRows: number; rows: unknown[]; truncated: boolean };
	};
	assert.equal(payload.status, "executed");
	assert.equal(payload.result.totalRows, 2);
	assert.equal(payload.result.rows.length, 1);
	assert.equal(payload.result.truncated, true);
});

test("bookkeeping export rejects previews that exceed the serialized response bound", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	recordExpense(fixture, "large-preview", "x".repeat(60_000), "12.30", "alpha");
	assert.throws(
		() =>
			fixture.exporter.preview({
				householdId: fixture.scope.householdId,
				exportProfileId: "audit.json",
				from: "2026-08-12",
				to: "2026-08-12",
				limit: 1,
			}),
		/exceeds 100000 bytes/,
	);
});

test("bookkeeping export profile validation rejects executable, incompatible, and unresolved projections", () => {
	const profile = getDefaultBookkeepingProfile();
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...profile,
				exportProfiles: [
					{
						id: "unsafe",
						label: "Unsafe",
						format: "csv",
						rowMode: "transactions",
						reversals: "include",
						amountSign: "debit-positive",
						columns: [{ header: "SQL", source: "sql:SELECT * FROM transactions" }],
					},
				],
			}),
		/unsupported source/,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...profile,
				exportProfiles: [
					{
						id: "wrong-row",
						label: "Wrong row",
						format: "json",
						rowMode: "transactions",
						reversals: "include",
						amountSign: "debit-positive",
						columns: [{ header: "Amount", source: "posting.amount" }],
					},
				],
			}),
		/cannot use a posting source in transaction row mode/,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...profile,
				exportProfiles: [
					{
						id: "missing-field",
						label: "Missing field",
						format: "json",
						rowMode: "transactions",
						reversals: "include",
						amountSign: "debit-positive",
						columns: [{ header: "Missing", source: "customFields.missing" }],
					},
				],
			}),
		/references unknown custom field "missing"/,
	);
});
