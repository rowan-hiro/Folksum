import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Api, MutableModels } from "@earendil-works/pi-ai";

import type { RuntimeThinkingLevel } from "../../app/config.ts";
import { FinanceApplication, type FinanceApplicationResult } from "../../app/finance-application.ts";
import type { IdentityScope } from "../../app/identity.ts";
import { SessionIdentityService, type SessionMessageRole } from "../../app/session.ts";
import type { CardTrackingMode } from "../../core/card-tracking.ts";
import { FileCredentialStore } from "./credential-store.ts";
import {
	createFolksumModels,
	type SupportedPiProviderId,
} from "./models.ts";
import { PiRuntimeSettingsController } from "./settings.ts";
import { createRuntimeSettingsTool } from "./settings-tool.ts";
import { buildFinanceSystemPrompt } from "./system-prompt.ts";
import { createFinanceTools, type PiConfirmationRequest } from "./tools.ts";

export type PiProviderId = SupportedPiProviderId;
type PersistableAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

export interface PiRuntimeConfig {
	provider: PiProviderId;
	modelId: string;
	application: FinanceApplication;
	identityService: SessionIdentityService;
	scope: IdentityScope;
	currentDate: string;
	cardTrackingMode: CardTrackingMode;
	thinkingLevel?: RuntimeThinkingLevel;
	models?: MutableModels;
	settingsController?: PiRuntimeSettingsController;
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

	applyRuntimeSettings(model: Model<Api>, thinkingLevel: RuntimeThinkingLevel): void {
		this.agent.state.model = model;
		this.agent.state.thinkingLevel = thinkingLevel;
	}
}

export async function createPiRuntime(config: PiRuntimeConfig): Promise<PiRuntimeAdapter> {
	const models = resolveModels(config);
	const selected = config.settingsController?.resolve() ?? {
		provider: config.provider,
		model: requireModel(models.getModel(config.provider, config.modelId), config.provider, config.modelId),
		thinkingLevel: config.thinkingLevel ?? "low",
	};
	const auth = await models.checkAuth(selected.provider);
	if (!auth) {
		throw new Error(
			`Provider ${selected.provider} is not configured. Sign in from the local TUI or configure its supported environment credential.`,
		);
	}
	const restoredMessages = config.identityService
		.loadMessages(config.scope.sessionId)
		.map((stored) => stored.content)
		.filter(isAgentMessage);
	const financeTools = createFinanceTools({
		application: config.application,
		scope: config.scope,
		cardTrackingMode: config.cardTrackingMode,
		...(config.onConfirmationRequired ? { onConfirmationRequired: config.onConfirmationRequired } : {}),
	});
	const tools = config.settingsController
		? [...financeTools, createRuntimeSettingsTool(config.settingsController)]
		: financeTools;
	const agent = new Agent({
		initialState: {
			systemPrompt: buildFinanceSystemPrompt(
				config.scope,
				config.currentDate,
				config.cardTrackingMode,
			),
			model: selected.model,
			thinkingLevel: selected.thinkingLevel,
			tools,
			messages: restoredMessages,
		},
		streamFn: models.streamSimple.bind(models),
		sessionId: config.scope.sessionId,
		toolExecution: "sequential",
		...(config.settingsController
			? { prepareNextTurn: () => config.settingsController?.prepareNextTurn() }
			: {}),
	});
	const adapter = new PiRuntimeAdapter(agent, config.application, config.scope);
	config.settingsController?.attach(adapter);
	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			adapter.emitText(event.assistantMessageEvent.delta);
		}
		if (event.type === "message_end" && isAgentMessage(event.message)) {
			const persisted = projectPersistableAgentMessage(event.message);
			config.identityService.appendMessage(
				config.scope.sessionId,
				toStoredRole(persisted.role),
				persisted,
			);
		}
	});
	return adapter;
}

/**
 * Keep only fields required to restore a Pi conversation. Provider diagnostics,
 * deferred handles, response identifiers, and tool details may contain opaque
 * upstream data and must never cross the SQLite persistence boundary.
 */
export function projectPersistableAgentMessage(
	message: PersistableAgentMessage,
): PersistableAgentMessage {
	switch (message.role) {
		case "user":
			return {
				role: "user",
				content: structuredClone(message.content),
				timestamp: message.timestamp,
			};
		case "assistant":
			return {
				role: "assistant",
				content: structuredClone(message.content),
				api: message.api,
				provider: message.provider,
				model: message.model,
				usage: structuredClone(message.usage),
				stopReason: message.stopReason,
				timestamp: message.timestamp,
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: structuredClone(message.content),
				...(message.usage ? { usage: structuredClone(message.usage) } : {}),
				...(message.addedToolNames
					? { addedToolNames: [...message.addedToolNames] }
					: {}),
				isError: message.isError,
				timestamp: message.timestamp,
			};
	}
}

function resolveModels(config: PiRuntimeConfig): MutableModels {
	if (
		config.models &&
		config.settingsController &&
		config.models !== config.settingsController.models
	) {
		throw new Error("The runtime and settings controller must share the same Pi model catalog.");
	}
	return (
		config.models ??
		config.settingsController?.models ??
		createFolksumModels({ credentials: new FileCredentialStore() })
	);
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
