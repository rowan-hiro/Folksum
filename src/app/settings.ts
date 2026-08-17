import {
	patchApplicationConfig,
	type ApplicationConfig,
	type ApplicationSettingsPatch,
} from "./config.ts";
import { isCardTrackingMode, type CardTrackingMode } from "../core/card-tracking.ts";
import {
	isVoiceTranscriptionMode,
	type VoiceTranscriptionMode,
} from "./voice-transcriber.ts";

export interface ApplicationSettingsSnapshot {
	cardTrackingMode: CardTrackingMode;
	voiceTranscription: VoiceTranscriptionMode;
	voiceModel: string;
}

export interface ApplicationSettingsUpdate {
	cardTrackingMode?: CardTrackingMode;
	voiceTranscription?: VoiceTranscriptionMode;
	voiceModel?: string;
}

export interface ApplicationSettingsControllerOptions {
	config: Pick<
		ApplicationConfig,
		"configPath" | "cardTrackingMode" | "voiceTranscription" | "voiceModel"
	>;
	env?: Readonly<Record<string, string | undefined>>;
}

const SUPPORTED_SETTING_KEYS = new Set([
	"cardTrackingMode",
	"voiceTranscription",
	"voiceModel",
]);

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
		if (!isVoiceTranscriptionMode(options.config.voiceTranscription)) {
			throw new Error(
				`Unsupported voice transcription mode "${String(options.config.voiceTranscription)}".`,
			);
		}
		const voiceModel = options.config.voiceModel.trim();
		if (!voiceModel) {
			throw new Error('Configuration value "voiceModel" must be a non-empty string.');
		}
		this.settings = {
			cardTrackingMode: options.config.cardTrackingMode,
			voiceTranscription: options.config.voiceTranscription,
			voiceModel,
		};
	}

	current(): ApplicationSettingsSnapshot {
		return { ...this.settings };
	}

	async update(patch: ApplicationSettingsUpdate): Promise<ApplicationSettingsSnapshot> {
		const keys = Object.keys(patch);
		if (keys.length === 0) throw new Error("At least one application setting must be provided.");
		for (const key of keys) {
			if (!SUPPORTED_SETTING_KEYS.has(key)) {
				throw new Error(`Application setting "${key}" is not supported.`);
			}
		}

		if (
			patch.cardTrackingMode !== undefined &&
			!isCardTrackingMode(patch.cardTrackingMode)
		) {
			throw new Error(
				`Unsupported credit-card tracking mode "${String(patch.cardTrackingMode)}".`,
			);
		}
		if (
			patch.voiceTranscription !== undefined &&
			!isVoiceTranscriptionMode(patch.voiceTranscription)
		) {
			throw new Error(
				`Unsupported voice transcription mode "${String(patch.voiceTranscription)}".`,
			);
		}
		if (patch.voiceModel !== undefined && !patch.voiceModel.trim()) {
			throw new Error('Configuration value "voiceModel" must be a non-empty string.');
		}

		const next: ApplicationSettingsSnapshot = {
			cardTrackingMode: patch.cardTrackingMode ?? this.settings.cardTrackingMode,
			voiceTranscription: patch.voiceTranscription ?? this.settings.voiceTranscription,
			voiceModel: patch.voiceModel?.trim() ?? this.settings.voiceModel,
		};
		const persistedPatch: ApplicationSettingsPatch = {};
		if (patch.cardTrackingMode !== undefined) persistedPatch.cardTrackingMode = next.cardTrackingMode;
		if (patch.voiceTranscription !== undefined) {
			persistedPatch.voiceTranscription = next.voiceTranscription;
		}
		if (patch.voiceModel !== undefined) persistedPatch.voiceModel = next.voiceModel;
		patchApplicationConfig(this.configPath, persistedPatch, { env: this.env });
		this.settings = next;
		return this.current();
	}
}
