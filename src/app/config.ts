import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
]);

export type ModelProviderId = "openai" | "anthropic" | "google";

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
}

export interface LoadApplicationConfigOptions {
	cwd?: string;
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
	const configuredPath = env.HWM_CONFIG_PATH;
	if (configuredPath !== undefined && !configuredPath.trim()) {
		throw new ApplicationConfigError("HWM_CONFIG_PATH must not be empty.");
	}

	const configPath = resolve(cwd, configuredPath?.trim() ?? DEFAULT_CONFIG_PATH);
	const file = readConfigFile(configPath, configuredPath !== undefined);
	const unknownKey = Object.keys(file).find((key) => !FILE_KEYS.has(key));
	if (unknownKey) {
		throw new ApplicationConfigError(`Unknown configuration value "${unknownKey}" in ${configPath}.`);
	}
	const provider = requiredString(file, "provider", env.HWM_PROVIDER, "openai");
	if (!isModelProvider(provider)) {
		throw new ApplicationConfigError(
			`Unsupported provider "${provider}". Use openai, anthropic, or google.`,
		);
	}

	const timezone = requiredString(file, "timezone", env.HWM_TIMEZONE, "Asia/Hong_Kong");
	assertTimezone(timezone);
	const model = optionalString(file, "model", env.HWM_MODEL);

	return {
		configPath,
		databasePath: requiredString(file, "databasePath", env.HWM_DB_PATH, ".data/wealth.db"),
		householdName: requiredString(file, "householdName", env.HWM_HOUSEHOLD_NAME, "My Household"),
		baseCurrency: requiredString(file, "baseCurrency", env.HWM_BASE_CURRENCY, "HKD"),
		cliIdentity: requiredString(file, "cliIdentity", env.HWM_CLI_IDENTITY, "local-owner"),
		session: requiredString(file, "session", env.HWM_SESSION, "default"),
		memberName: requiredString(file, "memberName", env.HWM_MEMBER_NAME, "Local Owner"),
		timezone,
		provider,
		...(model ? { model } : {}),
	};
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
	return value === "openai" || value === "anthropic" || value === "google";
}

function assertTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
	} catch {
		throw new ApplicationConfigError(`Invalid IANA timezone "${timezone}".`);
	}
}
