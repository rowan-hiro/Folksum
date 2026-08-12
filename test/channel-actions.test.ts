import assert from "node:assert/strict";
import test from "node:test";

import { ChannelActionError, ChannelActionRegistry } from "../src/app/channel-actions.ts";
import type { IdentityScope } from "../src/app/identity.ts";

const scope: IdentityScope = {
	householdId: "household-1",
	actorId: "member-1",
	sessionId: "session-1",
	channel: "telegram",
	role: "owner",
	timezone: "UTC",
};

test("binds short-lived actions to one actor and session without allowing denial by another scope", () => {
	const registry = new ChannelActionRegistry(1_000);
	const request = {
		requestId: "choice-1",
		prompt: "Which account?",
		options: [
			{ value: "a", label: "Account A" },
			{ value: "b", label: "Account B" },
		],
	};
	const id = registry.register(scope, { kind: "choice", request }, new Date("2026-08-12T00:00:00.000Z"));
	assert.equal(id.length, 16);
	assert.throws(
		() => registry.consumeChoice(id, { ...scope, actorId: "member-2" }, 0, new Date("2026-08-12T00:00:00.500Z")),
		/another user or conversation/,
	);
	assert.equal(registry.consumeChoice(id, scope, 1, new Date("2026-08-12T00:00:00.500Z")), request);
	assert.throws(() => registry.consumeChoice(id, scope, 1), /unavailable or was already used/);
});

test("rejects expired, wrong-kind, and out-of-range action callbacks without exposing payloads", () => {
	const registry = new ChannelActionRegistry(100);
	const confirmation = {
		pendingOperationId: "operation-1",
		risk: "high" as const,
		summary: "Reverse transaction",
		confirmationToken: "operation-1.secret-nonce",
	};
	const id = registry.register(scope, { kind: "confirmation", request: confirmation }, new Date(0));
	assert.throws(
		() => registry.consumeChoice(id, scope, 0, new Date(50)),
		/does not match/,
	);
	assert.equal(registry.consumeConfirmation(id, scope, new Date(50)), confirmation);

	const expired = registry.register(scope, { kind: "confirmation", request: confirmation }, new Date(0));
	assert.throws(() => registry.consumeConfirmation(expired, scope, new Date(101)), ChannelActionError);
});
