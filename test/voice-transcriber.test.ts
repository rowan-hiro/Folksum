import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createVoiceTranscriber,
	defaultTranscriptionScriptPath,
	parseTranscriptionOutput,
	PythonVoiceTranscriber,
	VoiceTranscriptionError,
} from "../src/runtime/voice/python-transcriber.ts";

const pythonCommand = findPython();
const stubOptions = {
	apiKey: "voice-key",
	model: "vendor/model",
	endpoint: "https://openrouter.example/api/v1/chat/completions",
	command: process.execPath,
	environment: { PATH: process.env.PATH ?? "" },
} as const;

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-voice-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** Writes a Node stub that stands in for the Python script. */
function writeStubScript(directory: string, name: string, body: string): string {
	const path = join(directory, name);
	writeFileSync(path, body, "utf8");
	return path;
}

/** Resolves an absolute interpreter path so tests may restrict the child PATH. */
function findPython(): string | undefined {
	for (const candidate of ["python3", "python"]) {
		const probe = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
		if (probe.error || probe.status !== 0) continue;
		const executable = probe.stdout.trim();
		if (executable) return executable;
	}
	return undefined;
}

/** Minimal silent WAV container, so the script never needs ffmpeg during tests. */
function silentWav(): Uint8Array {
	const samples = 160;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + samples * 2, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(16_000, 24);
	header.writeUInt32LE(32_000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(samples * 2, 40);
	return new Uint8Array(Buffer.concat([header, Buffer.alloc(samples * 2)]));
}

test("forwards audio and options to the script while keeping the key out of the argument list", async (context) => {
	const directory = createDirectory(context);
	const script = writeStubScript(
		directory,
		"observe.mjs",
		`import { readFileSync } from "node:fs";
const audio = readFileSync(0);
process.stdout.write(JSON.stringify({
	ok: true,
	text: JSON.stringify({
		argv: process.argv.slice(2),
		audio: Array.from(audio),
		key: process.env.FOLKSUM_VOICE_API_KEY ?? null,
		inherited: process.env.FOLKSUM_TELEGRAM_BOT_TOKEN ?? null,
	}),
	language: "yue",
}) + "\\n");
`,
	);
	const transcriber = new PythonVoiceTranscriber({
		...stubOptions,
		scriptPath: script,
		environment: { PATH: process.env.PATH ?? "", FOLKSUM_TELEGRAM_BOT_TOKEN: "123:secret" },
	});

	const result = await transcriber.transcribe({
		audio: new Uint8Array([9, 8, 7]),
		mimeType: "audio/ogg",
		language: "en",
	});
	assert.equal(result.language, "yue");
	const observed = JSON.parse(result.text) as {
		argv: string[];
		audio: number[];
		key: string | null;
		inherited: string | null;
	};
	assert.deepEqual(observed.argv, [
		"--endpoint",
		"https://openrouter.example/api/v1/chat/completions",
		"--model",
		"vendor/model",
		"--timeout",
		"90",
		"--mime",
		"audio/ogg",
		"--language",
		"en",
	]);
	assert.deepEqual(observed.audio, [9, 8, 7]);
	assert.equal(observed.key, "voice-key");
	assert.equal(observed.inherited, null, "unrelated secrets must not reach the transcription child process");
	assert.equal(
		observed.argv.some((argument) => argument.includes("voice-key")),
		false,
		"the key must never appear in the argument list",
	);
});

test("reports script failures as transcription errors", async (context) => {
	const directory = createDirectory(context);
	const failing = writeStubScript(
		directory,
		"failing.mjs",
		`import { readFileSync } from "node:fs";
readFileSync(0);
process.stdout.write(JSON.stringify({ ok: false, error: "ffmpeg was not found on PATH." }) + "\\n");
`,
	);
	const crashing = writeStubScript(
		directory,
		"crashing.mjs",
		`import { readFileSync } from "node:fs";
readFileSync(0);
process.stderr.write("traceback: exploded\\n");
process.exit(3);
`,
	);
	const garbage = writeStubScript(
		directory,
		"garbage.mjs",
		`import { readFileSync } from "node:fs";
readFileSync(0);
process.stdout.write("not json\\n");
`,
	);
	const audio = { audio: new Uint8Array([1]) };

	await assert.rejects(
		() => new PythonVoiceTranscriber({ ...stubOptions, scriptPath: failing }).transcribe(audio),
		(error: unknown) =>
			error instanceof VoiceTranscriptionError && /ffmpeg was not found on PATH/.test(error.message),
	);
	await assert.rejects(
		() => new PythonVoiceTranscriber({ ...stubOptions, scriptPath: crashing }).transcribe(audio),
		(error: unknown) =>
			error instanceof VoiceTranscriptionError && /exited with code 3.*exploded/su.test(error.message),
	);
	await assert.rejects(
		() => new PythonVoiceTranscriber({ ...stubOptions, scriptPath: garbage }).transcribe(audio),
		(error: unknown) => error instanceof VoiceTranscriptionError && /malformed result/.test(error.message),
	);
	await assert.rejects(
		() =>
			new PythonVoiceTranscriber({
				...stubOptions,
				command: join(directory, "missing-interpreter"),
				scriptPath: failing,
			}).transcribe(audio),
		(error: unknown) => error instanceof VoiceTranscriptionError && /was not found/.test(error.message),
	);
});

test("stops a transcription that exceeds its timeout or is aborted", async (context) => {
	const directory = createDirectory(context);
	const script = writeStubScript(
		directory,
		"slow.mjs",
		`import { readFileSync } from "node:fs";
readFileSync(0);
setTimeout(() => process.stdout.write("{}\\n"), 30_000);
`,
	);

	await assert.rejects(
		() =>
			new PythonVoiceTranscriber({
				...stubOptions,
				scriptPath: script,
				timeoutMilliseconds: 1_000,
			}).transcribe({ audio: new Uint8Array([1]) }),
		(error: unknown) => error instanceof VoiceTranscriptionError && /timed out/.test(error.message),
	);

	const controller = new AbortController();
	const pending = new PythonVoiceTranscriber({ ...stubOptions, scriptPath: script }).transcribe(
		{ audio: new Uint8Array([1]) },
		controller.signal,
	);
	controller.abort();
	await assert.rejects(
		() => pending,
		(error: unknown) => error instanceof VoiceTranscriptionError && /cancelled/.test(error.message),
	);
});

test("kills the whole process tree when the child ignores SIGTERM", async (context) => {
	const directory = createDirectory(context);
	const pidPath = join(directory, "tree.json");
	// The grandchild stands in for the ffmpeg converter that the Python script
	// starts: signalling only the direct child would leave it running.
	const script = writeStubScript(
		directory,
		"stubborn.mjs",
		`import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const descendant = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);"],
	{ stdio: "ignore" },
);
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: process.pid, descendant: descendant.pid }));
process.on("SIGTERM", () => {});
readFileSync(0);
setTimeout(() => {}, 60_000);
`,
	);

	await assert.rejects(
		() =>
			new PythonVoiceTranscriber({
				...stubOptions,
				scriptPath: script,
				timeoutMilliseconds: 1_000,
				forcedKillMilliseconds: 200,
			}).transcribe({ audio: new Uint8Array([1]) }),
		(error: unknown) => error instanceof VoiceTranscriptionError && /timed out/.test(error.message),
	);

	const tree = JSON.parse(readFileSync(pidPath, "utf8")) as { child: number; descendant: number };
	assert.ok(Number.isSafeInteger(tree.child) && tree.child > 0, "the stub child must have recorded its pid");
	assert.ok(
		Number.isSafeInteger(tree.descendant) && tree.descendant > 0,
		"the stub child must have recorded its descendant pid",
	);
	await waitUntilExited(tree.child);
	await waitUntilExited(tree.descendant);
});

test(
	"keeps the forced process-group kill armed after the direct child exits",
	{ skip: process.platform === "win32" ? "Windows does not have a graceful process-tree signal" : false },
	async (context) => {
		const directory = createDirectory(context);
		const pidPath = join(directory, "tree.json");
		let tree: { child: number; descendant: number } | undefined;
		context.after(() => {
			if (!tree) return;
			for (const pid of [tree.child, tree.descendant]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The expected path already terminated both processes.
				}
			}
		});
		const script = writeStubScript(
			directory,
			"parent-exits.mjs",
			`import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const descendant = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);"],
	{ stdio: "ignore" },
);
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: process.pid, descendant: descendant.pid }));
readFileSync(0);
setTimeout(() => {}, 60_000);
`,
		);

		await assert.rejects(
			() =>
				new PythonVoiceTranscriber({
					...stubOptions,
					scriptPath: script,
					timeoutMilliseconds: 1_000,
					forcedKillMilliseconds: 2_000,
				}).transcribe({ audio: new Uint8Array([1]) }),
			(error: unknown) => error instanceof VoiceTranscriptionError && /timed out/.test(error.message),
		);

		tree = JSON.parse(readFileSync(pidPath, "utf8")) as { child: number; descendant: number };
		await waitUntilExited(tree.child, 1_000);
		assert.equal(isProcessAlive(tree.descendant), true, "the descendant must survive the graceful signal");
		await waitUntilExited(tree.descendant);
	},
);

/** Polls a condition so signal-driven behavior can be observed deterministically. */
async function waitFor(
	condition: () => boolean,
	message: string,
	timeoutMilliseconds = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Polls until the process is gone, so the test proves the SIGKILL landed. */
async function waitUntilExited(pid: number, timeoutMilliseconds = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() > deadline) throw new Error(`Process ${pid} survived the forced kill.`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("rejects unusable transcriber configuration and script output", () => {
	assert.throws(() => new PythonVoiceTranscriber({ apiKey: "  " }), VoiceTranscriptionError);
	assert.throws(
		() => new PythonVoiceTranscriber({ apiKey: "key", endpoint: "http://openrouter.example/v1" }),
		/must use HTTPS/,
	);
	assert.throws(
		() => new PythonVoiceTranscriber({ apiKey: "key", timeoutMilliseconds: 5 }),
		/between 1 and 600 seconds/,
	);
	assert.throws(() => parseTranscriptionOutput("   ", undefined), /returned no result/);
	assert.throws(() => parseTranscriptionOutput('{"ok":true}', undefined), /no transcript text/);
	assert.throws(() => parseTranscriptionOutput('{"ok":false,"error":"nope"}', undefined), /nope/);
	assert.throws(() => parseTranscriptionOutput("[1]", undefined), /unexpected result/);
	assert.deepEqual(parseTranscriptionOutput('{"ok":true,"text":"hi"}', "en"), { text: "hi", language: "en" });
	assert.deepEqual(parseTranscriptionOutput('warning\n{"ok":true,"text":"hi"}', undefined), { text: "hi" });
});

test("builds a transcriber only when voice transcription is enabled with an environment key", () => {
	const settings = {
		voiceTranscription: "off",
		voiceModel: "vendor/model",
		voiceEndpoint: "https://openrouter.example/api/v1/chat/completions",
		voiceCommand: "python3",
	} as const;
	assert.equal(createVoiceTranscriber({ ...settings }, {}), undefined);
	assert.equal(
		createVoiceTranscriber({ ...settings }, { FOLKSUM_VOICE_API_KEY: "voice-key" }),
		undefined,
		"a key alone must not enable transcription",
	);
	assert.throws(
		() => createVoiceTranscriber({ ...settings, voiceTranscription: "openrouter" }, {}),
		/FOLKSUM_VOICE_API_KEY is required/,
	);
	assert.ok(
		createVoiceTranscriber(
			{ ...settings, voiceTranscription: "openrouter" },
			{ FOLKSUM_VOICE_API_KEY: "voice-key" },
		) instanceof PythonVoiceTranscriber,
	);
});

test("resolves the bundled transcription script from the package root", () => {
	assert.equal(
		defaultTranscriptionScriptPath(),
		fileURLToPath(new URL("../python/folksum_transcribe.py", import.meta.url)),
	);
});

test(
	"the bundled Python script posts base64 audio and returns a clean transcript",
	{ skip: pythonCommand ? false : "python3 is not installed" },
	() => {
		const audio = silentWav();
		const transcribed = runScriptFunction({
			audio,
			mimeType: "audio/wav",
			payload: { choices: [{ message: { content: "```\ncoffee 42\n```" } }] },
		});
		assert.equal(transcribed.ok, true);
		assert.equal(transcribed.text, "coffee 42");
		assert.equal(transcribed.request?.authorization, "Bearer test-voice-key");
		const body = transcribed.request?.body as {
			model: string;
			messages: Array<{ role: string; content: unknown }>;
		};
		assert.equal(body.model, "vendor/model");
		const parts = body.messages.at(-1)?.content as Array<Record<string, unknown>>;
		const audioPart = parts.find((part) => part.type === "input_audio")?.input_audio as {
			data: string;
			format: string;
		};
		assert.equal(audioPart.format, "wav");
		assert.deepEqual(new Uint8Array(Buffer.from(audioPart.data, "base64")), audio);

		const refused = runScriptFunction({
			audio,
			mimeType: "audio/wav",
			payload: { error: { message: "no credits remain" } },
		});
		assert.equal(refused.ok, false);
		assert.match(String(refused.error), /no credits remain/);

		const unauthorized = runScriptFunction({
			audio,
			mimeType: "audio/wav",
			status: 401,
			payload: { error: { message: "invalid key" } },
		});
		assert.equal(unauthorized.ok, false);
		assert.match(String(unauthorized.error), /HTTP 401/);
		assert.doesNotMatch(String(unauthorized.error), /test-voice-key/);
	},
);

test(
	"the bundled Python script refuses unconvertible audio instead of sending it",
	{ skip: pythonCommand ? false : "python3 is not installed" },
	(context) => {
		const emptyPath = createDirectory(context);
		const result = runScriptFunction({
			audio: new Uint8Array(Buffer.from("OggS not really audio", "utf8")),
			mimeType: "audio/ogg",
			path: emptyPath,
		});
		assert.equal(result.ok, false);
		assert.match(String(result.error), /ffmpeg was not found on PATH/);
		assert.deepEqual(result.request, {}, "unconvertible audio must never be uploaded");
	},
);

test(
	"the bundled Python script refuses a redirect instead of forwarding the key",
	{ skip: pythonCommand ? false : "python3 is not installed" },
	() => {
		const driver = `
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, ${JSON.stringify(dirname(defaultTranscriptionScriptPath()))})
import folksum_transcribe as script

forwarded = []


class Destination(BaseHTTPRequestHandler):
    def handle_any(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        forwarded.append(self.headers.get("authorization"))
        body = b"{}"
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = handle_any
    do_GET = handle_any

    def log_message(self, *arguments):
        pass


destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)
threading.Thread(target=destination.serve_forever, daemon=True).start()
moved_to = "http://127.0.0.1:%d/moved" % destination.server_address[1]


class Redirector(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        self.send_response(302)
        self.send_header("location", moved_to)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *arguments):
        pass


redirector = ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
threading.Thread(target=redirector.serve_forever, daemon=True).start()
endpoint = "http://127.0.0.1:%d/api/v1/chat/completions" % redirector.server_address[1]

body = script.build_request_body(model="vendor/model", audio=b"audio", audio_format="wav", language="")
try:
    script.post_json(endpoint, body, "test-voice-key", 10)
    result = {"ok": True}
except script.TranscriptionError as error:
    result = {"ok": False, "error": script.redact(str(error), "test-voice-key")}
except Exception as error:
    result = {"ok": False, "error": "unexpected %r" % (error,)}
result["forwarded"] = forwarded
print(json.dumps(result))
destination.shutdown()
redirector.shutdown()
`;
		const child = spawnSync(pythonCommand ?? "python3", ["-c", driver], {
			env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
			encoding: "utf8",
		});
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as {
			ok: boolean;
			error?: string;
			forwarded: Array<string | null>;
		};
		assert.equal(result.ok, false);
		assert.match(String(result.error), /HTTP 302 redirect/);
		assert.deepEqual(result.forwarded, [], "the redirect target must never receive the request");
		assert.doesNotMatch(String(result.error), /test-voice-key/);
	},
);

test(
	"the bundled Python script stops its converter and removes the audio on SIGTERM",
	{
		skip: pythonCommand
			? process.platform === "win32"
				? "POSIX signals are not available on Windows"
				: false
			: "python3 is not installed",
	},
	async (context) => {
		const directory = createDirectory(context);
		const binaries = join(directory, "bin");
		const temporary = join(directory, "tmp");
		mkdirSync(binaries);
		mkdirSync(temporary);
		const marker = join(directory, "ffmpeg-started");
		// A stand-in converter that hangs, so the test can interrupt mid-conversion.
		const fakeBody = join(directory, "fake-ffmpeg.mjs");
		writeFileSync(
			fakeBody,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "");
setTimeout(() => {}, 60_000);
`,
		);
		// Absolute paths only: the child PATH holds nothing but this directory.
		const fakeFfmpeg = join(binaries, "ffmpeg");
		writeFileSync(
			fakeFfmpeg,
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeBody)}\n`,
			{ mode: 0o755 },
		);

		const child = spawn(
			pythonCommand ?? "python3",
			[
				defaultTranscriptionScriptPath(),
				"--endpoint",
				"https://openrouter.example/api/v1/chat/completions",
				"--model",
				"vendor/model",
				"--mime",
				"audio/ogg",
			],
			{
				env: {
					PATH: binaries,
					TMPDIR: temporary,
					PYTHONDONTWRITEBYTECODE: "1",
					FOLKSUM_VOICE_API_KEY: "test-voice-key",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		context.after(() => {
			child.kill("SIGKILL");
		});
		child.stdin.end(Buffer.from("OggS not really audio", "utf8"));

		await waitFor(() => existsSync(marker), "the stand-in converter never started");
		assert.equal(
			readdirSync(temporary).some((entry) => entry.startsWith("folksum-voice-")),
			true,
			"the script must stage the audio in a private temporary directory",
		);

		child.kill("SIGTERM");
		const [code] = (await once(child, "close")) as [number | null];
		assert.equal(code, 0, "the script must exit cleanly after a termination signal");
		assert.deepEqual(readdirSync(temporary), [], "the private temporary audio must not survive termination");
	},
);

test(
	"the bundled Python script rejects a plain-HTTP endpoint from its command line",
	{ skip: pythonCommand ? false : "python3 is not installed" },
	() => {
		const child = spawnSync(
			pythonCommand ?? "python3",
			[
				defaultTranscriptionScriptPath(),
				"--endpoint",
				"http://127.0.0.1:1/v1",
				"--model",
				"vendor/model",
			],
			{
				input: Buffer.from(silentWav()),
				env: {
					PATH: process.env.PATH ?? "",
					PYTHONDONTWRITEBYTECODE: "1",
					FOLKSUM_VOICE_API_KEY: "test-voice-key",
				},
				encoding: "utf8",
			},
		);
		assert.equal(child.status, 0);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			ok: false,
			error: "The voice transcription endpoint must use HTTPS.",
		});
	},
);

interface ScriptRun {
	ok: boolean;
	text?: string;
	error?: string;
	request?: { authorization?: string; body?: unknown };
}

/**
 * Drives the script's transcription helpers against a stub endpoint that runs
 * inside the same Python process. The command-line entry point keeps requiring
 * HTTPS for real traffic, so the stub is reached through `post_json` directly.
 */
function runScriptFunction(input: {
	audio: Uint8Array;
	mimeType: string;
	status?: number;
	payload?: unknown;
	path?: string;
}): ScriptRun {
	const driver = `
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, ${JSON.stringify(dirname(defaultTranscriptionScriptPath()))})
import folksum_transcribe as script

REPLY_STATUS = ${input.status ?? 200}
REPLY_BODY = json.dumps(${JSON.stringify(JSON.stringify(input.payload ?? {}))}).encode("utf8")
captured = {}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        captured["authorization"] = self.headers.get("authorization")
        captured["body"] = json.loads(self.rfile.read(length) or b"{}")
        body = json.loads(REPLY_BODY.decode("utf8")).encode("utf8")
        self.send_response(REPLY_STATUS)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *arguments):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = "http://127.0.0.1:%d/api/v1/chat/completions" % server.server_address[1]

audio = sys.stdin.buffer.read()
try:
    payload, audio_format = script.prepare_audio(audio, ${JSON.stringify(input.mimeType)})
    body = script.build_request_body(
        model="vendor/model", audio=payload, audio_format=audio_format, language=""
    )
    response = script.post_json(endpoint, body, "test-voice-key", 10)
    result = {"ok": True, "text": script.extract_text(response)}
except script.TranscriptionError as error:
    result = {"ok": False, "error": script.redact(str(error), "test-voice-key")}
result["request"] = captured
print(json.dumps(result))
server.shutdown()
`;
	const child = spawnSync(pythonCommand ?? "python3", ["-c", driver], {
		input: Buffer.from(input.audio),
		env: { PATH: input.path ?? process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
		encoding: "buffer",
	});
	assert.equal(child.status, 0, child.stderr?.toString("utf8"));
	const line = child.stdout.toString("utf8").trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as ScriptRun;
}
