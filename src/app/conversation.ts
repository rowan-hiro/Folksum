import type { FinanceApplicationResult } from "./finance-application.ts";
import { FinanceApplication } from "./finance-application.ts";
import type { ChannelKind, IdentityScope } from "./identity.ts";
import { containsLikelyCredential } from "./input-security.ts";
import { SessionIdentityService } from "./session.ts";
import type { PiChoiceRequest } from "../runtime/pi/choice-tool.ts";
import type { PiConfirmationRequest } from "../runtime/pi/tools.ts";

export interface ConversationRuntime {
	prompt(text: string, onText?: (delta: string) => void): Promise<void>;
	abort(): void;
}

export interface ConversationRuntimeFactoryInput {
	scope: IdentityScope;
	currentDate: string;
	onConfirmationRequired: (request: PiConfirmationRequest) => void;
	onChoiceRequired: (request: PiChoiceRequest) => void;
}

export type ConversationRuntimeFactory = (
	input: ConversationRuntimeFactoryInput,
) => Promise<ConversationRuntime>;

export interface ConversationTurnResult {
	scope: IdentityScope;
	text: string;
	confirmations: PiConfirmationRequest[];
	choices: PiChoiceRequest[];
}

export class ConversationInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConversationInputError";
	}
}

export class ConversationCoordinator {
	private readonly identities: SessionIdentityService;
	private readonly application: FinanceApplication;
	private readonly runtimeFactory: ConversationRuntimeFactory;
	private readonly activeRuntimes = new Set<ConversationRuntime>();
	private shuttingDown = false;

	constructor(input: {
		identities: SessionIdentityService;
		application: FinanceApplication;
		runtimeFactory: ConversationRuntimeFactory;
	}) {
		this.identities = input.identities;
		this.application = input.application;
		this.runtimeFactory = input.runtimeFactory;
	}

	resolve(channel: ChannelKind, externalId: string, conversationKey: string): IdentityScope {
		return this.identities.resolve({ channel, externalId, conversationKey });
	}

	async prompt(scope: IdentityScope, rawText: string, now = new Date()): Promise<ConversationTurnResult> {
		if (this.shuttingDown) throw new Error("Conversation coordinator is shutting down.");
		const text = rawText.trim();
		if (!text) throw new ConversationInputError("A non-empty message is required.");
		if (containsLikelyCredential(text)) {
			throw new ConversationInputError(
				"This message looks like a provider credential and was not sent or stored. Configure credentials through the local TUI.",
			);
		}

		const confirmations: PiConfirmationRequest[] = [];
		const choices: PiChoiceRequest[] = [];
		const runtime = await this.runtimeFactory({
			scope,
			currentDate: dateInTimezone(scope.timezone, now),
			onConfirmationRequired: (request) => confirmations.push(request),
			onChoiceRequired: (request) => choices.push(request),
		});
		if (this.shuttingDown) {
			runtime.abort();
			throw new Error("Conversation coordinator is shutting down.");
		}

		let answer = "";
		this.activeRuntimes.add(runtime);
		try {
			await runtime.prompt(text, (delta) => {
				answer += delta;
			});
		} finally {
			this.activeRuntimes.delete(runtime);
		}
		return { scope, text: answer, confirmations, choices };
	}

	select(
		scope: IdentityScope,
		request: PiChoiceRequest,
		optionIndex: number,
		now = new Date(),
	): Promise<ConversationTurnResult> {
		const option = request.options[optionIndex];
		if (!option) throw new ConversationInputError("The selected choice is no longer available.");
		return this.prompt(
			scope,
			`User selected an exact option for ${JSON.stringify(request.prompt)}: ${JSON.stringify({
				value: option.value,
				label: option.label,
			})}. Continue using this exact selection.`,
			now,
		);
	}

	confirm(scope: IdentityScope, request: PiConfirmationRequest): FinanceApplicationResult {
		return this.application.confirm(request.confirmationToken, scope);
	}

	reject(scope: IdentityScope, request: PiConfirmationRequest): void {
		this.application.reject(request.pendingOperationId, scope);
	}

	shutdown(): void {
		this.shuttingDown = true;
		for (const runtime of this.activeRuntimes) runtime.abort();
	}
}

export function dateInTimezone(timezone: string, now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const day = parts.find((part) => part.type === "day")?.value;
	if (!year || !month || !day) throw new Error(`Could not calculate a date in timezone ${timezone}.`);
	return `${year}-${month}-${day}`;
}
