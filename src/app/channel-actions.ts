import { randomBytes } from "node:crypto";

import type { PiChoiceRequest } from "../runtime/pi/choice-tool.ts";
import type { PiConfirmationRequest } from "../runtime/pi/tools.ts";
import type { IdentityScope } from "./identity.ts";

export type ChannelAction =
	| {
			kind: "confirmation";
			request: PiConfirmationRequest;
	  }
	| {
			kind: "choice";
			request: PiChoiceRequest;
	  };

interface StoredChannelAction {
	id: string;
	scope: IdentityScope;
	action: ChannelAction;
	expiresAt: number;
}

export class ChannelActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChannelActionError";
	}
}

export class ChannelActionRegistry {
	private readonly actions = new Map<string, StoredChannelAction>();
	private readonly ttlMilliseconds: number;

	constructor(ttlMilliseconds = 10 * 60 * 1000) {
		if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) {
			throw new Error("Channel action TTL must be a positive integer.");
		}
		this.ttlMilliseconds = ttlMilliseconds;
	}

	register(scope: IdentityScope, action: ChannelAction, now = new Date()): string {
		const id = randomBytes(12).toString("base64url");
		this.actions.set(id, {
			id,
			scope: { ...scope },
			action,
			expiresAt: now.getTime() + this.ttlMilliseconds,
		});
		this.prune(now);
		return id;
	}

	consumeConfirmation(id: string, scope: IdentityScope, now = new Date()): PiConfirmationRequest {
		const action = this.consume(id, scope, "confirmation", now);
		if (action.kind !== "confirmation") throw new Error("Unexpected channel action kind.");
		return action.request;
	}

	consumeChoice(
		id: string,
		scope: IdentityScope,
		optionIndex: number,
		now = new Date(),
	): PiChoiceRequest {
		const stored = this.requireAvailable(id, scope, now);
		if (stored.action.kind !== "choice") {
			throw new ChannelActionError("This button does not match the pending action.");
		}
		if (!stored.action.request.options[optionIndex]) {
			throw new ChannelActionError("This choice option is unavailable.");
		}
		this.actions.delete(id);
		return stored.action.request;
	}

	clear(): void {
		this.actions.clear();
	}

	private consume(
		id: string,
		scope: IdentityScope,
		expectedKind: ChannelAction["kind"],
		now: Date,
	): ChannelAction {
		const stored = this.requireAvailable(id, scope, now);
		if (stored.action.kind !== expectedKind) {
			throw new ChannelActionError("This button does not match the pending action.");
		}
		this.actions.delete(id);
		return stored.action;
	}

	private requireAvailable(id: string, scope: IdentityScope, now: Date): StoredChannelAction {
		const stored = this.actions.get(id);
		if (!stored) throw new ChannelActionError("This action is unavailable or was already used.");
		if (stored.expiresAt <= now.getTime()) {
			this.actions.delete(id);
			throw new ChannelActionError("This action has expired.");
		}
		if (!sameScope(stored.scope, scope)) {
			throw new ChannelActionError("This action belongs to another user or conversation.");
		}
		return stored;
	}

	private prune(now: Date): void {
		for (const [id, action] of this.actions) {
			if (action.expiresAt <= now.getTime()) this.actions.delete(id);
		}
	}
}

function sameScope(first: IdentityScope, second: IdentityScope): boolean {
	return (
		first.householdId === second.householdId &&
		first.actorId === second.actorId &&
		first.sessionId === second.sessionId &&
		first.channel === second.channel
	);
}
