import assert from "node:assert/strict";
import test from "node:test";

import { ChannelUpdateReceiptStore } from "../src/app/channel-updates.ts";
import { WealthDatabase } from "../src/core/database.ts";

test("claims each external channel update once and retains terminal status", (context) => {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const receipts = new ChannelUpdateReceiptStore(database);
	const first = receipts.claim("telegram", "bot-1:100", new Date("2026-08-12T00:00:00.000Z"));
	assert.equal(first.claimed, true);
	assert.equal(first.receipt.status, "processing");
	assert.equal(receipts.claim("telegram", "bot-1:100").claimed, false);

	const completed = receipts.complete(first.receipt.id, new Date("2026-08-12T00:00:01.000Z"));
	assert.equal(completed.status, "completed");
	assert.equal(completed.completedAt, "2026-08-12T00:00:01.000Z");
	assert.equal(receipts.claim("telegram", "bot-1:100").receipt.status, "completed");
	assert.throws(() => receipts.complete(first.receipt.id), /not processing/);
});

test("marks interrupted work failed without making it replayable", (context) => {
	const database = new WealthDatabase(":memory:");
	context.after(() => database.close());
	const receipts = new ChannelUpdateReceiptStore(database);
	const interrupted = receipts.claim("telegram", "bot-1:101");
	const other = receipts.claim("web", "request-1");

	assert.equal(receipts.failInterrupted("telegram", new Date("2026-08-12T01:00:00.000Z")), 1);
	assert.equal(receipts.get(interrupted.receipt.id).status, "failed");
	assert.match(receipts.get(interrupted.receipt.id).errorMessage ?? "", /interrupted/);
	assert.equal(receipts.get(other.receipt.id).status, "processing");
	assert.equal(receipts.claim("telegram", "bot-1:101").claimed, false);
});
