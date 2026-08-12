import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { RuntimeThinkingLevel } from "../../app/config.ts";
import type { SupportedPiProviderId } from "./models.ts";
import {
	PiRuntimeSettingsController,
	type RuntimeSettingsSnapshot,
} from "./settings.ts";

interface UpdateRuntimeSettingsParams {
	provider?: SupportedPiProviderId;
	model?: string;
	thinkingLevel?: RuntimeThinkingLevel;
}

export interface RuntimeSettingsToolDetails {
	status: "updated";
	settings: RuntimeSettingsSnapshot;
}

export function createRuntimeSettingsTool(
	controller: PiRuntimeSettingsController,
): AgentTool {
	return {
		name: "update_runtime_settings",
		label: "Update runtime settings",
		description:
			"Persist and immediately apply the model provider, model, or thinking level. This tool cannot view or change credentials or other application settings.",
		parameters: Type.Object(
			{
				provider: Type.Optional(
					Type.Union([
						Type.Literal("openai"),
						Type.Literal("openai-codex"),
						Type.Literal("anthropic"),
						Type.Literal("google"),
						Type.Literal("kimi-coding"),
					]),
				),
				model: Type.Optional(Type.String({ minLength: 1 })),
				thinkingLevel: Type.Optional(
					Type.Union([
						Type.Literal("off"),
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
						Type.Literal("max"),
					]),
				),
			},
			{ additionalProperties: false, minProperties: 1 },
		),
		async execute(_toolCallId, rawParams) {
			const params = rawParams as UpdateRuntimeSettingsParams;
			const current = controller.current();
			if (params.provider && params.provider !== current.provider) {
				const auth = await controller.models.checkAuth(params.provider);
				if (!auth) {
					throw new Error(
						`Provider ${params.provider} is not configured. Sign in through the local TUI before switching to it in chat.`,
					);
				}
			}
			const settings = await controller.update(params);
			const details: RuntimeSettingsToolDetails = { status: "updated", settings };
			return runtimeSettingsToolResult(details);
		},
	};
}

function runtimeSettingsToolResult(
	details: RuntimeSettingsToolDetails,
): AgentToolResult<RuntimeSettingsToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}
