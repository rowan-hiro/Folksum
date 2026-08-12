import {
	createModels,
	type Api,
	type CredentialStore,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export const SUPPORTED_PI_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"openai-codex",
	"kimi-coding",
] as const;

export type SupportedPiProviderId = (typeof SUPPORTED_PI_PROVIDERS)[number];

export const DEFAULT_PI_MODELS: Readonly<Record<SupportedPiProviderId, string>> = {
	openai: "gpt-5.6-terra",
	anthropic: "claude-sonnet-5",
	google: "gemini-3.6-flash",
	"openai-codex": "gpt-5.6-terra",
	"kimi-coding": "kimi-for-coding",
};

export interface CreateFolksumModelsOptions {
	credentials?: CredentialStore;
}

export function createFolksumModels(options: CreateFolksumModelsOptions = {}): MutableModels {
	const models = createModels(options.credentials ? { credentials: options.credentials } : undefined);
	models.setProvider(openaiProvider());
	models.setProvider(anthropicProvider());
	models.setProvider(googleProvider());
	models.setProvider(openaiCodexProvider());
	models.setProvider(kimiCodingProvider());
	return models;
}

export function getDefaultPiModel(
	models: MutableModels,
	provider: SupportedPiProviderId,
): Model<Api> {
	const preferred = models.getModel(provider, DEFAULT_PI_MODELS[provider]);
	const model = preferred ?? models.getModels(provider)[0];
	if (!model) throw new Error(`Provider ${provider} has no models in the installed Pi catalog.`);
	return model;
}
