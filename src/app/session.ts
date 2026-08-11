import { randomUUID } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import type { ChannelKind, HouseholdMember, HouseholdRole, IdentityScope } from "./identity.ts";

interface MemberRow {
	id: string;
	household_id: string;
	display_name: string;
	role: HouseholdRole;
	timezone: string;
	created_at: string;
}

interface SessionRow {
	id: string;
	household_id: string;
	actor_id: string;
	channel: ChannelKind;
	conversation_key: string;
	created_at: string;
	last_active_at: string;
}

interface MessageRow {
	id: string;
	session_id: string;
	sequence: number;
	role: SessionMessageRole;
	content_json: string;
	created_at: string;
}

export interface CreateMemberInput {
	householdId: string;
	displayName: string;
	role: HouseholdRole;
	timezone: string;
}

export interface BindChannelIdentityInput {
	memberId: string;
	channel: ChannelKind;
	externalId: string;
}

export interface ResolveIdentityInput {
	channel: ChannelKind;
	externalId: string;
	conversationKey: string;
}

export type SessionMessageRole = "user" | "assistant" | "system" | "tool";

export interface StoredSessionMessage {
	id: string;
	sessionId: string;
	sequence: number;
	role: SessionMessageRole;
	content: unknown;
	createdAt: string;
}

export class IdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityError";
	}
}

export class SessionIdentityService {
	private readonly database: WealthDatabase;

	constructor(database: WealthDatabase) {
		this.database = database;
	}

	createMember(input: CreateMemberInput): HouseholdMember {
		const displayName = requireText(input.displayName, "Display name");
		assertTimezone(input.timezone);
		const household = this.database.connection
			.prepare("SELECT id FROM households WHERE id = ?")
			.get(input.householdId) as { id: string } | undefined;
		if (!household) throw new IdentityError(`Household "${input.householdId}" was not found.`);

		const id = randomUUID();
		const createdAt = new Date().toISOString();
		this.database.connection
			.prepare(
				`INSERT INTO household_members
					(id, household_id, display_name, role, timezone, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, input.householdId, displayName, input.role, input.timezone, createdAt);
		return this.getMember(id);
	}

	getMember(memberId: string): HouseholdMember {
		const row = this.database.connection.prepare("SELECT * FROM household_members WHERE id = ?").get(memberId) as
			| MemberRow
			| undefined;
		if (!row) throw new IdentityError(`Household member "${memberId}" was not found.`);
		return mapMember(row);
	}

	bindChannelIdentity(input: BindChannelIdentityInput): void {
		this.getMember(input.memberId);
		const externalId = requireText(input.externalId, "External identity");
		try {
			this.database.connection
				.prepare(
					`INSERT INTO channel_identities (id, member_id, channel, external_id, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(randomUUID(), input.memberId, input.channel, externalId, new Date().toISOString());
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
				throw new IdentityError(`Channel identity ${input.channel}:${externalId} is already bound.`);
			}
			throw error;
		}
	}

	resolve(input: ResolveIdentityInput): IdentityScope {
		const externalId = requireText(input.externalId, "External identity");
		const conversationKey = requireText(input.conversationKey, "Conversation key");
		const memberRow = this.database.connection
			.prepare(
				`SELECT m.* FROM channel_identities AS ci
				 JOIN household_members AS m ON m.id = ci.member_id
				 WHERE ci.channel = ? AND ci.external_id = ?`,
			)
			.get(input.channel, externalId) as MemberRow | undefined;
		if (!memberRow) throw new IdentityError(`Channel identity ${input.channel}:${externalId} is not registered.`);

		const now = new Date().toISOString();
		let session = this.database.connection
			.prepare(
				`SELECT * FROM app_sessions
				 WHERE actor_id = ? AND channel = ? AND conversation_key = ?`,
			)
			.get(memberRow.id, input.channel, conversationKey) as SessionRow | undefined;
		if (session) {
			this.database.connection
				.prepare("UPDATE app_sessions SET last_active_at = ? WHERE id = ?")
				.run(now, session.id);
			session = { ...session, last_active_at: now };
		} else {
			session = {
				id: randomUUID(),
				household_id: memberRow.household_id,
				actor_id: memberRow.id,
				channel: input.channel,
				conversation_key: conversationKey,
				created_at: now,
				last_active_at: now,
			};
			this.database.connection
				.prepare(
					`INSERT INTO app_sessions
						(id, household_id, actor_id, channel, conversation_key, created_at, last_active_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					session.id,
					session.household_id,
					session.actor_id,
					session.channel,
					session.conversation_key,
					session.created_at,
					session.last_active_at,
				);
		}

		return {
			householdId: memberRow.household_id,
			actorId: memberRow.id,
			sessionId: session.id,
			channel: input.channel,
			role: memberRow.role,
			timezone: memberRow.timezone,
		};
	}

	appendMessage(sessionId: string, role: SessionMessageRole, content: unknown): StoredSessionMessage {
		const session = this.database.connection.prepare("SELECT id FROM app_sessions WHERE id = ?").get(sessionId) as
			| { id: string }
			| undefined;
		if (!session) throw new IdentityError(`Application session "${sessionId}" was not found.`);
		const contentJson = JSON.stringify(content);
		if (contentJson === undefined) throw new IdentityError("Session message content must be JSON serializable.");
		const sequenceRow = this.database.connection
			.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM session_messages WHERE session_id = ?")
			.get(sessionId) as { next_sequence: number };
		const message: StoredSessionMessage = {
			id: randomUUID(),
			sessionId,
			sequence: sequenceRow.next_sequence,
			role,
			content,
			createdAt: new Date().toISOString(),
		};
		this.database.connection
			.prepare(
				`INSERT INTO session_messages (id, session_id, sequence, role, content_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(message.id, message.sessionId, message.sequence, message.role, contentJson, message.createdAt);
		return message;
	}

	loadMessages(sessionId: string): StoredSessionMessage[] {
		const rows = this.database.connection
			.prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY sequence")
			.all(sessionId) as unknown as MessageRow[];
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			sequence: row.sequence,
			role: row.role,
			content: JSON.parse(row.content_json) as unknown,
			createdAt: row.created_at,
		}));
	}
}

function mapMember(row: MemberRow): HouseholdMember {
	return {
		id: row.id,
		householdId: row.household_id,
		displayName: row.display_name,
		role: row.role,
		timezone: row.timezone,
		createdAt: row.created_at,
	};
}

function requireText(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new IdentityError(`${label} is required.`);
	return normalized;
}

function assertTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
	} catch {
		throw new IdentityError(`Invalid IANA timezone "${timezone}".`);
	}
}
