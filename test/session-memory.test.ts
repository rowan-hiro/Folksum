import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRuleError, MemoryRuleService } from "../src/app/memory.ts";
import { IdentityError, SessionIdentityService } from "../src/app/session.ts";
import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(): {
	database: WealthDatabase;
	wealth: WealthService;
	identities: SessionIdentityService;
	memory: MemoryRuleService;
} {
	const database = new WealthDatabase(":memory:");
	const wealth = new WealthService(database, { baseCurrency: "HKD" });
	return {
		database,
		wealth,
		identities: new SessionIdentityService(database),
		memory: new MemoryRuleService(database),
	};
}

test("resolves channel identities into stable application sessions", (context) => {
	const { database, wealth, identities } = createFixture();
	context.after(() => database.close());

	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "local-owner" });

	const first = identities.resolve({ channel: "cli", externalId: "local-owner", conversationKey: "default" });
	const resumed = identities.resolve({ channel: "cli", externalId: "local-owner", conversationKey: "default" });
	const separate = identities.resolve({ channel: "cli", externalId: "local-owner", conversationKey: "planning" });
	assert.equal(resumed.sessionId, first.sessionId);
	assert.notEqual(separate.sessionId, first.sessionId);
	assert.equal(first.householdId, wealth.household.id);
	assert.equal(first.role, "owner");
	assert.throws(
		() => identities.resolve({ channel: "telegram", externalId: "unknown", conversationKey: "chat" }),
		IdentityError,
	);
});

test("persists channel-neutral JSON transcripts under the application session", (context) => {
	const { database, wealth, identities } = createFixture();
	context.after(() => database.close());

	const member = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Member",
		role: "member",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: member.id, channel: "web", externalId: "user-1" });
	const scope = identities.resolve({ channel: "web", externalId: "user-1", conversationKey: "browser-tab" });
	identities.appendMessage(scope.sessionId, "user", { text: "Lunch was 38.50" });
	identities.appendMessage(scope.sessionId, "assistant", { text: "Recorded." });

	assert.deepEqual(
		identities.loadMessages(scope.sessionId).map((message) => [message.sequence, message.role, message.content]),
		[
			[1, "user", { text: "Lunch was 38.50" }],
			[2, "assistant", { text: "Recorded." }],
		],
	);
});

test("stores only validated typed rules and excludes expired memory", (context) => {
	const { database, wealth, identities, memory } = createFixture();
	context.after(() => database.close());

	const owner = identities.createMember({
		householdId: wealth.household.id,
		displayName: "Owner",
		role: "owner",
		timezone: "Asia/Hong_Kong",
	});
	identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId: "owner" });
	const scope = identities.resolve({ channel: "cli", externalId: "owner", conversationKey: "default" });
	const account = wealth.createAccount({ name: "Joint Checking", type: "asset" });

	memory.setRule(scope, {
		kind: "account_alias",
		key: "our bank",
		value: { accountId: account.id },
	});
	memory.setRule(scope, {
		kind: "reminder_policy",
		key: "cards",
		value: { daysBefore: [7, 3, 1, 0], overdueDaily: true },
	});
	memory.setRule(scope, {
		kind: "preference",
		key: "old-preference",
		value: { value: true },
		expiresAt: "2026-01-01T00:00:00.000Z",
	});

	assert.equal(memory.resolveAccountAlias(scope.householdId, "Our Bank"), account.id);
	assert.deepEqual(
		memory.listActiveRules(scope.householdId, "2026-08-11T00:00:00.000Z").map((rule) => rule.kind),
		["account_alias", "reminder_policy"],
	);
	assert.throws(
		() =>
			memory.setRule(scope, {
				kind: "reminder_policy",
				key: "invalid",
				value: { daysBefore: [7, 2.5], overdueDaily: true },
			}),
		MemoryRuleError,
	);
	assert.throws(
		() =>
			memory.setRule(
				{ ...scope, role: "viewer" },
				{ kind: "preference", key: "currency", value: { value: "HKD" } },
			),
		/Viewer role/,
	);
});
