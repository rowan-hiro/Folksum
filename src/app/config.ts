import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
	CARD_TRACKING_MODES,
	isCardTrackingMode,
	type CardTrackingMode,
} from "../core/card-tracking.ts";

const DEFAULT_CONFIG_PATH = ".data/config.json";
const FILE_KEYS = new Set([
	"databasePath",
	"householdName",
	"baseCurrency",
	"cliIdentity",
	"session",
	"memberName",
	"timezone",
	"provider",
	"model",
	"thinkingLevel",
	"cardTrackingMode",
]);

const WRITABLE_SETTING_ENVIRONMENT_VARIABLES = {
	provider: "FOLKSUM_PROVIDER",
	model: "FOLKSUM_MODEL",
	thinkingLevel: "FOLKSUM_THINKING_LEVEL",
	cardTrackingMode: "FOLKSUM_CARD_TRACKING_MODE",
} as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelProviderId =
	| "openai"
	| "openai-codex"
	| "anthropic"
	| "google"
	| "kimi-coding";
export type RuntimeThinkingLevel = (typeof THINKING_LEVELS)[number];
export type WritableApplicationSettingKey = keyof typeof WRITABLE_SETTING_ENVIRONMENT_VARIABLES;

export interface RuntimeSettingsPatch {
	provider?: ModelProviderId;
	model?: string | null;
	thinkingLevel?: RuntimeThinkingLevel;
}

export interface ApplicationSettingsPatch {
	cardTrackingMode?: CardTrackingMode;
}

export type ApplicationConfigPatch = RuntimeSettingsPatch & ApplicationSettingsPatch;

export interface ApplicationConfig {
	configPath: string;
	databasePath: string;
	householdName: string;
	baseCurrency: string;
	cliIdentity: string;
	session: string;
	memberName: string;
	timezone: string;
	provider: ModelProviderId;
	model?: string;
	thinkingLevel: RuntimeThinkingLevel;
	cardTrackingMode: CardTrackingMode;
}

export interface LoadApplicationConfigOptions {
	cwd?: string;
	env?: Readonly<Record<string, string | undefined>>;
}

export interface PatchApplicationConfigOptions {
	env?: Readonly<Record<string, string | undefined>>;
}

export class ApplicationConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplicationConfigError";
	}
}

export function loadApplicationConfig(options: LoadApplicationConfigOptions = {}): ApplicationConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const configuredPath = env.FOLKSUM_CONFIG_PATH;
	if (configuredPath !== undefined && !configuredPath.trim()) {
		throw new ApplicationConfigError("FOLKSUM_CONFIG_PATH must not be empty.");
	}

	const configPath = resolve(cwd, configuredPath?.trim() ?? DEFAULT_CONFIG_PATH);
	const file = readConfigFile(configPath, configuredPath !== undefined);
	const unknownKey = Object.keys(file).find((key) => !FILE_KEYS.has(key));
	if (unknownKey) {
		throw new ApplicationConfigError(`Unknown configuration value "${unknownKey}" in ${configPath}.`);
	}
	const provider = requiredString(file, "provider", env.FOLKSUM_PROVIDER, "openai");
	if (!isModelProvider(provider)) {
		throw new ApplicationConfigError(
			`Unsupported provider "${provider}". Use openai, openai-codex, anthropic, google, or kimi-coding.`,
		);
	}

	const timezone = requiredString(file, "timezone", env.FOLKSUM_TIMEZONE, "Asia/Hong_Kong");
	assertTimezone(timezone);
	const model = optionalString(file, "model", env.FOLKSUM_MODEL);
	const thinkingLevel = requiredString(file, "thinkingLevel", env.FOLKSUM_THINKING_LEVEL, "low");
	if (!isRuntimeThinkingLevel(thinkingLevel)) {
		throw new ApplicationConfigError(
			`Unsupported thinking level "${thinkingLevel}". Use ${THINKING_LEVELS.join(", ")}.`,
		);
	}
	const cardTrackingMode = requiredString(
		file,
		"cardTrackingMode",
		env.FOLKSUM_CARD_TRACKING_MODE,
		"lightweight",
	);
	if (!isCardTrackingMode(cardTrackingMode)) {
		throw new ApplicationConfigError(
			`Unsupported credit-card tracking mode "${cardTrackingMode}". Use ${CARD_TRACKING_MODES.join(", ")}.`,
		);
	}

	return {
		configPath,
		databasePath: requiredString(file, "databasePath", env.FOLKSUM_DB_PATH, ".data/wealth.db"),
		householdName: requiredString(file, "householdName", env.FOLKSUM_HOUSEHOLD_NAME, "My Household"),
		baseCurrency: requiredString(file, "baseCurrency", env.FOLKSUM_BASE_CURRENCY, "HKD"),
		cliIdentity: requiredString(file, "cliIdentity", env.FOLKSUM_CLI_IDENTITY, "local-owner"),
		session: requiredString(file, "session", env.FOLKSUM_SESSION, "default"),
		memberName: requiredString(file, "memberName", env.FOLKSUM_MEMBER_NAME, "Local Owner"),
		timezone,
		provider,
		...(model ? { model } : {}),
		thinkingLevel,
		cardTrackingMode,
	};
}

export function patchApplicationConfig(
	configPath: string,
	patch: ApplicationConfigPatch,
	options: PatchApplicationConfigOptions = {},
): void {
	const env = options.env ?? process.env;
	const patchRecord = patch as Record<string, unknown>;
	const keys = Object.keys(patchRecord);
	if (keys.length === 0) {
		throw new ApplicationConfigError("At least one writable setting must be provided.");
	}

	for (const key of keys) {
		if (!(key in WRITABLE_SETTING_ENVIRONMENT_VARIABLES)) {
			throw new ApplicationConfigError(`Configuration value "${key}" cannot be changed at runtime.`);
		}
		const environmentName =
			WRITABLE_SETTING_ENVIRONMENT_VARIABLES[key as WritableApplicationSettingKey];
		if (env[environmentName] !== undefined) {
			throw new ApplicationConfigError(
				`Configuration value "${key}" is overridden by ${environmentName} and cannot be changed in the JSON file.`,
			);
		}
	}

	validateApplicationConfigPatch(patchRecord);
	const file = readConfigFile(configPath, false);
	for (const key of keys as WritableApplicationSettingKey[]) {
		const value = patchRecord[key];
		if (key === "model" && value === null) {
			delete file.model;
		} else {
			file[key] = key === "model" && typeof value === "string" ? value.trim() : value;
		}
	}
	writeJsonAtomically(configPath, file);
}

function readConfigFile(path: string, required: boolean): Record<string, unknown> {
	if (!existsSync(path)) {
		if (required) throw new ApplicationConfigError(`Configuration file was not found at ${path}.`);
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ApplicationConfigError(`Could not read configuration file ${path}: ${reason}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ApplicationConfigError(`Configuration file ${path} must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function requiredString(
	file: Record<string, unknown>,
	key: string,
	environmentValue: string | undefined,
	fallback: string,
): string {
	const value = environmentValue !== undefined ? environmentValue : (file[key] ?? fallback);
	if (typeof value !== "string" || !value.trim()) {
		throw new ApplicationConfigError(`Configuration value "${key}" must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(
	file: Record<string, unknown>,
	key: string,
	environmentValue: string | undefined,
): string | undefined {
	const value = environmentValue !== undefined ? environmentValue : file[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ApplicationConfigError(`Configuration value "${key}" must be a string.`);
	}
	return value.trim() || undefined;
}

function isModelProvider(value: string): value is ModelProviderId {
	return (
		value === "openai" ||
		value === "openai-codex" ||
		value === "anthropic" ||
		value === "google" ||
		value === "kimi-coding"
	);
}

export function isRuntimeThinkingLevel(value: string): value is RuntimeThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

function validateApplicationConfigPatch(patch: Record<string, unknown>): void {
	if ("provider" in patch && (typeof patch.provider !== "string" || !isModelProvider(patch.provider))) {
		throw new ApplicationConfigError(
			`Unsupported provider "${String(patch.provider)}". Use openai, openai-codex, anthropic, google, or kimi-coding.`,
		);
	}
	if (
		"model" in patch &&
		patch.model !== null &&
		(typeof patch.model !== "string" || !patch.model.trim())
	) {
		throw new ApplicationConfigError('Configuration value "model" must be a non-empty string or null.');
	}
	if (
		"thinkingLevel" in patch &&
		(typeof patch.thinkingLevel !== "string" || !isRuntimeThinkingLevel(patch.thinkingLevel))
	) {
		throw new ApplicationConfigError(
			`Unsupported thinking level "${String(patch.thinkingLevel)}". Use ${THINKING_LEVELS.join(", ")}.`,
		);
	}
	if (
		"cardTrackingMode" in patch &&
		(typeof patch.cardTrackingMode !== "string" || !isCardTrackingMode(patch.cardTrackingMode))
	) {
		throw new ApplicationConfigError(
			`Unsupported credit-card tracking mode "${String(patch.cardTrackingMode)}". Use ${CARD_TRACKING_MODES.join(", ")}.`,
		);
	}
}

function writeJsonAtomically(path: string, value: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function assertTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
	} catch {
		throw new ApplicationConfigError(`Invalid IANA timezone "${timezone}".`);
	}
}
