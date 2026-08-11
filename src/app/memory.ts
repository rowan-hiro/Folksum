import { randomUUID } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import type { IdentityScope } from "./identity.ts";

export type MemoryRuleKind =
	| "account_alias"
	| "default_account"
	| "merchant_category"
	| "reminder_policy"
	| "preference";
export type RuleProvenance = "user" | "admin" | "import";

export interface AccountAliasRuleValue {
	accountId: string;
}

export interface DefaultAccountRuleValue {
	purpose: "expense" | "income" | "card_payment";
	accountId: string;
}

export interface MerchantCategoryRuleValue {
	merchantPattern: string;
	expenseAccountId: string;
}

export interface ReminderPolicyRuleValue {
	daysBefore: number[];
	overdueDaily: boolean;
}

export interface PreferenceRuleValue {
	value: string | number | boolean;
}

export interface MemoryRuleValueMap {
	account_alias: AccountAliasRuleValue;
	default_account: DefaultAccountRuleValue;
	merchant_category: MerchantCategoryRuleValue;
	reminder_policy: ReminderPolicyRuleValue;
	preference: PreferenceRuleValue;
}

export interface MemoryRule<TKind extends MemoryRuleKind = MemoryRuleKind> {
	id: string;
	householdId: string;
	kind: TKind;
	key: string;
	value: MemoryRuleValueMap[TKind];
	authorId: string;
	provenance: RuleProvenance;
	enabled: boolean;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SetMemoryRuleInput<TKind extends MemoryRuleKind> {
	kind: TKind;
	key: string;
	value: MemoryRuleValueMap[TKind];
	provenance?: RuleProvenance;
	enabled?: boolean;
	expiresAt?: string;
}

interface MemoryRuleRow {
	id: string;
	household_id: string;
	kind: MemoryRuleKind;
	rule_key: string;
	value_json: string;
	author_id: string;
	provenance: RuleProvenance;
	enabled: number;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
}

export class MemoryRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryRuleError";
	}
}

export class MemoryRuleService {
	private readonly database: WealthDatabase;

	constructor(database: WealthDatabase) {
		this.database = database;
	}

	setRule<TKind extends MemoryRuleKind>(
		scope: IdentityScope,
		input: SetMemoryRuleInput<TKind>,
	): MemoryRule<TKind> {
		if (scope.role === "viewer") throw new MemoryRuleError("Viewer role cannot change household rules.");
		const key = input.key.trim().toLowerCase();
		if (!key) throw new MemoryRuleError("Rule key is required.");
		validateRuleValue(input.kind, input.value);
		const expiresAt = input.expiresAt ? normalizeTimestamp(input.expiresAt) : undefined;
		const now = new Date().toISOString();
		const existing = this.database.connection
			.prepare("SELECT id, created_at FROM memory_rules WHERE household_id = ? AND kind = ? AND rule_key = ?")
			.get(scope.householdId, input.kind, key) as { id: string; created_at: string } | undefined;
		const id = existing?.id ?? randomUUID();
		const createdAt = existing?.created_at ?? now;
		this.database.connection
			.prepare(
				`INSERT INTO memory_rules
					(id, household_id, kind, rule_key, value_json, author_id, provenance,
					 enabled, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(household_id, kind, rule_key) DO UPDATE SET
					value_json = excluded.value_json,
					author_id = excluded.author_id,
					provenance = excluded.provenance,
					enabled = excluded.enabled,
					expires_at = excluded.expires_at,
					updated_at = excluded.updated_at`,
			)
			.run(
				id,
				scope.householdId,
				input.kind,
				key,
				JSON.stringify(input.value),
				scope.actorId,
				input.provenance ?? "user",
				input.enabled === false ? 0 : 1,
				expiresAt ?? null,
				createdAt,
				now,
			);
		const row = this.database.connection.prepare("SELECT * FROM memory_rules WHERE id = ?").get(id) as
			| MemoryRuleRow
			| undefined;
		if (!row) throw new MemoryRuleError("Rule write did not persist.");
		return mapRule(row) as MemoryRule<TKind>;
	}

	getRule<TKind extends MemoryRuleKind>(
		householdId: string,
		kind: TKind,
		key: string,
		asOf = new Date().toISOString(),
	): MemoryRule<TKind> | undefined {
		const row = this.database.connection
			.prepare(
				`SELECT * FROM memory_rules
				 WHERE household_id = ? AND kind = ? AND rule_key = ? AND enabled = 1
					AND (expires_at IS NULL OR expires_at > ?)`,
			)
			.get(householdId, kind, key.trim().toLowerCase(), normalizeTimestamp(asOf)) as MemoryRuleRow | undefined;
		return row ? (mapRule(row) as MemoryRule<TKind>) : undefined;
	}

	listActiveRules(householdId: string, asOf = new Date().toISOString()): MemoryRule[] {
		const rows = this.database.connection
			.prepare(
				`SELECT * FROM memory_rules
				 WHERE household_id = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?)
				 ORDER BY kind, rule_key`,
			)
			.all(householdId, normalizeTimestamp(asOf)) as unknown as MemoryRuleRow[];
		return rows.map(mapRule);
	}

	resolveAccountAlias(householdId: string, alias: string): string | undefined {
		const rule = this.getRule(householdId, "account_alias", alias);
		return rule?.value.accountId;
	}
}

function mapRule(row: MemoryRuleRow): MemoryRule {
	return {
		id: row.id,
		householdId: row.household_id,
		kind: row.kind,
		key: row.rule_key,
		value: JSON.parse(row.value_json) as MemoryRuleValueMap[MemoryRuleKind],
		authorId: row.author_id,
		provenance: row.provenance,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.expires_at ? { expiresAt: row.expires_at } : {}),
	};
}

function validateRuleValue<TKind extends MemoryRuleKind>(kind: TKind, value: MemoryRuleValueMap[TKind]): void {
	if (typeof value !== "object" || value === null) throw new MemoryRuleError("Rule value must be an object.");
	switch (kind) {
		case "account_alias":
			if (!("accountId" in value) || typeof value.accountId !== "string" || !value.accountId.trim()) {
				throw new MemoryRuleError("Account alias requires accountId.");
			}
			return;
		case "default_account":
			if (
				!("accountId" in value) ||
				typeof value.accountId !== "string" ||
				!("purpose" in value) ||
				!["expense", "income", "card_payment"].includes(String(value.purpose))
			) {
				throw new MemoryRuleError("Default account requires a valid purpose and accountId.");
			}
			return;
		case "merchant_category":
			if (
				!("merchantPattern" in value) ||
				typeof value.merchantPattern !== "string" ||
				!("expenseAccountId" in value) ||
				typeof value.expenseAccountId !== "string"
			) {
				throw new MemoryRuleError("Merchant category requires merchantPattern and expenseAccountId.");
			}
			return;
		case "reminder_policy": {
			if (!("daysBefore" in value) || !Array.isArray(value.daysBefore) || !("overdueDaily" in value)) {
				throw new MemoryRuleError("Reminder policy requires daysBefore and overdueDaily.");
			}
			const valid = value.daysBefore.every((day) => Number.isSafeInteger(day) && day >= 0 && day <= 90);
			if (!valid || typeof value.overdueDaily !== "boolean") {
				throw new MemoryRuleError("Reminder days must be integers from 0 to 90.");
			}
			return;
		}
		case "preference":
			if (!("value" in value) || !["string", "number", "boolean"].includes(typeof value.value)) {
				throw new MemoryRuleError("Preference value must be a string, number, or boolean.");
			}
			return;
	}
}

function normalizeTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new MemoryRuleError(`Invalid timestamp "${value}".`);
	return parsed.toISOString();
}
