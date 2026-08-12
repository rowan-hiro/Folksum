import { randomUUID } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import type { ChannelKind } from "./identity.ts";

export type ChannelUpdateReceiptStatus = "processing" | "completed" | "failed";

interface ChannelUpdateReceiptRow {
	id: string;
	channel: ChannelKind;
	external_update_id: string;
	status: ChannelUpdateReceiptStatus;
	claimed_at: string;
	completed_at: string | null;
	error_message: string | null;
}

export interface ChannelUpdateReceipt {
	id: string;
	channel: ChannelKind;
	externalUpdateId: string;
	status: ChannelUpdateReceiptStatus;
	claimedAt: string;
	completedAt?: string;
	errorMessage?: string;
}

export interface ClaimChannelUpdateResult {
	claimed: boolean;
	receipt: ChannelUpdateReceipt;
}

export class ChannelUpdateReceiptStore {
	private readonly database: WealthDatabase;

	constructor(database: WealthDatabase) {
		this.database = database;
	}

	claim(channel: ChannelKind, externalUpdateId: string, now = new Date()): ClaimChannelUpdateResult {
		const normalizedId = requireExternalUpdateId(externalUpdateId);
		const claimedAt = now.toISOString();
		const id = randomUUID();
		const result = this.database.connection
			.prepare(
				`INSERT INTO channel_update_receipts
					(id, channel, external_update_id, status, claimed_at)
				 VALUES (?, ?, ?, 'processing', ?)
				 ON CONFLICT(channel, external_update_id) DO NOTHING`,
			)
			.run(id, channel, normalizedId, claimedAt);
		if (result.changes === 1) {
			return { claimed: true, receipt: this.get(id) };
		}

		const existing = this.database.connection
			.prepare(
				`SELECT id FROM channel_update_receipts
				 WHERE channel = ? AND external_update_id = ?`,
			)
			.get(channel, normalizedId) as { id: string } | undefined;
		if (!existing) throw new Error("Channel update receipt conflict did not return an existing row.");
		return { claimed: false, receipt: this.get(existing.id) };
	}

	complete(id: string, now = new Date()): ChannelUpdateReceipt {
		const result = this.database.connection
			.prepare(
				`UPDATE channel_update_receipts
				 SET status = 'completed', completed_at = ?, error_message = NULL
				 WHERE id = ? AND status = 'processing'`,
			)
			.run(now.toISOString(), id);
		if (result.changes !== 1) throw new Error(`Channel update receipt "${id}" is not processing.`);
		return this.get(id);
	}

	fail(id: string, reason: string, now = new Date()): ChannelUpdateReceipt {
		const message = normalizeFailureReason(reason);
		const result = this.database.connection
			.prepare(
				`UPDATE channel_update_receipts
				 SET status = 'failed', completed_at = ?, error_message = ?
				 WHERE id = ? AND status = 'processing'`,
			)
			.run(now.toISOString(), message, id);
		if (result.changes !== 1) throw new Error(`Channel update receipt "${id}" is not processing.`);
		return this.get(id);
	}

	failInterrupted(channel: ChannelKind, now = new Date()): number {
		const result = this.database.connection
			.prepare(
				`UPDATE channel_update_receipts
				 SET status = 'failed', completed_at = ?,
					error_message = 'Processing was interrupted before completion.'
				 WHERE channel = ? AND status = 'processing'`,
			)
			.run(now.toISOString(), channel);
		return Number(result.changes);
	}

	get(id: string): ChannelUpdateReceipt {
		const row = this.database.connection
			.prepare("SELECT * FROM channel_update_receipts WHERE id = ?")
			.get(id) as ChannelUpdateReceiptRow | undefined;
		if (!row) throw new Error(`Channel update receipt "${id}" was not found.`);
		return mapReceipt(row);
	}
}

function mapReceipt(row: ChannelUpdateReceiptRow): ChannelUpdateReceipt {
	return {
		id: row.id,
		channel: row.channel,
		externalUpdateId: row.external_update_id,
		status: row.status,
		claimedAt: row.claimed_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
		...(row.error_message ? { errorMessage: row.error_message } : {}),
	};
}

function requireExternalUpdateId(value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 200) {
		throw new Error("External update ID must contain 1 to 200 characters.");
	}
	return normalized;
}

function normalizeFailureReason(value: string): string {
	const normalized = value.trim();
	if (!normalized) return "Channel update processing failed.";
	return normalized.slice(0, 500);
}
