import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import type { FinanceIr, FinanceRisk } from "./finance-ir.ts";
import type { IdentityScope } from "./identity.ts";

export type PendingOperationStatus = "pending" | "confirmed" | "executed" | "rejected" | "expired" | "failed";

interface PendingOperationRow {
	id: string;
	household_id: string;
	actor_id: string;
	session_id: string;
	ir_kind: FinanceIr["kind"];
	ir_json: string;
	ir_hash: string;
	risk: "medium" | "high";
	status: PendingOperationStatus;
	token_hash: string;
	expires_at: string;
	created_at: string;
	confirmed_at: string | null;
	executed_at: string | null;
	error_message: string | null;
}

export interface PendingOperation {
	id: string;
	householdId: string;
	actorId: string;
	sessionId: string;
	ir: FinanceIr;
	irHash: string;
	risk: "medium" | "high";
	status: PendingOperationStatus;
	expiresAt: string;
	createdAt: string;
	confirmedAt?: string;
	executedAt?: string;
	errorMessage?: string;
}

export interface PendingConfirmation {
	operation: PendingOperation;
	confirmationToken: string;
}

export class ConfirmationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfirmationError";
	}
}

export class ConfirmationStore {
	private readonly database: WealthDatabase;
	private readonly ttlMilliseconds: number;

	constructor(database: WealthDatabase, ttlMilliseconds = 10 * 60 * 1000) {
		this.database = database;
		this.ttlMilliseconds = ttlMilliseconds;
	}

	create(ir: FinanceIr, risk: FinanceRisk, now = new Date()): PendingConfirmation {
		if (risk !== "medium" && risk !== "high") {
			throw new ConfirmationError(`Risk ${risk} does not require confirmation.`);
		}
		const id = randomUUID();
		const nonce = randomBytes(32).toString("base64url");
		const createdAt = now.toISOString();
		const expiresAt = new Date(now.getTime() + this.ttlMilliseconds).toISOString();
		const irJson = canonicalJson(ir);
		const irHash = sha256(irJson);
		this.database.connection
			.prepare(
				`INSERT INTO pending_operations
					(id, household_id, actor_id, session_id, ir_kind, ir_json, ir_hash,
					 risk, status, token_hash, expires_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
			)
			.run(
				id,
				ir.householdId,
				ir.actorId,
				ir.sessionId,
				ir.kind,
				irJson,
				irHash,
				risk,
				sha256(nonce),
				expiresAt,
				createdAt,
			);
		return { operation: this.get(id), confirmationToken: `${id}.${nonce}` };
	}

	consume(confirmationToken: string, scope: IdentityScope, now = new Date()): PendingOperation {
		const separator = confirmationToken.indexOf(".");
		if (separator < 1) throw new ConfirmationError("Malformed confirmation token.");
		const id = confirmationToken.slice(0, separator);
		const nonce = confirmationToken.slice(separator + 1);
		const operation = this.get(id);

		if (
			operation.householdId !== scope.householdId ||
			operation.actorId !== scope.actorId ||
			operation.sessionId !== scope.sessionId
		) {
			throw new ConfirmationError("Confirmation identity or session does not match the pending operation.");
		}
		if (operation.status !== "pending") {
			throw new ConfirmationError(`Pending operation is already ${operation.status}.`);
		}
		if (operation.expiresAt <= now.toISOString()) {
			this.database.connection
				.prepare("UPDATE pending_operations SET status = 'expired' WHERE id = ? AND status = 'pending'")
				.run(operation.id);
			throw new ConfirmationError("Confirmation token has expired.");
		}

		const row = this.getRow(id);
		if (!safeHashEquals(row.token_hash, sha256(nonce))) {
			throw new ConfirmationError("Invalid confirmation token.");
		}

		this.database.connection
			.prepare(
				"UPDATE pending_operations SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'",
			)
			.run(now.toISOString(), operation.id);
		return this.get(operation.id);
	}

	markExecuted(id: string, now = new Date()): PendingOperation {
		this.database.connection
			.prepare(
				"UPDATE pending_operations SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'confirmed'",
			)
			.run(now.toISOString(), id);
		return this.get(id);
	}

	markFailed(id: string, error: unknown): PendingOperation {
		const message = error instanceof Error ? error.message : String(error);
		this.database.connection
			.prepare(
				"UPDATE pending_operations SET status = 'failed', error_message = ? WHERE id = ? AND status = 'confirmed'",
			)
			.run(message, id);
		return this.get(id);
	}

	reject(id: string, scope: IdentityScope): PendingOperation {
		const operation = this.get(id);
		if (
			operation.householdId !== scope.householdId ||
			operation.actorId !== scope.actorId ||
			operation.sessionId !== scope.sessionId
		) {
			throw new ConfirmationError("Confirmation identity or session does not match the pending operation.");
		}
		if (operation.status !== "pending") throw new ConfirmationError(`Pending operation is already ${operation.status}.`);
		this.database.connection
			.prepare("UPDATE pending_operations SET status = 'rejected' WHERE id = ? AND status = 'pending'")
			.run(id);
		return this.get(id);
	}

	get(id: string): PendingOperation {
		return mapPendingOperation(this.getRow(id));
	}

	private getRow(id: string): PendingOperationRow {
		const row = this.database.connection.prepare("SELECT * FROM pending_operations WHERE id = ?").get(id) as
			| PendingOperationRow
			| undefined;
		if (!row) throw new ConfirmationError(`Pending operation "${id}" was not found.`);
		return row;
	}
}

function mapPendingOperation(row: PendingOperationRow): PendingOperation {
	return {
		id: row.id,
		householdId: row.household_id,
		actorId: row.actor_id,
		sessionId: row.session_id,
		ir: JSON.parse(row.ir_json) as FinanceIr,
		irHash: row.ir_hash,
		risk: row.risk,
		status: row.status,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
		...(row.executed_at ? { executedAt: row.executed_at } : {}),
		...(row.error_message ? { errorMessage: row.error_message } : {}),
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeHashEquals(first: string, second: string): boolean {
	const firstBytes = Buffer.from(first, "hex");
	const secondBytes = Buffer.from(second, "hex");
	return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}
