import { randomUUID } from "node:crypto";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export interface PiChoiceOption {
	value: string;
	label: string;
	description?: string;
}

export interface PiChoiceRequest {
	requestId: string;
	prompt: string;
	options: PiChoiceOption[];
}

export interface ChoiceToolDetails {
	status: "choice_required";
	requestId: string;
}

export function createUserChoiceTool(onChoiceRequired: (request: PiChoiceRequest) => void): AgentTool {
	return {
		name: "request_user_choice",
		label: "Request user choice",
		description:
			"Pause this turn and ask the user to choose one exact option when an account, card, category, or similar finite choice is ambiguous. This tool never confirms or executes a financial operation.",
		parameters: Type.Object(
			{
				prompt: Type.String({ minLength: 1, maxLength: 500 }),
				options: Type.Array(
					Type.Object(
						{
							value: Type.String({ minLength: 1, maxLength: 64 }),
							label: Type.String({ minLength: 1, maxLength: 80 }),
							description: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
						},
						{ additionalProperties: false },
					),
					{ minItems: 2, maxItems: 6 },
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, rawParams) {
			const request = normalizeChoiceRequest(rawParams);
			onChoiceRequired(request);
			return choiceToolResult(request);
		},
	};
}

function normalizeChoiceRequest(rawParams: unknown): PiChoiceRequest {
	if (!isRecord(rawParams)) throw new Error("Choice request must be an object.");
	const prompt = requireBoundedText(rawParams.prompt, "Choice prompt", 500);
	if (!Array.isArray(rawParams.options) || rawParams.options.length < 2 || rawParams.options.length > 6) {
		throw new Error("Choice request must contain 2 to 6 options.");
	}
	const options = rawParams.options.map((rawOption, index): PiChoiceOption => {
		if (!isRecord(rawOption)) throw new Error(`Choice option ${index + 1} must be an object.`);
		const value = requireBoundedText(rawOption.value, `Choice option ${index + 1} value`, 64);
		const label = requireBoundedText(rawOption.label, `Choice option ${index + 1} label`, 80);
		const description =
			rawOption.description === undefined
				? undefined
				: requireBoundedText(rawOption.description, `Choice option ${index + 1} description`, 160);
		return { value, label, ...(description ? { description } : {}) };
	});
	if (new Set(options.map((option) => option.value)).size !== options.length) {
		throw new Error("Choice option values must be unique.");
	}
	return { requestId: randomUUID(), prompt, options };
}

function choiceToolResult(request: PiChoiceRequest): AgentToolResult<ChoiceToolDetails> {
	const details: ChoiceToolDetails = { status: "choice_required", requestId: request.requestId };
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
		terminate: true,
	};
}

function requireBoundedText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be text.`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maximumLength) {
		throw new Error(`${label} must contain 1 to ${maximumLength} characters.`);
	}
	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
