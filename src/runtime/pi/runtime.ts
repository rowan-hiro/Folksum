import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Model, type Api } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { FinanceApplication, type FinanceApplicationResult } from "../../app/finance-application.ts";
import type { IdentityScope } from "../../app/identity.ts";
import { SessionIdentityService, type SessionMessageRole } from "../../app/session.ts";
import { buildFinanceSystemPrompt } from "./system-prompt.ts";
import { createFinanceTools, type PiConfirmationRequest } from "./tools.ts";

export type PiProviderId = "openai" | "anthropic" | "google";
type PersistableAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

export interface PiRuntimeConfig {
	provider: PiProviderId;
	modelId: string;
	application: FinanceApplication;
	identityService: SessionIdentityService;
	scope: IdentityScope;
	currentDate: string;
	onConfirmationRequired?: (request: PiConfirmationRequest) => void;
}

export class PiRuntimeAdapter {
	private readonly agent: Agent;
	private readonly application: FinanceApplication;
	private readonly scope: IdentityScope;
	private textSink: ((delta: string) => void) | undefined;

	constructor(agent: Agent, application: FinanceApplication, scope: IdentityScope) {
		this.agent = agent;
		this.application = application;
		this.scope = scope;
	}

	async prompt(text: string, onText?: (delta: string) => void): Promise<void> {
		this.textSink = onText;
		try {
			await this.agent.prompt(text);
		} finally {
			this.textSink = undefined;
		}
	}

	confirm(confirmationToken: string): FinanceApplicationResult {
		return this.application.confirm(confirmationToken, this.scope);
	}

	reject(pendingOperationId: string): void {
		this.application.reject(pendingOperationId, this.scope);
	}

	abort(): void {
		this.agent.abort();
	}

	setTextSink(sink: ((delta: string) => void) | undefined): void {
		this.textSink = sink;
	}

	emitText(delta: string): void {
		this.textSink?.(delta);
	}
}

export async function createPiRuntime(config: PiRuntimeConfig): Promise<PiRuntimeAdapter> {
	const models = createModels();
	models.setProvider(createProvider(config.provider));
	const auth = await models.checkAuth(config.provider);
	if (!auth) {
		throw new Error(`Provider ${config.provider} is not configured. Set its API key environment variable.`);
	}
	const model = requireModel(models.getModel(config.provider, config.modelId), config.provider, config.modelId);
	const restoredMessages = config.identityService
		.loadMessages(config.scope.sessionId)
		.map((stored) => stored.content)
		.filter(isAgentMessage);
	const tools = createFinanceTools({
		application: config.application,
		scope: config.scope,
		...(config.onConfirmationRequired ? { onConfirmationRequired: config.onConfirmationRequired } : {}),
	});
	const agent = new Agent({
		initialState: {
			systemPrompt: buildFinanceSystemPrompt(config.scope, config.currentDate),
			model,
			thinkingLevel: "low",
			tools,
			messages: restoredMessages,
		},
		streamFn: models.streamSimple.bind(models),
		sessionId: config.scope.sessionId,
		toolExecution: "sequential",
	});
	const adapter = new PiRuntimeAdapter(agent, config.application, config.scope);
	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			adapter.emitText(event.assistantMessageEvent.delta);
		}
		if (event.type === "message_end" && isAgentMessage(event.message)) {
			config.identityService.appendMessage(
				config.scope.sessionId,
				toStoredRole(event.message.role),
				event.message,
			);
		}
	});
	return adapter;
}

function createProvider(provider: PiProviderId) {
	switch (provider) {
		case "openai":
			return openaiProvider();
		case "anthropic":
			return anthropicProvider();
		case "google":
			return googleProvider();
	}
}

function requireModel(model: Model<Api> | undefined, provider: string, modelId: string): Model<Api> {
	if (!model) throw new Error(`Model ${provider}/${modelId} is not available in the installed Pi catalog.`);
	return model;
}

function isAgentMessage(value: unknown): value is PersistableAgentMessage {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	return ["user", "assistant", "toolResult"].includes(String(value.role));
}

function toStoredRole(role: PersistableAgentMessage["role"]): SessionMessageRole {
	if (role === "toolResult") return "tool";
	return role;
}
