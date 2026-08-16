import assert from "node:assert/strict";
import test from "node:test";

import {
	createTelegramVoiceDownloader,
	DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MILLISECONDS,
	TelegramChannelError,
} from "../src/channels/telegram.ts";

const TOKEN = "test-bot-token";
const AUDIO = new Uint8Array([1, 2, 3, 4]);

test("rejects an invalid voice download timeout at construction", () => {
	const bot = hangingGetFileBot();
	assert.throws(
		() => createTelegramVoiceDownloader(bot, TOKEN, { timeoutMilliseconds: 0 }),
		TelegramChannelError,
	);
	assert.equal(DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MILLISECONDS, 30_000);
});

test("times out a hung Telegram getFile instead of blocking the conversation", async () => {
	const download = createTelegramVoiceDownloader(hangingGetFileBot(), TOKEN, {
		timeoutMilliseconds: 40,
	});
	const started = Date.now();
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		timedOut,
	);
	assert.ok(Date.now() - started < 1_000, "a hung getFile must unblock well before process exit");
});

test("times out a hung Telegram file fetch instead of blocking the conversation", async (context) => {
	const restoreFetch = stubFetch(context, () => new Promise<Response>(() => undefined));
	const download = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 40,
	});
	const started = Date.now();
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		timedOut,
	);
	assert.ok(Date.now() - started < 1_000, "a hung fetch must unblock well before process exit");
	restoreFetch();
});

test("times out a hung Telegram response body instead of blocking the conversation", async (context) => {
	const restoreFetch = stubFetch(
		context,
		async () =>
			new Response(
				new ReadableStream({
					start() {
						// Never enqueue or close: a stalled body must still hit the deadline.
					},
				}),
				{ status: 200, headers: { "content-type": "audio/ogg" } },
			),
	);
	const download = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 40,
	});
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		timedOut,
	);
	restoreFetch();
});

test("cancels a hung download on shutdown without waiting for the timeout", async () => {
	const download = createTelegramVoiceDownloader(hangingGetFileBot(), TOKEN, {
		timeoutMilliseconds: 5_000,
	});
	const controller = new AbortController();
	const pending = download({
		fileId: "file-1",
		maximumBytes: 1_024,
		signal: controller.signal,
	});
	controller.abort();
	const started = Date.now();
	await assert.rejects(
		() => pending,
		(error: unknown) => error instanceof TelegramChannelError && /cancelled/.test(error.message),
	);
	assert.ok(Date.now() - started < 500, "shutdown must cancel without waiting for the download timeout");
});

test("unblocks the next download after a hung getFile times out", async (context) => {
	let calls = 0;
	const bot = voiceBot(async () => {
		calls += 1;
		if (calls === 1) await new Promise(() => undefined);
		return { file_path: "voice/ok.ogg", file_size: AUDIO.byteLength };
	});
	const restoreFetch = stubFetch(context, async () => audioResponse());
	const download = createTelegramVoiceDownloader(bot, TOKEN, { timeoutMilliseconds: 40 });
	const signal = new AbortController().signal;

	await assert.rejects(() => download({ fileId: "stuck", maximumBytes: 1_024, signal }), timedOut);
	const result = await download({ fileId: "next", maximumBytes: 1_024, signal });
	assert.deepEqual(result.audio, AUDIO);
	assert.equal(result.mimeType, "audio/ogg");
	restoreFetch();
});

test("downloads a voice payload when getFile and fetch complete before the deadline", async (context) => {
	const restoreFetch = stubFetch(context, async (input) => {
		assert.match(String(input), /\/file\/bottest-bot-token\/voice\/ok\.ogg$/u);
		return audioResponse();
	});
	const download = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 1_000,
	});
	const result = await download({
		fileId: "file-1",
		maximumBytes: 1_024,
		signal: new AbortController().signal,
	});
	assert.deepEqual(result.audio, AUDIO);
	assert.equal(result.mimeType, "audio/ogg");
	restoreFetch();
});

function hangingGetFileBot(): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return voiceBot(() => new Promise(() => undefined));
}

function resolvedGetFileBot(): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return voiceBot(async () => ({ file_path: "voice/ok.ogg", file_size: AUDIO.byteLength }));
}

function voiceBot(
	getFile: () => Promise<{ file_path?: string; file_size?: number }>,
): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return { api: { getFile } } as unknown as Parameters<typeof createTelegramVoiceDownloader>[0];
}

function audioResponse(): Response {
	return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/ogg" } });
}

function stubFetch(
	context: { after(fn: () => void): void },
	implementation: typeof fetch,
): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = implementation;
	const restore = (): void => {
		globalThis.fetch = original;
	};
	context.after(restore);
	return restore;
}

function timedOut(error: unknown): boolean {
	return error instanceof TelegramChannelError && /timed out/.test(error.message);
}
