import type { AgentLoopTurnUpdate } from "@earendil-works/pi-agent-core";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

import {
	patchApplicationConfig,
	type ApplicationConfig,
	type RuntimeSettingsPatch,
	type RuntimeThinkingLevel,
} from "../../app/config.ts";
import {
	getDefaultPiModel,
	SUPPORTED_PI_PROVIDERS,
	type SupportedPiProviderId,
} from "./models.ts";

export interface RuntimeSettingsSnapshot {
	provider: SupportedPiProviderId;
	model?: string;
	thinkingLevel: RuntimeThinkingLevel;
}

export interface RuntimeSettingsUpdate {
	provider?: SupportedPiProviderId;
	model?: string;
	thinkingLevel?: RuntimeThinkingLevel;
}

export interface RuntimeSettingsTarget {
	applyRuntimeSettings(model: Model<Api>, thinkingLevel: RuntimeThinkingLevel): void;
}

export interface ResolvedRuntimeSettings {
	provider: SupportedPiProviderId;
	model: Model<Api>;
	thinkingLevel: RuntimeThinkingLevel;
}

export interface PiRuntimeSettingsControllerOptions {
	models: MutableModels;
	config: Pick<ApplicationConfig, "configPath" | "provider" | "model" | "thinkingLevel">;
	env?: Readonly<Record<string, string | undefined>>;
}

export class PiRuntimeSettingsController {
	readonly models: MutableModels;
	private readonly configPath: string;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private settings: RuntimeSettingsSnapshot;
	private target: RuntimeSettingsTarget | undefined;

	constructor(options: PiRuntimeSettingsControllerOptions) {
		this.models = options.models;
		this.configPath = options.config.configPath;
		this.env = options.env ?? process.env;
		assertSupportedProvider(options.config.provider);
		assertRegisteredProvider(this.models, options.config.provider);
		this.settings = {
			provider: options.config.provider,
			...(options.config.model ? { model: options.config.model } : {}),
			thinkingLevel: options.config.thinkingLevel,
		};
	}

	current(): RuntimeSettingsSnapshot {
		return { ...this.settings };
	}

	listModels(provider: SupportedPiProviderId = this.settings.provider): readonly Model<Api>[] {
		assertSupportedProvider(provider);
		assertRegisteredProvider(this.models, provider);
		return [...this.models.getModels(provider)];
	}

	async update(patch: RuntimeSettingsUpdate): Promise<RuntimeSettingsSnapshot> {
		const keys = Object.keys(patch);
		if (keys.length === 0) throw new Error("At least one runtime setting must be provided.");
		for (const key of keys) {
			if (key !== "provider" && key !== "model" && key !== "thinkingLevel") {
				throw new Error(`Runtime setting "${key}" is not supported.`);
			}
		}

		const provider = patch.provider ?? this.settings.provider;
		assertSupportedProvider(provider);
		assertRegisteredProvider(this.models, provider);
		const explicitlySelectedModel = Object.hasOwn(patch, "model");
		let model = explicitlySelectedModel ? patch.model?.trim() : this.settings.model;
		if (explicitlySelectedModel && !model) throw new Error("Model must be a non-empty string.");
		if (model && !this.models.getModel(provider, model)) {
			if (explicitlySelectedModel) {
				throw new Error(`Model ${provider}/${model} is not available in the installed Pi catalog.`);
			}
			model = undefined;
		}
		if (!model) model = getDefaultPiModel(this.models, provider).id;

		const next: RuntimeSettingsSnapshot = {
			provider,
			model,
			thinkingLevel: patch.thinkingLevel ?? this.settings.thinkingLevel,
		};
		const persistedPatch: RuntimeSettingsPatch = {};
		if (Object.hasOwn(patch, "provider")) persistedPatch.provider = provider;
		if (explicitlySelectedModel || model !== this.settings.model) persistedPatch.model = model;
		if (Object.hasOwn(patch, "thinkingLevel")) {
			persistedPatch.thinkingLevel = next.thinkingLevel;
		}
		patchApplicationConfig(this.configPath, persistedPatch, { env: this.env });

		const resolvedModel = requireModel(this.models, provider, model);
		this.settings = next;
		this.target?.applyRuntimeSettings(resolvedModel, next.thinkingLevel);
		return this.current();
	}

	attach(target: RuntimeSettingsTarget): void {
		this.target = target;
		const resolved = this.resolve();
		target.applyRuntimeSettings(resolved.model, resolved.thinkingLevel);
	}

	resolve(): ResolvedRuntimeSettings {
		const modelId = this.settings.model;
		if (!modelId) {
			throw new Error(`No model is selected for provider ${this.settings.provider}.`);
		}
		return {
			provider: this.settings.provider,
			model: requireModel(this.models, this.settings.provider, modelId),
			thinkingLevel: this.settings.thinkingLevel,
		};
	}

	prepareNextTurn(): AgentLoopTurnUpdate {
		const resolved = this.resolve();
		return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}
}

function assertSupportedProvider(provider: string): asserts provider is SupportedPiProviderId {
	if (!SUPPORTED_PI_PROVIDERS.some((candidate) => candidate === provider)) {
		throw new Error(
			`Unsupported provider "${provider}". Use ${SUPPORTED_PI_PROVIDERS.join(", ")}.`,
		);
	}
}

function assertRegisteredProvider(models: MutableModels, provider: SupportedPiProviderId): void {
	if (!models.getProvider(provider)) {
		throw new Error(`Provider ${provider} is not registered in the Pi model catalog.`);
	}
}

function requireModel(
	models: MutableModels,
	provider: SupportedPiProviderId,
	modelId: string,
): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) throw new Error(`Model ${provider}/${modelId} is not available in the installed Pi catalog.`);
	return model;
}
