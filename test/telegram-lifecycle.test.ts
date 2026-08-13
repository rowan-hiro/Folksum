import assert from "node:assert/strict";
import test from "node:test";

import {
	assertTelegramLongPollingAvailable,
	createTelegramStopHandler,
	TelegramChannelError,
} from "../src/channels/telegram.ts";

test("fails closed when a webhook is configured instead of deleting it", () => {
	assert.doesNotThrow(() => assertTelegramLongPollingAvailable({ url: "" }));
	assert.throws(
		() => assertTelegramLongPollingAvailable({ url: "https://example.test/telegram" }),
		TelegramChannelError,
	);
});

test("stops polling once, then aborts in-flight work after the graceful deadline", async () => {
	let stopCalls = 0;
	let shutdownCalls = 0;
	let clearCalls = 0;
	const never = new Promise<void>(() => undefined);
	const timer = setInterval(() => undefined, 60_000);
	const stop = createTelegramStopHandler({
		handle: {
			stop() {
				stopCalls += 1;
				return never;
			},
		},
		coordinator: { shutdown: () => (shutdownCalls += 1) },
		actions: { clear: () => (clearCalls += 1) },
		reminderTimer: timer,
		getReminderTask: async () => undefined,
		gracefulMilliseconds: 1,
		forcedMilliseconds: 1,
	});

	await Promise.all([stop(), stop()]);
	assert.equal(stopCalls, 1);
	assert.equal(shutdownCalls, 2);
	assert.equal(clearCalls, 1);
});
