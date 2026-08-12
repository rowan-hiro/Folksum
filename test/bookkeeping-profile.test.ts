import assert from "node:assert/strict";
import test from "node:test";

import {
	applyBookkeepingProfilePatch,
	BookkeepingProfileError,
	BookkeepingProfileService,
	getDefaultBookkeepingProfile,
	parseBookkeepingProfileJson,
	serializeBookkeepingProfile,
	validateBookkeepingProfile,
} from "../src/app/bookkeeping-profile.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
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
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "profile" });
	return {
		database,
		wealth,
		identities,
		scope,
		profiles: new BookkeepingProfileService(database),
	};
}

test("bookkeeping profile exposes an isolated built-in default at revision zero", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());

	const first = fixture.profiles.getActiveProfile(fixture.wealth.household.id);
	const second = fixture.profiles.getActiveProfile(fixture.wealth.household.id);
	assert.equal(first.revision, 0);
	assert.equal(first.source, "system");
	assert.equal(first.profile.extends, "folksum/default@1");
	assert.ok(first.profile.categories.some((category) => category.id === "expense.food.dining"));
	assert.notStrictEqual(first.profile, second.profile);
	assert.deepEqual(first.profile, getDefaultBookkeepingProfile());
});

test("bookkeeping profile validates and normalizes categories, custom fields, and deterministic rules", () => {
	const profile = validateBookkeepingProfile({
		formatVersion: 1,
		extends: "folksum/default@1",
		categories: [
			{ id: " Expense.Food ", label: " Food ", kind: "expense" },
			{
				id: "expense.food.coffee",
				label: " Coffee ",
				kind: "expense",
				parentId: "expense.food",
			},
		],
		customFields: [
			{
				id: "reimbursable",
				label: " Reimbursable ",
				target: "transaction",
				type: "boolean",
				required: false,
			},
		],
		categorizationRules: [
			{
				id: "merchant.coffee",
				priority: 10,
				match: { transactionKind: "expense", descriptionContains: " STARBUCKS " },
				assign: { categoryId: "expense.food.coffee", fields: { reimbursable: false } },
			},
		],
		exportProfiles: [],
	});

	assert.equal(profile.categories[0]?.id, "expense.food");
	assert.equal(profile.categories[0]?.label, "Food");
	assert.equal(profile.categorizationRules[0]?.match.descriptionContains, "starbucks");
	assert.deepEqual(parseBookkeepingProfileJson(serializeBookkeepingProfile(profile)), profile);
});

test("bookkeeping profile applies collection patches before validating cross-references", () => {
	const profile = getDefaultBookkeepingProfile();
	const patched = applyBookkeepingProfilePatch(profile, {
		categories: {
			upsert: [
				{
					id: "expense.food.coffee",
					label: "Coffee",
					kind: "expense",
					parentId: "expense.food",
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
					id: "merchant.coffee",
					priority: 50,
					match: { transactionKind: "expense", descriptionContains: "coffee" },
					assign: { categoryId: "expense.food.coffee", fields: { reimbursable: false } },
				},
			],
		},
	});
	assert.ok(patched.categories.some((category) => category.id === "expense.food.coffee"));
	assert.equal(patched.categorizationRules[0]?.id, "merchant.coffee");
	assert.throws(
		() =>
			applyBookkeepingProfilePatch(patched, {
				categories: { remove: ["expense.food.coffee"] },
			}),
		/references unknown category "expense.food.coffee"/,
	);
	assert.throws(
		() =>
			applyBookkeepingProfilePatch(profile, {
				categories: { remove: ["expense.missing"] },
			}),
		/cannot remove unknown id "expense.missing"/,
	);
});

test("bookkeeping profile persists immutable revisions with optimistic concurrency and account bindings", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const dining = fixture.wealth.createAccount({ name: "Dining", type: "expense", currency: "HKD" });
	const profile = getDefaultBookkeepingProfile();
	const categories = profile.categories.map((category) =>
		category.id === "expense.food.dining"
			? { ...category, accountIds: { HKD: dining.id } }
			: category,
	);

	const first = fixture.profiles.activateProfile(fixture.scope, {
		profile: { ...profile, categories },
		source: "import",
		expectedRevision: 0,
	});
	assert.equal(first.duplicate, false);
	assert.equal(first.active.revision, 1);
	assert.equal(first.active.source, "import");
	assert.equal(
		first.active.profile.categories.find((category) => category.id === "expense.food.dining")?.accountIds?.HKD,
		dining.id,
	);

	const duplicate = fixture.profiles.activateProfile(fixture.scope, {
		profile: first.active.profile,
		expectedRevision: 1,
	});
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.active.revision, 1);
	assert.throws(
		() => fixture.profiles.activateProfile(fixture.scope, { profile, expectedRevision: 0 }),
		/revision conflict: expected 0, active revision is 1/,
	);

	const second = fixture.profiles.activateProfile(fixture.scope, {
		profile,
		expectedRevision: 1,
	});
	assert.equal(second.active.revision, 2);
	assert.deepEqual(
		fixture.profiles.listRevisions(fixture.wealth.household.id).map((revision) => revision.revision),
		[2, 1],
	);
	assert.throws(
		() =>
			fixture.database.connection
				.prepare("UPDATE bookkeeping_profile_revisions SET source = 'user' WHERE id = ?")
				.run(first.active.id),
		/Bookkeeping profile revisions are immutable/,
	);

	const openingAccount = fixture.wealth.createAccount({
		name: "Opening cash",
		type: "asset",
		openingBalance: "1.00",
	});
	const openingTransaction = fixture.wealth
		.listTransactions()
		.find((transaction) => transaction.postings.some((posting) => posting.accountId === openingAccount.id));
	assert.ok(openingTransaction);
	assert.throws(
		() =>
			fixture.database.connection
				.prepare(
					`INSERT INTO transaction_bookkeeping
						(transaction_id, profile_revision, profile_hash, category_id, category_label,
						 categorization_rule_id, custom_fields_json, resolution_source, created_at)
					 VALUES (?, ?, ?, NULL, NULL, NULL, '{}', 'unclassified', ?)`,
				)
				.run(openingTransaction.id, second.active.revision, "0".repeat(64), new Date().toISOString()),
		/Transaction bookkeeping profile revision does not match its household/,
	);

	fixture.database.connection.exec("DROP TRIGGER bookkeeping_profile_revisions_immutable_update");
	fixture.database.connection
		.prepare("UPDATE bookkeeping_profile_revisions SET profile_hash = ? WHERE id = ?")
		.run("0".repeat(64), second.active.id);
	assert.throws(
		() => fixture.profiles.getActiveProfile(fixture.scope.householdId),
		/does not match its recorded hash/,
	);
});

test("bookkeeping profile rejects unsafe shape, cycles, invalid assignments, and incompatible accounts", (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const asset = fixture.wealth.createAccount({ name: "Checking", type: "asset", currency: "HKD" });
	const base = {
		formatVersion: 1,
		extends: "folksum/default@1",
		customFields: [],
		categorizationRules: [],
		exportProfiles: [],
	};

	assert.throws(
		() => validateBookkeepingProfile({ ...base, categories: [], extra: true }),
		/unknown property "extra"/,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...base,
				categories: [
					{ id: "expense.a", label: "A", kind: "expense", parentId: "expense.b" },
					{ id: "expense.b", label: "B", kind: "expense", parentId: "expense.a" },
				],
			}),
		/category hierarchy contains a cycle/i,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...base,
				categories: [{ id: "income.salary", label: "Salary", kind: "income" }],
				categorizationRules: [
					{
						id: "wrong-kind",
						priority: 1,
						match: { transactionKind: "expense", descriptionContains: "salary" },
						assign: { categoryId: "income.salary" },
					},
				],
			}),
		/cannot assign an income category to an expense transaction/,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...base,
				categories: [],
				customFields: [
					{ id: "cost-center", label: "Cost center", target: "account", type: "text", required: false },
				],
			}),
		/target must be "transaction"/,
	);
	assert.throws(
		() =>
			validateBookkeepingProfile({
				...base,
				categories: [],
				customFields: [
					{ id: "project", label: "Project", target: "transaction", type: "text", required: false },
				],
				categorizationRules: [
					{
						id: "duplicate-fields",
						priority: 1,
						match: { transactionKind: "expense", descriptionContains: "coffee" },
						assign: { fields: { Project: "one", " project ": "two" } },
					},
				],
			}),
		/duplicate assigned field "project"/,
	);
	assert.throws(
		() =>
			fixture.profiles.activateProfile(fixture.scope, {
				profile: {
					...base,
					categories: [
						{
							id: "expense.food",
							label: "Food",
							kind: "expense",
							accountIds: { HKD: asset.id },
						},
					],
				},
			}),
		/requires an open expense account in HKD/,
	);
	assert.throws(
		() =>
			fixture.profiles.activateProfile(fixture.scope, {
				profile: {
					...base,
					categories: [],
					exportProfiles: [
						{
							id: "missing-account",
							label: "Missing account",
							format: "json",
							rowMode: "transactions",
							reversals: "include",
							amountSign: "debit-positive",
							filters: { accountIds: ["missing-account-id"] },
							columns: [{ header: "Id", source: "transaction.id" }],
						},
					],
				},
			}),
		/references unavailable account "missing-account-id"/,
	);
	assert.throws(() => parseBookkeepingProfileJson("{", "profile.json"), BookkeepingProfileError);
});
