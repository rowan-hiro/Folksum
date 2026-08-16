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
	await assert.rejects(() => pending, channelError("The voice download was cancelled."));
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

test("refuses a getFile size over the limit without calling fetch", async (context) => {
	let fetched = 0;
	const restoreFetch = stubFetch(context, async () => {
		fetched += 1;
		return audioResponse();
	});
	const download = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/huge.ogg", file_size: 2_049 })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 2_048, signal: new AbortController().signal }),
		channelError("The voice file is larger than the transcription limit."),
	);
	assert.equal(fetched, 0);
	restoreFetch();
});

test("accepts a getFile size equal to the limit and a body that fills it exactly", async (context) => {
	const exact = new Uint8Array(8).fill(9);
	const restoreFetch = stubFetch(context, async () => audioResponse(exact));
	const download = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/ok.ogg", file_size: exact.byteLength })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	const result = await download({
		fileId: "file-1",
		maximumBytes: exact.byteLength,
		signal: new AbortController().signal,
	});
	assert.deepEqual(result.audio, exact);
	restoreFetch();
});

test("stops reading once the streamed body exceeds the size limit", async (context) => {
	let pulls = 0;
	let cancelled = false;
	const restoreFetch = stubFetch(context, async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(6));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200, headers: { "content-type": "audio/ogg" } },
		),
	);
	const download = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/ok.ogg" })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 8, signal: new AbortController().signal }),
		channelError("The voice file is larger than the transcription limit."),
	);
	assert.ok(pulls >= 2 && pulls <= 4, `an oversized body must stop after the overflowing chunk, got ${pulls} pulls`);
	assert.equal(cancelled, true, "an oversized body must cancel the reader");
	restoreFetch();
});

test("forwards the file id and abort signal to getFile", async (context) => {
	const seen: { fileId?: string; aborted?: boolean } = {};
	const restoreFetch = stubFetch(context, async () => audioResponse());
	const download = createTelegramVoiceDownloader(
		voiceBot(async (fileId, signal) => {
			seen.fileId = fileId;
			seen.aborted = signal ? signal.aborted : false;
			return { file_path: "voice/ok.ogg", file_size: AUDIO.byteLength };
		}),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await download({ fileId: "voice-42", maximumBytes: 1_024, signal: new AbortController().signal });
	assert.deepEqual(seen, { fileId: "voice-42", aborted: false });
	restoreFetch();
});

test("reports a refused getFile, a missing path, and a fetch failure with distinct messages", async (context) => {
	const refused = createTelegramVoiceDownloader(
		voiceBot(async () => {
			throw new Error("getFile failed");
		}),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => refused({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("Telegram refused to describe the voice file."),
	);

	const missingPath = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_size: 16 })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => missingPath({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("Telegram returned no downloadable path for the voice file."),
	);

	const restoreFetch = stubFetch(context, async () => {
		throw new TypeError("network down");
	});
	const unreachable = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 1_000,
	});
	await assert.rejects(
		() => unreachable({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("Could not reach the Telegram file API to download the voice message."),
	);
	restoreFetch();
});

test("reports HTTP, empty, and missing-body download failures with distinct messages", async (context) => {
	const restoreFetch = stubFetch(context, async (input) => {
		const url = String(input);
		if (url.endsWith("/missing.ogg")) return new Response(null, { status: 404 });
		if (url.endsWith("/empty.ogg")) return new Response(new Uint8Array(), { status: 200 });
		return { ok: true, status: 200, body: null, headers: new Headers() } as Response;
	});

	const missing = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/missing.ogg" })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => missing({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("Telegram returned HTTP 404 for the voice download."),
	);

	const empty = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/empty.ogg" })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => empty({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("The Telegram voice download was empty."),
	);

	const noContent = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/nobody.ogg" })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	await assert.rejects(
		() => noContent({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal }),
		channelError("The Telegram voice download returned no content."),
	);
	restoreFetch();
});

test("strips content-type parameters and omits mimeType when the header is absent", async (context) => {
	const restoreFetch = stubFetch(context, async (input) => {
		if (String(input).endsWith("/plain.ogg")) return new Response(AUDIO, { status: 200 });
		return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/ogg; codecs=opus" } });
	});
	const withParameter = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 1_000,
	});
	assert.equal(
		(await withParameter({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal })).mimeType,
		"audio/ogg",
	);

	const withoutHeader = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/plain.ogg", file_size: AUDIO.byteLength })),
		TOKEN,
		{ timeoutMilliseconds: 1_000 },
	);
	assert.equal(
		(await withoutHeader({ fileId: "file-1", maximumBytes: 1_024, signal: new AbortController().signal })).mimeType,
		undefined,
	);
	restoreFetch();
});

test("cancels an already-aborted download and a fetch that honors the signal", async (context) => {
	const already = createTelegramVoiceDownloader(hangingGetFileBot(), TOKEN, {
		timeoutMilliseconds: 5_000,
	});
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		() => already({ fileId: "file-1", maximumBytes: 1_024, signal: aborted.signal }),
		channelError("The voice download was cancelled."),
	);

	let fetchSignal: AbortSignal | undefined;
	const restoreFetch = stubFetch(
		context,
		(_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				fetchSignal = init?.signal ?? undefined;
				init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
			}),
	);
	const download = createTelegramVoiceDownloader(resolvedGetFileBot(), TOKEN, {
		timeoutMilliseconds: 5_000,
	});
	const controller = new AbortController();
	const pending = download({ fileId: "file-1", maximumBytes: 1_024, signal: controller.signal });
	await waitUntil(() => fetchSignal !== undefined);
	assert.equal(fetchSignal?.aborted, false);
	controller.abort();
	await assert.rejects(() => pending, channelError("The voice download was cancelled."));
	assert.equal(fetchSignal?.aborted, true);
	restoreFetch();
});

test("cancels a streamed body when the caller aborts mid-read", async (context) => {
	const controller = new AbortController();
	let cancelled = false;
	const restoreFetch = stubFetch(context, async () =>
		new Response(
			new ReadableStream({
				start(stream) {
					stream.enqueue(new Uint8Array([1, 2, 3]));
					queueMicrotask(() => controller.abort());
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200, headers: { "content-type": "audio/ogg" } },
		),
	);
	const download = createTelegramVoiceDownloader(
		voiceBot(async () => ({ file_path: "voice/ok.ogg" })),
		TOKEN,
		{ timeoutMilliseconds: 5_000 },
	);
	await assert.rejects(
		() => download({ fileId: "file-1", maximumBytes: 1_024, signal: controller.signal }),
		channelError("The voice download was cancelled."),
	);
	assert.equal(cancelled, true, "an aborted body must cancel the reader");
	restoreFetch();
});

function hangingGetFileBot(): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return voiceBot(() => new Promise(() => undefined));
}

function resolvedGetFileBot(): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return voiceBot(async () => ({ file_path: "voice/ok.ogg", file_size: AUDIO.byteLength }));
}

function voiceBot(
	getFile: (
		fileId: string,
		signal?: AbortSignal,
	) => Promise<{ file_path?: string; file_size?: number }>,
): Parameters<typeof createTelegramVoiceDownloader>[0] {
	return { api: { getFile } } as unknown as Parameters<typeof createTelegramVoiceDownloader>[0];
}

function audioResponse(audio = AUDIO): Response {
	return new Response(audio, { status: 200, headers: { "content-type": "audio/ogg" } });
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
	return channelError("The voice download timed out.")(error);
}

function channelError(message: string): (error: unknown) => boolean {
	return (error: unknown) => error instanceof TelegramChannelError && error.message === message;
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the download to reach the expected state.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
