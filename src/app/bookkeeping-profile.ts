import { createHash, randomUUID } from "node:crypto";

import { WealthDatabase } from "../core/database.ts";
import { normalizeCurrency } from "../core/money.ts";
import type {
	AccountType,
	RecordTransactionBookkeepingInput,
	TransactionCustomFieldValue,
	TransactionSource,
} from "../core/types.ts";
import type { IdentityScope } from "./identity.ts";

export const BOOKKEEPING_PROFILE_FORMAT_VERSION = 1 as const;
export const DEFAULT_BOOKKEEPING_PROFILE_ID = "folksum/default@1" as const;

export type BookkeepingCategoryKind = "expense" | "income";
export type CustomFieldTarget = "transaction";
export type CustomFieldType = "text" | "boolean" | "integer" | "date";
export type BookkeepingProfileSource = "user" | "agent" | "import" | "system";
export type CustomFieldValue = string | boolean | number;
export type BookkeepingExportFormat = "csv" | "json";
export type BookkeepingExportRowMode = "transactions" | "postings";
export type BookkeepingExportReversalMode = "include" | "exclude" | "only";
export type BookkeepingExportAmountSign = "debit-positive" | "credit-positive" | "absolute";

export const BOOKKEEPING_EXPORT_COLUMN_SOURCES = [
	"transaction.id",
	"transaction.description",
	"transaction.occurredAt",
	"transaction.date",
	"transaction.currency",
	"transaction.source",
	"transaction.idempotencyKey",
	"transaction.reversalOf",
	"bookkeeping.profileRevision",
	"bookkeeping.categoryId",
	"bookkeeping.categoryLabel",
	"bookkeeping.ruleId",
	"bookkeeping.resolutionSource",
	"posting.id",
	"posting.accountId",
	"posting.accountName",
	"posting.amount",
	"posting.memo",
] as const;

export type BookkeepingExportColumnSource =
	| (typeof BOOKKEEPING_EXPORT_COLUMN_SOURCES)[number]
	| `customFields.${string}`;

export interface BookkeepingCategoryDefinition {
	id: string;
	label: string;
	kind: BookkeepingCategoryKind;
	parentId?: string;
	accountIds?: Readonly<Record<string, string>>;
}

export interface CustomFieldDefinition {
	id: string;
	label: string;
	target: CustomFieldTarget;
	type: CustomFieldType;
	required: boolean;
	allowedValues?: readonly string[];
}

export interface CategorizationRuleMatch {
	transactionKind: BookkeepingCategoryKind;
	descriptionContains: string;
}

export interface CategorizationRuleAssignment {
	categoryId?: string;
	fields?: Readonly<Record<string, CustomFieldValue>>;
}

export interface CategorizationRuleDefinition {
	id: string;
	priority: number;
	match: CategorizationRuleMatch;
	assign: CategorizationRuleAssignment;
}

export interface BookkeepingExportColumnDefinition {
	header: string;
	source: BookkeepingExportColumnSource;
}

export interface BookkeepingExportFilterDefinition {
	categoryIds?: readonly string[];
	accountIds?: readonly string[];
	transactionSources?: readonly TransactionSource[];
}

export interface BookkeepingExportProfileDefinition {
	id: string;
	label: string;
	format: BookkeepingExportFormat;
	rowMode: BookkeepingExportRowMode;
	reversals: BookkeepingExportReversalMode;
	amountSign: BookkeepingExportAmountSign;
	delimiter?: "," | ";" | "\t";
	filters?: BookkeepingExportFilterDefinition;
	columns: readonly BookkeepingExportColumnDefinition[];
}

export interface BookkeepingProfile {
	formatVersion: typeof BOOKKEEPING_PROFILE_FORMAT_VERSION;
	extends: typeof DEFAULT_BOOKKEEPING_PROFILE_ID;
	categories: readonly BookkeepingCategoryDefinition[];
	customFields: readonly CustomFieldDefinition[];
	categorizationRules: readonly CategorizationRuleDefinition[];
	exportProfiles: readonly BookkeepingExportProfileDefinition[];
}

export interface ActiveBookkeepingProfile {
	id: string;
	householdId: string;
	revision: number;
	profileHash: string;
	profile: BookkeepingProfile;
	source: BookkeepingProfileSource;
	authorId?: string;
	activatedAt?: string;
}

export interface ActivateBookkeepingProfileInput {
	profile: unknown;
	source?: Exclude<BookkeepingProfileSource, "system">;
	expectedRevision?: number;
}

export interface BookkeepingProfileCollectionPatch<T> {
	upsert?: readonly T[];
	remove?: readonly string[];
}

export interface BookkeepingProfilePatch {
	categories?: BookkeepingProfileCollectionPatch<BookkeepingCategoryDefinition>;
	customFields?: BookkeepingProfileCollectionPatch<CustomFieldDefinition>;
	categorizationRules?: BookkeepingProfileCollectionPatch<CategorizationRuleDefinition>;
	exportProfiles?: BookkeepingProfileCollectionPatch<BookkeepingExportProfileDefinition>;
}

export interface PatchBookkeepingProfileInput {
	patch: unknown;
	expectedRevision: number;
	source?: Exclude<BookkeepingProfileSource, "system">;
}

export interface ResolveBookkeepingTransactionInput {
	householdId: string;
	transactionKind: BookkeepingCategoryKind;
	description: string;
	currency: string;
	accountId?: string;
	categoryId?: string;
	customFields?: unknown;
}

export interface ResolvedBookkeepingTransaction {
	accountId: string;
	bookkeeping: RecordTransactionBookkeepingInput;
}

export interface ActivateBookkeepingProfileResult {
	active: ActiveBookkeepingProfile;
	duplicate: boolean;
}

interface ProfileRevisionRow {
	id: string;
	household_id: string;
	revision: number;
	profile_json: string;
	profile_hash: string;
	author_id: string | null;
	source: BookkeepingProfileSource;
	created_at: string;
}

interface BoundAccountRow {
	id: string;
	household_id: string;
	type: AccountType;
	currency: string;
	closed_at: string | null;
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROFILE_BYTES = 1_000_000;
const MAX_CATEGORIES = 500;
const MAX_CUSTOM_FIELDS = 200;
const MAX_RULES = 1_000;
const MAX_EXPORT_PROFILES = 100;
const MAX_EXPORT_COLUMNS = 100;

const DEFAULT_PROFILE: BookkeepingProfile = freezeProfile({
	formatVersion: BOOKKEEPING_PROFILE_FORMAT_VERSION,
	extends: DEFAULT_BOOKKEEPING_PROFILE_ID,
	categories: [
		{ id: "expense.housing", label: "Housing", kind: "expense" },
		{ id: "expense.food", label: "Food", kind: "expense" },
		{ id: "expense.food.groceries", label: "Groceries", kind: "expense", parentId: "expense.food" },
		{ id: "expense.food.dining", label: "Dining", kind: "expense", parentId: "expense.food" },
		{ id: "expense.transport", label: "Transport", kind: "expense" },
		{ id: "expense.utilities", label: "Utilities", kind: "expense" },
		{ id: "expense.health", label: "Health", kind: "expense" },
		{ id: "expense.education", label: "Education", kind: "expense" },
		{ id: "expense.entertainment", label: "Entertainment", kind: "expense" },
		{ id: "expense.shopping", label: "Shopping", kind: "expense" },
		{ id: "expense.travel", label: "Travel", kind: "expense" },
		{ id: "expense.tax", label: "Tax", kind: "expense" },
		{ id: "expense.other", label: "Other expense", kind: "expense" },
		{ id: "income.salary", label: "Salary", kind: "income" },
		{ id: "income.business", label: "Business income", kind: "income" },
		{ id: "income.interest", label: "Interest", kind: "income" },
		{ id: "income.investment", label: "Investment income", kind: "income" },
		{ id: "income.refund", label: "Refund", kind: "income" },
		{ id: "income.other", label: "Other income", kind: "income" },
	],
	customFields: [],
	categorizationRules: [],
	exportProfiles: [],
});

export class BookkeepingProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BookkeepingProfileError";
	}
}

export class BookkeepingProfileService {
	private readonly database: WealthDatabase;

	constructor(database: WealthDatabase) {
		this.database = database;
	}

	getActiveProfile(householdId: string): ActiveBookkeepingProfile {
		const row = this.database.connection
			.prepare(
				`SELECT revisions.*
				 FROM active_bookkeeping_profiles AS active
				 JOIN bookkeeping_profile_revisions AS revisions
					ON revisions.id = active.revision_id
				 WHERE active.household_id = ?`,
			)
			.get(householdId) as unknown as ProfileRevisionRow | undefined;
		if (row) return mapRevision(row);

		const profile = getDefaultBookkeepingProfile();
		return {
			id: `builtin:${DEFAULT_BOOKKEEPING_PROFILE_ID}`,
			householdId,
			revision: 0,
			profileHash: hashProfile(profile),
			profile,
			source: "system",
		};
	}

	listRevisions(householdId: string): ActiveBookkeepingProfile[] {
		const rows = this.database.connection
			.prepare(
				`SELECT * FROM bookkeeping_profile_revisions
				 WHERE household_id = ?
				 ORDER BY revision DESC`,
			)
			.all(householdId) as unknown as ProfileRevisionRow[];
		return rows.map(mapRevision);
	}

	activateProfile(
		scope: IdentityScope,
		input: ActivateBookkeepingProfileInput,
	): ActivateBookkeepingProfileResult {
		if (scope.role === "viewer") {
			throw new BookkeepingProfileError("Viewer role cannot change the household bookkeeping profile.");
		}
		const profile = validateBookkeepingProfile(input.profile);
		const profileJson = serializeBookkeepingProfile(profile);
		if (Buffer.byteLength(profileJson, "utf8") > MAX_PROFILE_BYTES) {
			throw new BookkeepingProfileError(`Bookkeeping profile must not exceed ${MAX_PROFILE_BYTES} bytes.`);
		}
		const profileHash = hashSerializedProfile(profileJson);

		return this.database.transaction(() => {
			this.validateAccountBindings(scope.householdId, profile);
			const current = this.getActiveProfile(scope.householdId);
			if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
				throw new BookkeepingProfileError(
					`Bookkeeping profile revision conflict: expected ${input.expectedRevision}, active revision is ${current.revision}.`,
				);
			}
			if (profileHash === current.profileHash) return { active: current, duplicate: true };

			const latest = this.database.connection
				.prepare(
					"SELECT COALESCE(MAX(revision), 0) AS revision FROM bookkeeping_profile_revisions WHERE household_id = ?",
				)
				.get(scope.householdId) as { revision: number };
			const revision = latest.revision + 1;
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			this.database.connection
				.prepare(
					`INSERT INTO bookkeeping_profile_revisions
						(id, household_id, revision, profile_json, profile_hash, author_id, source, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					scope.householdId,
					revision,
					profileJson,
					profileHash,
					scope.actorId,
					input.source ?? "user",
					createdAt,
				);
			this.database.connection
				.prepare(
					`INSERT INTO active_bookkeeping_profiles (household_id, revision_id, activated_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(household_id) DO UPDATE SET
						revision_id = excluded.revision_id,
						activated_at = excluded.activated_at`,
				)
				.run(scope.householdId, id, createdAt);
			return {
				active: mapRevision({
					id,
					household_id: scope.householdId,
					revision,
					profile_json: profileJson,
					profile_hash: profileHash,
					author_id: scope.actorId,
					source: input.source ?? "user",
					created_at: createdAt,
				}),
				duplicate: false,
			};
		});
	}

	patchProfile(scope: IdentityScope, input: PatchBookkeepingProfileInput): ActivateBookkeepingProfileResult {
		const current = this.getActiveProfile(scope.householdId);
		if (input.expectedRevision !== current.revision) {
			throw new BookkeepingProfileError(
				`Bookkeeping profile revision conflict: expected ${input.expectedRevision}, active revision is ${current.revision}.`,
			);
		}
		return this.activateProfile(scope, {
			profile: applyBookkeepingProfilePatch(current.profile, input.patch),
			expectedRevision: input.expectedRevision,
			...(input.source ? { source: input.source } : {}),
		});
	}

	resolveTransaction(input: ResolveBookkeepingTransactionInput): ResolvedBookkeepingTransaction {
		const active = this.getActiveProfile(input.householdId);
		const currency = normalizeCurrency(input.currency);
		const categoriesById = new Map(active.profile.categories.map((category) => [category.id, category]));
		const fieldsById = new Map(active.profile.customFields.map((field) => [field.id, field]));
		const normalizedDescription = input.description.trim().toLocaleLowerCase("en-US");
		const matchedRule = active.profile.categorizationRules.find(
			(rule) =>
				rule.match.transactionKind === input.transactionKind &&
				normalizedDescription.includes(rule.match.descriptionContains),
		);

		const explicitCategoryId = input.categoryId
			? requireIdentifier(input.categoryId, "Transaction categoryId")
			: undefined;
		let category = explicitCategoryId ? categoriesById.get(explicitCategoryId) : undefined;
		if (explicitCategoryId && !category) {
			throw new BookkeepingProfileError(`Unknown bookkeeping category "${explicitCategoryId}".`);
		}
		if (!category && matchedRule?.assign.categoryId) {
			category = categoriesById.get(matchedRule.assign.categoryId);
		}
		if (category && category.kind !== input.transactionKind) {
			throw new BookkeepingProfileError(
				`Category "${category.id}" cannot classify an ${input.transactionKind} transaction.`,
			);
		}

		const explicitAccountId = input.accountId?.trim() || undefined;
		if (!category && explicitAccountId) {
			category = active.profile.categories.find(
				(candidate) =>
					candidate.kind === input.transactionKind && candidate.accountIds?.[currency] === explicitAccountId,
			);
		}
		const accountId = explicitAccountId ?? category?.accountIds?.[currency];
		if (!accountId) {
			const categoryMessage = category ? `Category "${category.id}" has no ${currency} account binding.` : "No category matched.";
			throw new BookkeepingProfileError(
				`${categoryMessage} Provide a compatible account id or activate a category account binding.`,
			);
		}
		const account = this.database.connection
			.prepare("SELECT id, household_id, type, currency, closed_at FROM accounts WHERE id = ?")
			.get(accountId) as unknown as BoundAccountRow | undefined;
		if (
			!account ||
			account.household_id !== input.householdId ||
			account.closed_at !== null ||
			account.type !== input.transactionKind ||
			account.currency !== currency
		) {
			throw new BookkeepingProfileError(
				`Account "${accountId}" must be an open ${input.transactionKind} account in ${currency} for this household.`,
			);
		}
		if (category?.accountIds?.[currency] && category.accountIds[currency] !== accountId) {
			throw new BookkeepingProfileError(
				`Category "${category.id}" is bound to a different ${currency} account.`,
			);
		}

		const customFields: Record<string, TransactionCustomFieldValue> = {
			...(matchedRule?.assign.fields ?? {}),
		};
		if (input.customFields !== undefined) {
			const supplied = requireRecord(input.customFields, "Transaction customFields");
			const normalizedIds = new Set<string>();
			for (const [rawFieldId, value] of Object.entries(supplied)) {
				const fieldId = requireIdentifier(rawFieldId, "Transaction custom field id");
				if (normalizedIds.has(fieldId)) {
					throw new BookkeepingProfileError(`Duplicate transaction custom field "${fieldId}".`);
				}
				normalizedIds.add(fieldId);
				const field = fieldsById.get(fieldId);
				if (!field) throw new BookkeepingProfileError(`Unknown transaction custom field "${fieldId}".`);
				if (!["string", "boolean", "number"].includes(typeof value)) {
					throw new BookkeepingProfileError(`Transaction custom field "${fieldId}" has an unsupported value.`);
				}
				validateCustomFieldValue(field, value as CustomFieldValue, `Transaction custom field "${fieldId}"`);
				customFields[fieldId] = value as TransactionCustomFieldValue;
			}
		}
		for (const field of active.profile.customFields) {
			if (field.required && !(field.id in customFields)) {
				throw new BookkeepingProfileError(`Required transaction custom field "${field.id}" is missing.`);
			}
		}

		return {
			accountId,
			bookkeeping: {
				profileRevision: active.revision,
				profileHash: active.profileHash,
				...(category ? { categoryId: category.id, categoryLabel: category.label } : {}),
				...(matchedRule ? { categorizationRuleId: matchedRule.id } : {}),
				customFields,
				resolutionSource: explicitCategoryId
					? "explicit"
					: matchedRule
						? "rule"
						: category
							? "account_binding"
							: "unclassified",
			},
		};
	}

	private validateAccountBindings(householdId: string, profile: BookkeepingProfile): void {
		const claimedAccounts = new Map<string, string>();
		for (const category of profile.categories) {
			for (const [currency, accountId] of Object.entries(category.accountIds ?? {})) {
				const account = this.database.connection
					.prepare("SELECT id, household_id, type, currency, closed_at FROM accounts WHERE id = ?")
					.get(accountId) as unknown as BoundAccountRow | undefined;
				if (!account || account.household_id !== householdId || account.closed_at !== null) {
					throw new BookkeepingProfileError(
						`Category "${category.id}" references unavailable account "${accountId}".`,
					);
				}
				if (account.type !== category.kind || account.currency !== currency) {
					throw new BookkeepingProfileError(
						`Category "${category.id}" requires an open ${category.kind} account in ${currency}.`,
					);
				}
				const existingCategory = claimedAccounts.get(accountId);
				if (existingCategory && existingCategory !== category.id) {
					throw new BookkeepingProfileError(
						`Account "${accountId}" is bound to both "${existingCategory}" and "${category.id}".`,
					);
				}
				claimedAccounts.set(accountId, category.id);
			}
		}
		const validatedExportAccounts = new Set<string>();
		for (const exportProfile of profile.exportProfiles) {
			for (const accountId of exportProfile.filters?.accountIds ?? []) {
				if (validatedExportAccounts.has(accountId)) continue;
				const account = this.database.connection
					.prepare("SELECT id, household_id, type, currency, closed_at FROM accounts WHERE id = ?")
					.get(accountId) as unknown as BoundAccountRow | undefined;
				if (!account || account.household_id !== householdId) {
					throw new BookkeepingProfileError(
						`Export profile "${exportProfile.id}" references unavailable account "${accountId}".`,
					);
				}
				validatedExportAccounts.add(accountId);
			}
		}
	}
}

export function getDefaultBookkeepingProfile(): BookkeepingProfile {
	return structuredClone(DEFAULT_PROFILE);
}

export function parseBookkeepingProfileJson(text: string, source = "bookkeeping profile"): BookkeepingProfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingProfileError(`Could not parse ${source}: ${reason}`);
	}
	return validateBookkeepingProfile(parsed);
}

export function serializeBookkeepingProfile(profile: BookkeepingProfile): string {
	return `${JSON.stringify(validateBookkeepingProfile(profile), null, "\t")}\n`;
}

export function applyBookkeepingProfilePatch(
	profile: BookkeepingProfile,
	value: unknown,
): BookkeepingProfile {
	const patch = requireRecord(value, "Bookkeeping profile patch");
	requireOnlyKeys(
		patch,
		["categories", "customFields", "categorizationRules", "exportProfiles"],
		"Bookkeeping profile patch",
	);
	if (Object.keys(patch).length === 0) {
		throw new BookkeepingProfileError("Bookkeeping profile patch must contain at least one collection change.");
	}

	const categories = applyCollectionPatch(
		profile.categories,
		patch.categories,
		"categories",
		(value, index) => validateCategory(value, index),
	);
	const customFields = applyCollectionPatch(
		profile.customFields,
		patch.customFields,
		"customFields",
		(value, index) => validateCustomField(value, index),
	);
	const categorizationRules = applyCollectionPatch(
		profile.categorizationRules,
		patch.categorizationRules,
		"categorizationRules",
		(value, index) => validateCategorizationRule(value, index),
	);
	const exportProfiles = applyCollectionPatch(
		profile.exportProfiles,
		patch.exportProfiles,
		"exportProfiles",
		(value, index) => validateExportProfile(value, index),
	);

	return validateBookkeepingProfile({
		formatVersion: BOOKKEEPING_PROFILE_FORMAT_VERSION,
		extends: DEFAULT_BOOKKEEPING_PROFILE_ID,
		categories,
		customFields,
		categorizationRules,
		exportProfiles,
	});
}

export function validateBookkeepingProfile(value: unknown): BookkeepingProfile {
	const record = requireRecord(value, "Bookkeeping profile");
	requireOnlyKeys(
		record,
		["formatVersion", "extends", "categories", "customFields", "categorizationRules", "exportProfiles"],
		"Bookkeeping profile",
	);
	if (record.formatVersion !== BOOKKEEPING_PROFILE_FORMAT_VERSION) {
		throw new BookkeepingProfileError(
			`Unsupported bookkeeping profile format version "${String(record.formatVersion)}".`,
		);
	}
	if (record.extends !== DEFAULT_BOOKKEEPING_PROFILE_ID) {
		throw new BookkeepingProfileError(
			`Bookkeeping profile must extend "${DEFAULT_BOOKKEEPING_PROFILE_ID}".`,
		);
	}

	const categories = requireArray(record.categories, "Bookkeeping profile categories", MAX_CATEGORIES).map(
		(value, index) => validateCategory(value, index),
	);
	const customFields = requireArray(
		record.customFields,
		"Bookkeeping profile customFields",
		MAX_CUSTOM_FIELDS,
	).map((field, index) => validateCustomField(field, index));
	const categorizationRules = requireArray(
		record.categorizationRules,
		"Bookkeeping profile categorizationRules",
		MAX_RULES,
	).map((rule, index) => validateCategorizationRule(rule, index));
	const exportProfiles = requireArray(
		record.exportProfiles,
		"Bookkeeping profile exportProfiles",
		MAX_EXPORT_PROFILES,
	).map((profile, index) => validateExportProfile(profile, index));

	assertUniqueIds(categories, "category");
	assertUniqueIds(customFields, "custom field");
	assertUniqueIds(categorizationRules, "categorization rule");
	assertUniqueIds(exportProfiles, "export profile");
	validateCategoryGraph(categories);
	validateRuleReferences(categories, customFields, categorizationRules);
	validateExportReferences(categories, customFields, exportProfiles);

	return freezeProfile({
		formatVersion: BOOKKEEPING_PROFILE_FORMAT_VERSION,
		extends: DEFAULT_BOOKKEEPING_PROFILE_ID,
		categories,
		customFields,
		categorizationRules: [...categorizationRules].sort(
			(first, second) => second.priority - first.priority || first.id.localeCompare(second.id),
		),
		exportProfiles,
	});
}

function validateCategory(value: unknown, index: number): BookkeepingCategoryDefinition {
	const label = `Category at index ${index}`;
	const record = requireRecord(value, label);
	requireOnlyKeys(record, ["id", "label", "kind", "parentId", "accountIds"], label);
	const id = requireIdentifier(record.id, `${label} id`);
	const categoryLabel = requireText(record.label, `${label} label`, 100);
	if (record.kind !== "expense" && record.kind !== "income") {
		throw new BookkeepingProfileError(`${label} kind must be "expense" or "income".`);
	}
	const parentId = optionalIdentifier(record.parentId, `${label} parentId`);
	let accountIds: Record<string, string> | undefined;
	if (record.accountIds !== undefined) {
		const bindings = requireRecord(record.accountIds, `${label} accountIds`);
		accountIds = {};
		for (const [rawCurrency, rawAccountId] of Object.entries(bindings)) {
			let currency: string;
			try {
				currency = normalizeCurrency(rawCurrency);
			} catch {
				throw new BookkeepingProfileError(`${label} has invalid account currency "${rawCurrency}".`);
			}
			if (currency in accountIds) {
				throw new BookkeepingProfileError(`${label} contains duplicate currency binding "${currency}".`);
			}
			accountIds[currency] = requireText(rawAccountId, `${label} account id for ${currency}`, 200);
		}
	}
	return {
		id,
		label: categoryLabel,
		kind: record.kind,
		...(parentId ? { parentId } : {}),
		...(accountIds && Object.keys(accountIds).length > 0 ? { accountIds } : {}),
	};
}

function validateCustomField(value: unknown, index: number): CustomFieldDefinition {
	const label = `Custom field at index ${index}`;
	const record = requireRecord(value, label);
	requireOnlyKeys(record, ["id", "label", "target", "type", "required", "allowedValues"], label);
	const id = requireIdentifier(record.id, `${label} id`);
	const fieldLabel = requireText(record.label, `${label} label`, 100);
	if (record.target !== "transaction") {
		throw new BookkeepingProfileError(`${label} target must be "transaction".`);
	}
	if (!isOneOf(record.type, ["text", "boolean", "integer", "date"] as const)) {
		throw new BookkeepingProfileError(`${label} has unsupported type "${String(record.type)}".`);
	}
	if (typeof record.required !== "boolean") {
		throw new BookkeepingProfileError(`${label} required must be a boolean.`);
	}
	let allowedValues: string[] | undefined;
	if (record.allowedValues !== undefined) {
		if (record.type !== "text") {
			throw new BookkeepingProfileError(`${label} allowedValues can be used only with text fields.`);
		}
		allowedValues = requireArray(record.allowedValues, `${label} allowedValues`, 100).map((item, itemIndex) =>
			requireText(item, `${label} allowedValues[${itemIndex}]`, 200),
		);
		if (new Set(allowedValues).size !== allowedValues.length) {
			throw new BookkeepingProfileError(`${label} allowedValues must be unique.`);
		}
	}
	return {
		id,
		label: fieldLabel,
		target: record.target,
		type: record.type,
		required: record.required,
		...(allowedValues && allowedValues.length > 0 ? { allowedValues } : {}),
	};
}

function validateCategorizationRule(value: unknown, index: number): CategorizationRuleDefinition {
	const label = `Categorization rule at index ${index}`;
	const record = requireRecord(value, label);
	requireOnlyKeys(record, ["id", "priority", "match", "assign"], label);
	const id = requireIdentifier(record.id, `${label} id`);
	if (!Number.isSafeInteger(record.priority) || Number(record.priority) < 0 || Number(record.priority) > 100_000) {
		throw new BookkeepingProfileError(`${label} priority must be an integer from 0 to 100000.`);
	}

	const match = requireRecord(record.match, `${label} match`);
	requireOnlyKeys(match, ["transactionKind", "descriptionContains"], `${label} match`);
	if (match.transactionKind !== "expense" && match.transactionKind !== "income") {
		throw new BookkeepingProfileError(`${label} match.transactionKind must be "expense" or "income".`);
	}
	const descriptionContains = requireText(
		match.descriptionContains,
		`${label} match.descriptionContains`,
		200,
	).toLocaleLowerCase("en-US");

	const assign = requireRecord(record.assign, `${label} assign`);
	requireOnlyKeys(assign, ["categoryId", "fields"], `${label} assign`);
	const categoryId = optionalIdentifier(assign.categoryId, `${label} assign.categoryId`);
	let fields: Record<string, CustomFieldValue> | undefined;
	if (assign.fields !== undefined) {
		const fieldRecord = requireRecord(assign.fields, `${label} assign.fields`);
		fields = {};
		const normalizedFieldIds = new Set<string>();
		for (const [rawFieldId, fieldValue] of Object.entries(fieldRecord)) {
			const fieldId = requireIdentifier(rawFieldId, `${label} assigned field id`);
			if (normalizedFieldIds.has(fieldId)) {
				throw new BookkeepingProfileError(`${label} contains duplicate assigned field "${fieldId}".`);
			}
			normalizedFieldIds.add(fieldId);
			if (!["string", "boolean", "number"].includes(typeof fieldValue)) {
				throw new BookkeepingProfileError(`${label} assigned field "${fieldId}" has an unsupported value.`);
			}
			fields[fieldId] = fieldValue as CustomFieldValue;
		}
	}
	if (!categoryId && (!fields || Object.keys(fields).length === 0)) {
		throw new BookkeepingProfileError(`${label} must assign a category or at least one custom field.`);
	}

	return {
		id,
		priority: Number(record.priority),
		match: { transactionKind: match.transactionKind, descriptionContains },
		assign: {
			...(categoryId ? { categoryId } : {}),
			...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
		},
	};
}

function validateExportProfile(value: unknown, index: number): BookkeepingExportProfileDefinition {
	const label = `Export profile at index ${index}`;
	const record = requireRecord(value, label);
	requireOnlyKeys(
		record,
		["id", "label", "format", "rowMode", "reversals", "amountSign", "delimiter", "filters", "columns"],
		label,
	);
	const id = requireIdentifier(record.id, `${label} id`);
	const profileLabel = requireText(record.label, `${label} label`, 100);
	if (!isOneOf(record.format, ["csv", "json"] as const)) {
		throw new BookkeepingProfileError(`${label} format must be "csv" or "json".`);
	}
	if (!isOneOf(record.rowMode, ["transactions", "postings"] as const)) {
		throw new BookkeepingProfileError(`${label} rowMode must be "transactions" or "postings".`);
	}
	if (!isOneOf(record.reversals, ["include", "exclude", "only"] as const)) {
		throw new BookkeepingProfileError(`${label} has unsupported reversals mode "${String(record.reversals)}".`);
	}
	if (!isOneOf(record.amountSign, ["debit-positive", "credit-positive", "absolute"] as const)) {
		throw new BookkeepingProfileError(`${label} has unsupported amountSign "${String(record.amountSign)}".`);
	}
	let delimiter: "," | ";" | "\t" | undefined;
	if (record.delimiter !== undefined) {
		if (record.format !== "csv") throw new BookkeepingProfileError(`${label} delimiter is valid only for CSV.`);
		if (!isOneOf(record.delimiter, [",", ";", "\t"] as const)) {
			throw new BookkeepingProfileError(`${label} delimiter must be a comma, semicolon, or tab.`);
		}
		delimiter = record.delimiter;
	} else if (record.format === "csv") {
		delimiter = ",";
	}

	let filters: BookkeepingExportFilterDefinition | undefined;
	if (record.filters !== undefined) {
		const filterRecord = requireRecord(record.filters, `${label} filters`);
		requireOnlyKeys(filterRecord, ["categoryIds", "accountIds", "transactionSources"], `${label} filters`);
		const categoryIds = optionalIdentifierArray(filterRecord.categoryIds, `${label} filters.categoryIds`);
		const accountIds = optionalTextArray(filterRecord.accountIds, `${label} filters.accountIds`);
		let transactionSources: TransactionSource[] | undefined;
		if (filterRecord.transactionSources !== undefined) {
			transactionSources = requireArray(
				filterRecord.transactionSources,
				`${label} filters.transactionSources`,
				4,
			).map((source) => {
				if (!isOneOf(source, ["agent", "manual", "import", "system"] as const)) {
					throw new BookkeepingProfileError(`${label} filters contain unsupported transaction source.`);
				}
				return source;
			});
			assertUniqueStrings(transactionSources, `${label} filters.transactionSources`);
		}
		filters = {
			...(categoryIds && categoryIds.length > 0 ? { categoryIds } : {}),
			...(accountIds && accountIds.length > 0 ? { accountIds } : {}),
			...(transactionSources && transactionSources.length > 0 ? { transactionSources } : {}),
		};
	}

	const columns = requireArray(record.columns, `${label} columns`, MAX_EXPORT_COLUMNS).map(
		(column, columnIndex): BookkeepingExportColumnDefinition => {
			const columnLabel = `${label} column at index ${columnIndex}`;
			const columnRecord = requireRecord(column, columnLabel);
			requireOnlyKeys(columnRecord, ["header", "source"], columnLabel);
			const header = requireText(columnRecord.header, `${columnLabel} header`, 100);
			const source = requireText(columnRecord.source, `${columnLabel} source`, 120);
			if (!isExportColumnSource(source)) {
				throw new BookkeepingProfileError(`${columnLabel} has unsupported source "${source}".`);
			}
			if (record.rowMode === "transactions" && source.startsWith("posting.")) {
				throw new BookkeepingProfileError(`${columnLabel} cannot use a posting source in transaction row mode.`);
			}
			return { header, source };
		},
	);
	if (columns.length === 0) throw new BookkeepingProfileError(`${label} must contain at least one column.`);
	const normalizedHeaders = columns.map((column) => column.header.toLocaleLowerCase("en-US"));
	assertUniqueStrings(normalizedHeaders, `${label} column headers`);

	return {
		id,
		label: profileLabel,
		format: record.format,
		rowMode: record.rowMode,
		reversals: record.reversals,
		amountSign: record.amountSign,
		...(delimiter ? { delimiter } : {}),
		...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
		columns,
	};
}

function validateCategoryGraph(categories: readonly BookkeepingCategoryDefinition[]): void {
	const byId = new Map(categories.map((category) => [category.id, category]));
	for (const category of categories) {
		if (!category.parentId) continue;
		const parent = byId.get(category.parentId);
		if (!parent) {
			throw new BookkeepingProfileError(
				`Category "${category.id}" references unknown parent "${category.parentId}".`,
			);
		}
		if (parent.kind !== category.kind) {
			throw new BookkeepingProfileError(`Category "${category.id}" and its parent must have the same kind.`);
		}
	}

	const completed = new Set<string>();
	const visiting = new Set<string>();
	const visit = (categoryId: string): void => {
		if (completed.has(categoryId)) return;
		if (visiting.has(categoryId)) {
			throw new BookkeepingProfileError(`Category hierarchy contains a cycle at "${categoryId}".`);
		}
		visiting.add(categoryId);
		const parentId = byId.get(categoryId)?.parentId;
		if (parentId) visit(parentId);
		visiting.delete(categoryId);
		completed.add(categoryId);
	};
	for (const category of categories) visit(category.id);
}

function validateRuleReferences(
	categories: readonly BookkeepingCategoryDefinition[],
	customFields: readonly CustomFieldDefinition[],
	rules: readonly CategorizationRuleDefinition[],
): void {
	const categoriesById = new Map(categories.map((category) => [category.id, category]));
	const fieldsById = new Map(customFields.map((field) => [field.id, field]));
	for (const rule of rules) {
		if (rule.assign.categoryId) {
			const category = categoriesById.get(rule.assign.categoryId);
			if (!category) {
				throw new BookkeepingProfileError(
					`Categorization rule "${rule.id}" references unknown category "${rule.assign.categoryId}".`,
				);
			}
			if (category.kind !== rule.match.transactionKind) {
				throw new BookkeepingProfileError(
					`Categorization rule "${rule.id}" cannot assign an ${category.kind} category to an ${rule.match.transactionKind} transaction.`,
				);
			}
		}
		for (const [fieldId, value] of Object.entries(rule.assign.fields ?? {})) {
			const field = fieldsById.get(fieldId);
			if (!field) {
				throw new BookkeepingProfileError(
					`Categorization rule "${rule.id}" references unknown custom field "${fieldId}".`,
				);
			}
			validateCustomFieldValue(field, value, `Categorization rule "${rule.id}" field "${fieldId}"`);
		}
	}
}

function validateExportReferences(
	categories: readonly BookkeepingCategoryDefinition[],
	customFields: readonly CustomFieldDefinition[],
	exportProfiles: readonly BookkeepingExportProfileDefinition[],
): void {
	const categoryIds = new Set(categories.map((category) => category.id));
	const fieldsById = new Map(customFields.map((field) => [field.id, field]));
	for (const exportProfile of exportProfiles) {
		for (const categoryId of exportProfile.filters?.categoryIds ?? []) {
			if (!categoryIds.has(categoryId)) {
				throw new BookkeepingProfileError(
					`Export profile "${exportProfile.id}" filters unknown category "${categoryId}".`,
				);
			}
		}
		for (const column of exportProfile.columns) {
			if (!column.source.startsWith("customFields.")) continue;
			const fieldId = column.source.slice("customFields.".length);
			const field = fieldsById.get(fieldId);
			if (!field) {
				throw new BookkeepingProfileError(
					`Export profile "${exportProfile.id}" references unknown custom field "${fieldId}".`,
				);
			}
		}
	}
}

function validateCustomFieldValue(field: CustomFieldDefinition, value: CustomFieldValue, label: string): void {
	switch (field.type) {
		case "text":
			if (typeof value !== "string" || value.length > 1_000) {
				throw new BookkeepingProfileError(`${label} must be text no longer than 1000 characters.`);
			}
			if (field.allowedValues && !field.allowedValues.includes(value)) {
				throw new BookkeepingProfileError(`${label} must be one of the field's allowedValues.`);
			}
			return;
		case "boolean":
			if (typeof value !== "boolean") throw new BookkeepingProfileError(`${label} must be a boolean.`);
			return;
		case "integer":
			if (!Number.isSafeInteger(value)) throw new BookkeepingProfileError(`${label} must be a safe integer.`);
			return;
		case "date":
			if (typeof value !== "string" || !isValidDate(value)) {
				throw new BookkeepingProfileError(`${label} must be a valid YYYY-MM-DD date.`);
			}
	}
}

function applyCollectionPatch<T extends { id: string }>(
	current: readonly T[],
	value: unknown,
	collectionName: string,
	validateItem: (value: unknown, index: number) => T,
): T[] {
	if (value === undefined) return [...current];
	const patch = requireRecord(value, `Bookkeeping profile patch ${collectionName}`);
	requireOnlyKeys(patch, ["upsert", "remove"], `Bookkeeping profile patch ${collectionName}`);
	if (patch.upsert === undefined && patch.remove === undefined) {
		throw new BookkeepingProfileError(
			`Bookkeeping profile patch ${collectionName} must contain upsert or remove.`,
		);
	}
	const upserts =
		patch.upsert === undefined
			? []
			: requireArray(patch.upsert, `Bookkeeping profile patch ${collectionName}.upsert`, MAX_RULES).map(
					(item, index) => validateItem(item, index),
				);
	const removals =
		patch.remove === undefined
			? []
			: requireArray(patch.remove, `Bookkeeping profile patch ${collectionName}.remove`, MAX_RULES).map(
					(item, index) =>
						requireIdentifier(item, `Bookkeeping profile patch ${collectionName}.remove[${index}]`),
				);
	assertUniqueIds(upserts, `${collectionName} upsert`);
	if (new Set(removals).size !== removals.length) {
		throw new BookkeepingProfileError(`Bookkeeping profile patch ${collectionName}.remove contains duplicates.`);
	}
	const removalSet = new Set(removals);
	const overlap = upserts.find((item) => removalSet.has(item.id));
	if (overlap) {
		throw new BookkeepingProfileError(
			`Bookkeeping profile patch ${collectionName} cannot upsert and remove "${overlap.id}" together.`,
		);
	}
	const existingIds = new Set(current.map((item) => item.id));
	const unknownRemoval = removals.find((id) => !existingIds.has(id));
	if (unknownRemoval) {
		throw new BookkeepingProfileError(
			`Bookkeeping profile patch ${collectionName} cannot remove unknown id "${unknownRemoval}".`,
		);
	}

	const upsertsById = new Map(upserts.map((item) => [item.id, item]));
	const result = current
		.filter((item) => !removalSet.has(item.id))
		.map((item) => upsertsById.get(item.id) ?? item);
	for (const item of upserts) {
		if (!existingIds.has(item.id)) result.push(item);
	}
	return result;
}

function mapRevision(row: ProfileRevisionRow): ActiveBookkeepingProfile {
	const profile = parseBookkeepingProfileJson(
		row.profile_json,
		`stored bookkeeping profile revision ${row.revision}`,
	);
	const actualHash = hashProfile(profile);
	if (actualHash !== row.profile_hash) {
		throw new BookkeepingProfileError(
			`Stored bookkeeping profile revision ${row.revision} does not match its recorded hash.`,
		);
	}
	return {
		id: row.id,
		householdId: row.household_id,
		revision: row.revision,
		profileHash: row.profile_hash,
		profile,
		source: row.source,
		...(row.author_id ? { authorId: row.author_id } : {}),
		activatedAt: row.created_at,
	};
}

function freezeProfile(profile: BookkeepingProfile): BookkeepingProfile {
	for (const category of profile.categories) {
		if (category.accountIds) Object.freeze(category.accountIds);
		Object.freeze(category);
	}
	for (const field of profile.customFields) {
		if (field.allowedValues) Object.freeze(field.allowedValues);
		Object.freeze(field);
	}
	for (const rule of profile.categorizationRules) {
		Object.freeze(rule.match);
		if (rule.assign.fields) Object.freeze(rule.assign.fields);
		Object.freeze(rule.assign);
		Object.freeze(rule);
	}
	for (const exportProfile of profile.exportProfiles) {
		if (exportProfile.filters) {
			if (exportProfile.filters.categoryIds) Object.freeze(exportProfile.filters.categoryIds);
			if (exportProfile.filters.accountIds) Object.freeze(exportProfile.filters.accountIds);
			if (exportProfile.filters.transactionSources) Object.freeze(exportProfile.filters.transactionSources);
			Object.freeze(exportProfile.filters);
		}
		for (const column of exportProfile.columns) Object.freeze(column);
		Object.freeze(exportProfile.columns);
		Object.freeze(exportProfile);
	}
	Object.freeze(profile.categories);
	Object.freeze(profile.customFields);
	Object.freeze(profile.categorizationRules);
	Object.freeze(profile.exportProfiles);
	return Object.freeze(profile);
}

function hashProfile(profile: BookkeepingProfile): string {
	return hashSerializedProfile(serializeBookkeepingProfile(profile));
}

function hashSerializedProfile(profileJson: string): string {
	return createHash("sha256").update(profileJson).digest("hex");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BookkeepingProfileError(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
	if (unknown) throw new BookkeepingProfileError(`${label} contains unknown property "${unknown}".`);
}

function requireArray(value: unknown, label: string, maximum: number): unknown[] {
	if (!Array.isArray(value)) throw new BookkeepingProfileError(`${label} must be an array.`);
	if (value.length > maximum) throw new BookkeepingProfileError(`${label} must contain at most ${maximum} items.`);
	return value;
}

function requireIdentifier(value: unknown, label: string): string {
	const identifier = requireText(value, label, 80).toLocaleLowerCase("en-US");
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new BookkeepingProfileError(
			`${label} must start with a letter and contain only lowercase letters, numbers, dots, underscores, or hyphens.`,
		);
	}
	return identifier;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requireIdentifier(value, label);
}

function requireText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new BookkeepingProfileError(`${label} must be a non-empty string.`);
	}
	const text = value.trim();
	if (text.length > maximumLength) {
		throw new BookkeepingProfileError(`${label} must not exceed ${maximumLength} characters.`);
	}
	return text;
}

function assertUniqueIds(values: readonly { id: string }[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value.id)) throw new BookkeepingProfileError(`Duplicate ${label} id "${value.id}".`);
		seen.add(value.id);
	}
}

function assertUniqueStrings(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw new BookkeepingProfileError(`${label} must be unique.`);
	}
}

function optionalIdentifierArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	const values = requireArray(value, label, MAX_CATEGORIES).map((item, index) =>
		requireIdentifier(item, `${label}[${index}]`),
	);
	assertUniqueStrings(values, label);
	return values;
}

function optionalTextArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	const values = requireArray(value, label, MAX_CATEGORIES).map((item, index) =>
		requireText(item, `${label}[${index}]`, 200),
	);
	assertUniqueStrings(values, label);
	return values;
}

function isExportColumnSource(value: string): value is BookkeepingExportColumnSource {
	if ((BOOKKEEPING_EXPORT_COLUMN_SOURCES as readonly string[]).includes(value)) return true;
	if (!value.startsWith("customFields.")) return false;
	const fieldId = value.slice("customFields.".length);
	return IDENTIFIER_PATTERN.test(fieldId) && fieldId.length <= 80;
}

function isValidDate(value: string): boolean {
	if (!DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === "string" && allowed.includes(value);
}
