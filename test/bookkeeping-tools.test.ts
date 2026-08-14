import assert from "node:assert/strict";
import test from "node:test";

import { BookkeepingProfileService } from "../src/app/bookkeeping-profile.ts";
import { ConfirmationStore } from "../src/app/confirmation.ts";
import { FinanceApplication } from "../src/app/finance-application.ts";
import { SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";
import { createFinanceTools, type PiConfirmationRequest } from "../src/runtime/pi/tools.ts";

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
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "tools" });
	const profiles = new BookkeepingProfileService(database);
	const application = new FinanceApplication(wealth, new ConfirmationStore(database), undefined, profiles);
	const pending: PiConfirmationRequest[] = [];
	const tools = createFinanceTools({
		application,
		scope,
		cardTrackingMode: "lightweight",
		onConfirmationRequired: (request) => pending.push(request),
	});
	return { database, wealth, scope, profiles, application, pending, tools };
}

test("bookkeeping profile tools expose the active revision and confirm typed patches", async (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const getProfile = fixture.tools.find((tool) => tool.name === "get_bookkeeping_profile");
	const updateProfile = fixture.tools.find((tool) => tool.name === "update_bookkeeping_profile");
	assert.ok(getProfile);
	assert.ok(updateProfile);

	const read = await getProfile.execute("read-profile", {});
	const readPayload = toolJson(read);
	assert.equal(readPayload.status, "executed");
	assert.equal((readPayload.result as { revision: number }).revision, 0);

	const proposed = await updateProfile.execute("update-profile", {
		expectedRevision: 0,
		patch: {
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
		},
	});
	assert.equal(toolJson(proposed).status, "confirmation_required");
	assert.equal(fixture.profiles.getActiveProfile(fixture.wealth.household.id).revision, 0);
	assert.equal(fixture.pending.length, 1);

	const confirmed = fixture.application.confirm(fixture.pending[0]!.confirmationToken, fixture.scope);
	assert.equal(confirmed.status, "executed");
	const active = fixture.profiles.getActiveProfile(fixture.wealth.household.id);
	assert.equal(active.revision, 1);
	assert.equal(active.source, "agent");
	assert.equal(active.profile.customFields[0]?.id, "reimbursable");
});

test("bookkeeping profile tools explain matches without writing ledger rows", async (context) => {
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
			categorizationRules: {
				upsert: [
					{
						id: "merchant.lunch",
						priority: 10,
						match: { transactionKind: "expense", descriptionContains: "lunch" },
						assign: { categoryId: "expense.food.dining" },
					},
				],
			},
		},
	});
	const explain = fixture.tools.find((tool) => tool.name === "explain_bookkeeping_match");
	assert.ok(explain);
	const result = await explain.execute("explain", {
		transactionKind: "expense",
		description: "Team lunch",
		amount: "38.50",
		currency: "HKD",
	});
	const payload = toolJson(result);
	assert.equal(payload.status, "executed");
	assert.equal((payload.result as { categorizationRuleId?: string }).categorizationRuleId, "merchant.lunch");
	assert.equal(fixture.wealth.listTransactions().length, 0);
	assert.equal(cash.currency, "HKD");
});

test("bookkeeping profile tool confirmation fails closed after a concurrent revision change", async (context) => {
	const fixture = createFixture();
	context.after(() => fixture.database.close());
	const updateProfile = fixture.tools.find((tool) => tool.name === "update_bookkeeping_profile");
	assert.ok(updateProfile);

	await updateProfile.execute("stale-update", {
		expectedRevision: 0,
		patch: {
			categories: {
				upsert: [{ id: "expense.coffee", label: "Coffee", kind: "expense" }],
			},
		},
	});
	fixture.profiles.patchProfile(fixture.scope, {
		expectedRevision: 0,
		source: "user",
		patch: {
			categories: {
				upsert: [{ id: "expense.pets", label: "Pets", kind: "expense" }],
			},
		},
	});
	assert.throws(
		() => fixture.application.confirm(fixture.pending[0]!.confirmationToken, fixture.scope),
		/revision conflict/,
	);
	assert.equal(fixture.profiles.getActiveProfile(fixture.wealth.household.id).revision, 1);
});

function toolJson(result: Awaited<ReturnType<NonNullable<ReturnType<typeof createFinanceTools>[number]>["execute"]>>) {
	const content = result.content.find((item) => item.type === "text");
	if (!content || content.type !== "text") throw new Error("Expected text tool result.");
	return JSON.parse(content.text) as { status: string; result?: unknown };
}
