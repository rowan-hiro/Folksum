import {
	patchApplicationConfig,
	type ApplicationConfig,
	type ApplicationSettingsPatch,
} from "./config.ts";
import { isCardTrackingMode, type CardTrackingMode } from "../core/card-tracking.ts";

export interface ApplicationSettingsSnapshot {
	cardTrackingMode: CardTrackingMode;
}

export interface ApplicationSettingsUpdate {
	cardTrackingMode?: CardTrackingMode;
}

export interface ApplicationSettingsControllerOptions {
	config: Pick<ApplicationConfig, "configPath" | "cardTrackingMode">;
	env?: Readonly<Record<string, string | undefined>>;
}

export class ApplicationSettingsController {
	private readonly configPath: string;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private settings: ApplicationSettingsSnapshot;

	constructor(options: ApplicationSettingsControllerOptions) {
		this.configPath = options.config.configPath;
		this.env = options.env ?? process.env;
		if (!isCardTrackingMode(options.config.cardTrackingMode)) {
			throw new Error(
				`Unsupported credit-card tracking mode "${String(options.config.cardTrackingMode)}".`,
			);
		}
		this.settings = { cardTrackingMode: options.config.cardTrackingMode };
	}

	current(): ApplicationSettingsSnapshot {
		return { ...this.settings };
	}

	async update(patch: ApplicationSettingsUpdate): Promise<ApplicationSettingsSnapshot> {
		const keys = Object.keys(patch);
		if (keys.length === 0) throw new Error("At least one application setting must be provided.");
		for (const key of keys) {
			if (key !== "cardTrackingMode") {
				throw new Error(`Application setting "${key}" is not supported.`);
			}
		}

		if (!isCardTrackingMode(patch.cardTrackingMode)) {
			throw new Error(
				`Unsupported credit-card tracking mode "${String(patch.cardTrackingMode)}".`,
			);
		}
		const next: ApplicationSettingsSnapshot = {
			cardTrackingMode: patch.cardTrackingMode,
		};
		const persistedPatch: ApplicationSettingsPatch = {
			cardTrackingMode: next.cardTrackingMode,
		};
		patchApplicationConfig(this.configPath, persistedPatch, { env: this.env });
		this.settings = next;
		return this.current();
	}
}
