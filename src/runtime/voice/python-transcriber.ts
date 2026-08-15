import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_VOICE_COMMAND,
	DEFAULT_VOICE_ENDPOINT,
	DEFAULT_VOICE_MODEL,
	type VoiceTranscriber,
	type VoiceTranscriptionInput,
	type VoiceTranscriptionMode,
	type VoiceTranscriptionResult,
} from "../../app/voice-transcriber.ts";

export const DEFAULT_VOICE_TIMEOUT_MILLISECONDS = 90_000;

const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_LENGTH = 500;
const FORCED_KILL_MILLISECONDS = 2_000;
const INHERITED_ENVIRONMENT_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"SystemRoot",
	"windir",
	"COMSPEC",
	"PATHEXT",
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
] as const;

export class VoiceTranscriptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceTranscriptionError";
	}
}

export interface PythonVoiceTranscriberOptions {
	apiKey: string;
	model?: string;
	endpoint?: string;
	language?: string;
	command?: string;
	scriptPath?: string;
	timeoutMilliseconds?: number;
	forcedKillMilliseconds?: number;
	environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs the bundled Python transcription script as a short-lived child process.
 *
 * The application already holds the audio and the key in memory, so the child is
 * not a memory boundary: what it buys is that the provider upload, the base64
 * encoding, and the ffmpeg conversion run outside this process. The durable
 * guarantee is how the key travels — through the child environment, never
 * through an argument list that other local users could read from the process
 * table, and never into persisted state or a model message.
 */
export class PythonVoiceTranscriber implements VoiceTranscriber {
	private readonly apiKey: string;
	private readonly model: string;
	private readonly endpoint: string;
	private readonly language: string | undefined;
	private readonly command: string;
	private readonly scriptPath: string;
	private readonly timeoutMilliseconds: number;
	private readonly forcedKillMilliseconds: number;
	private readonly environment: Readonly<Record<string, string | undefined>>;

	constructor(options: PythonVoiceTranscriberOptions) {
		const apiKey = options.apiKey.trim();
		if (!apiKey) throw new VoiceTranscriptionError("A voice transcription API key is required.");
		const endpoint = (options.endpoint ?? DEFAULT_VOICE_ENDPOINT).trim();
		if (!endpoint.toLowerCase().startsWith("https://")) {
			throw new VoiceTranscriptionError("The voice transcription endpoint must use HTTPS.");
		}
		const timeout = options.timeoutMilliseconds ?? DEFAULT_VOICE_TIMEOUT_MILLISECONDS;
		if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
			throw new VoiceTranscriptionError("The voice transcription timeout must be between 1 and 600 seconds.");
		}

		this.apiKey = apiKey;
		this.model = (options.model ?? DEFAULT_VOICE_MODEL).trim() || DEFAULT_VOICE_MODEL;
		this.endpoint = endpoint;
		this.language = options.language?.trim() || undefined;
		this.command = (options.command ?? DEFAULT_VOICE_COMMAND).trim() || DEFAULT_VOICE_COMMAND;
		this.scriptPath = options.scriptPath ?? defaultTranscriptionScriptPath();
		this.timeoutMilliseconds = timeout;
		this.forcedKillMilliseconds = options.forcedKillMilliseconds ?? FORCED_KILL_MILLISECONDS;
		this.environment = options.environment ?? process.env;
	}

	async transcribe(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<VoiceTranscriptionResult> {
		if (input.audio.byteLength === 0) throw new VoiceTranscriptionError("The voice message contained no audio.");
		const language = input.language?.trim() || this.language;
		const argv = [
			this.scriptPath,
			"--endpoint",
			this.endpoint,
			"--model",
			this.model,
			"--timeout",
			String(Math.floor(this.timeoutMilliseconds / 1000)),
		];
		if (input.mimeType?.trim()) argv.push("--mime", input.mimeType.trim());
		if (language) argv.push("--language", language);

		const output = await this.run(argv, input.audio, signal);
		return parseTranscriptionOutput(output, language);
	}

	private async run(argv: string[], audio: Uint8Array, signal?: AbortSignal): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new VoiceTranscriptionError("Voice transcription was cancelled."));
				return;
			}

			// A detached child leads its own process group, so a converter it
			// starts can be signalled together with it.
			const child = spawn(this.command, argv, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...childEnvironment(this.environment), FOLKSUM_VOICE_API_KEY: this.apiKey },
				detached: process.platform !== "win32",
			});

			let stdout = "";
			let stderr = "";
			let truncated = false;
			let settled = false;
			let forcedTimer: NodeJS.Timeout | undefined;

			const finish = (error: Error | undefined, value?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(value ?? "");
			};

			/**
			 * Settles the caller immediately but keeps escalating to `SIGKILL`
			 * until the tree exits: a Python or ffmpeg process that ignores
			 * `SIGTERM` must not survive a timeout or a cancellation.
			 */
			const terminate = (message: string): void => {
				terminateTree(child, "SIGTERM");
				if (!forcedTimer) {
					forcedTimer = setTimeout(() => {
						forcedTimer = undefined;
						terminateTree(child, "SIGKILL");
					}, this.forcedKillMilliseconds);
				}
				finish(new VoiceTranscriptionError(message));
			};

			const timeoutTimer = setTimeout(
				() => terminate("Voice transcription timed out."),
				this.timeoutMilliseconds,
			);
			const onAbort = (): void => terminate("Voice transcription was cancelled.");
			signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (stdout.length + chunk.length > MAXIMUM_OUTPUT_BYTES) {
					truncated = true;
					terminate("The voice transcription script produced too much output.");
					return;
				}
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				if (stderr.length < MAXIMUM_DIAGNOSTIC_LENGTH) stderr += chunk;
			});

			child.on("error", (error: NodeJS.ErrnoException) => {
				finish(
					new VoiceTranscriptionError(
						error.code === "ENOENT"
							? `Could not start the voice transcription script: "${this.command}" was not found. Install Python 3 or set the transcription command.`
							: `Could not start the voice transcription script: ${error.message}`,
					),
				);
			});
			child.on("close", (code) => {
				// `close` observes only the direct child. Keep escalation armed while
				// another member of its process group is still alive.
				if (forcedTimer && !hasLivingProcessTree(child)) {
					clearTimeout(forcedTimer);
					forcedTimer = undefined;
				}
				if (truncated) return;
				if (code !== 0) {
					const detail = summarizeDiagnostics(stderr);
					finish(
						new VoiceTranscriptionError(
							`The voice transcription script exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : "."}`,
						),
					);
					return;
				}
				finish(undefined, stdout);
			});

			child.stdin.on("error", () => undefined);
			child.stdin.end(audio);
		});
	}
}

export function defaultTranscriptionScriptPath(): string {
	return fileURLToPath(new URL("../../../python/folksum_transcribe.py", import.meta.url));
}

export function parseTranscriptionOutput(
	output: string,
	language: string | undefined,
): VoiceTranscriptionResult {
	const line = output.trim().split("\n").at(-1)?.trim();
	if (!line) throw new VoiceTranscriptionError("The voice transcription script returned no result.");

	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch {
		throw new VoiceTranscriptionError("The voice transcription script returned a malformed result.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new VoiceTranscriptionError("The voice transcription script returned an unexpected result.");
	}

	const record = parsed as Record<string, unknown>;
	if (record.ok !== true) {
		const reason = typeof record.error === "string" && record.error.trim() ? record.error.trim() : undefined;
		throw new VoiceTranscriptionError(reason ?? "Voice transcription failed.");
	}
	if (typeof record.text !== "string") {
		throw new VoiceTranscriptionError("The voice transcription script returned no transcript text.");
	}

	const reported = typeof record.language === "string" && record.language.trim() ? record.language.trim() : language;
	return { text: record.text, ...(reported ? { language: reported } : {}) };
}

export interface VoiceTranscriptionSettings {
	voiceTranscription: VoiceTranscriptionMode;
	voiceModel: string;
	voiceEndpoint: string;
	voiceCommand: string;
	voiceLanguage?: string;
}

/**
 * Builds the configured transcriber, or `undefined` when voice transcription is
 * disabled. The API key is read from the environment only, so it never enters
 * the JSON configuration file, SQLite, or the model conversation.
 */
export function createVoiceTranscriber(
	settings: VoiceTranscriptionSettings,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): VoiceTranscriber | undefined {
	if (settings.voiceTranscription === "off") return undefined;
	const apiKey = environment.FOLKSUM_VOICE_API_KEY?.trim();
	if (!apiKey) {
		throw new VoiceTranscriptionError(
			"FOLKSUM_VOICE_API_KEY is required when voiceTranscription is enabled. Unset it or set voiceTranscription to off.",
		);
	}
	return new PythonVoiceTranscriber({
		apiKey,
		model: settings.voiceModel,
		endpoint: settings.voiceEndpoint,
		command: settings.voiceCommand,
		...(settings.voiceLanguage ? { language: settings.voiceLanguage } : {}),
		environment,
	});
}

/**
 * Signals the transcription child together with anything it started.
 *
 * The script runs `ffmpeg` through `subprocess.run`, so signalling the Python
 * process alone can leave a converter holding the private temporary audio.
 * POSIX children are spawned detached and therefore lead their own process
 * group, which is signalled as a whole; Windows delegates to `taskkill /T`.
 */
function terminateTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	const pid = child.pid;
	if (pid === undefined) return;

	if (process.platform === "win32") {
		// Windows has no graceful process-tree signal. Start the forced tree kill
		// immediately, while the root pid still identifies its descendants.
		const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
		killer.on("error", () => undefined);
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone, or the child never became a group leader.
		child.kill(signal);
	}
}

/** Reports whether the child or another member of its process tree remains. */
function hasLivingProcessTree(child: ChildProcess): boolean {
	const pid = child.pid;
	if (pid === undefined) return false;
	if (process.platform === "win32") {
		// `taskkill` is launched on the first termination pass and remains a
		// referenced child until it has traversed the tree.
		return child.exitCode === null && child.signalCode === null;
	}

	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return !isMissingProcessError(error);
	}
}

function isMissingProcessError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function childEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of INHERITED_ENVIRONMENT_KEYS) {
		const value = environment[key];
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function summarizeDiagnostics(value: string): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (!normalized) return "";
	return normalized.length <= MAXIMUM_DIAGNOSTIC_LENGTH
		? normalized
		: `${normalized.slice(0, MAXIMUM_DIAGNOSTIC_LENGTH)}…`;
}
