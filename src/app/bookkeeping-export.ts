import {
	BookkeepingProfileError,
	BookkeepingProfileService,
	type BookkeepingExportAmountSign,
	type BookkeepingExportColumnSource,
	type BookkeepingExportProfileDefinition,
} from "./bookkeeping-profile.ts";
import { formatDecimalAmount } from "../core/money.ts";
import type { LedgerTransaction, Posting, TransactionCustomFieldValue } from "../core/types.ts";
import { WealthService } from "../core/wealth-service.ts";

export type BookkeepingExportCell = string | number | boolean | null;
export type BookkeepingExportRow = Readonly<Record<string, BookkeepingExportCell>>;

export interface BookkeepingExportInput {
	householdId: string;
	exportProfileId: string;
	from: string;
	to: string;
}

export interface BookkeepingExportPreviewInput extends BookkeepingExportInput {
	limit?: number;
}

export interface BookkeepingExportArtifact {
	exportProfileId: string;
	label: string;
	format: "csv" | "json";
	rowMode: "transactions" | "postings";
	from: string;
	to: string;
	totalRows: number;
	rows: readonly BookkeepingExportRow[];
	content: string;
	truncated: boolean;
}

interface ExportRowContext {
	transaction: LedgerTransaction;
	posting?: Posting;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_PREVIEW_BYTES = 100_000;

export class BookkeepingExportService {
	private readonly wealth: WealthService;
	private readonly profiles: BookkeepingProfileService;

	constructor(wealth: WealthService, profiles: BookkeepingProfileService) {
		this.wealth = wealth;
		this.profiles = profiles;
	}

	preview(input: BookkeepingExportPreviewInput): BookkeepingExportArtifact {
		const limit = input.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new BookkeepingProfileError("Export preview limit must be an integer from 1 to 100.");
		}
		const artifact = this.createArtifact(input, limit);
		if (Buffer.byteLength(JSON.stringify(artifact), "utf8") > MAX_EXPORT_PREVIEW_BYTES) {
			throw new BookkeepingProfileError(
				`Export preview exceeds ${MAX_EXPORT_PREVIEW_BYTES} bytes; reduce its limit or columns.`,
			);
		}
		return artifact;
	}

	render(input: BookkeepingExportInput): BookkeepingExportArtifact {
		return this.createArtifact(input);
	}

	private createArtifact(input: BookkeepingExportInput, limit?: number): BookkeepingExportArtifact {
		if (input.householdId !== this.wealth.household.id) {
			throw new BookkeepingProfileError("Export household does not match the active wealth service.");
		}
		const from = normalizeDate(input.from, "Export from");
		const to = normalizeDate(input.to, "Export to");
		if (from > to) throw new BookkeepingProfileError("Export range start must not follow its end.");
		const active = this.profiles.getActiveProfile(input.householdId);
		const exportProfileId = input.exportProfileId.trim().toLocaleLowerCase("en-US");
		const exportProfile = active.profile.exportProfiles.find((profile) => profile.id === exportProfileId);
		if (!exportProfile) {
			throw new BookkeepingProfileError(`Unknown export profile "${exportProfileId}".`);
		}

		const contexts = this.buildContexts(this.wealth.listTransactionsInRange(from, to), exportProfile);
		const allRows = contexts.map((context) => projectRow(context, exportProfile));
		const rows = limit === undefined ? allRows : allRows.slice(0, limit);
		return {
			exportProfileId,
			label: exportProfile.label,
			format: exportProfile.format,
			rowMode: exportProfile.rowMode,
			from,
			to,
			totalRows: allRows.length,
			rows,
			content: renderRows(rows, exportProfile),
			truncated: rows.length < allRows.length,
		};
	}

	private buildContexts(
		transactions: readonly LedgerTransaction[],
		exportProfile: BookkeepingExportProfileDefinition,
	): ExportRowContext[] {
		const contexts: ExportRowContext[] = [];
		for (const transaction of transactions) {
			if (exportProfile.reversals === "exclude" && transaction.reversalOf) continue;
			if (exportProfile.reversals === "only" && !transaction.reversalOf) continue;
			if (
				exportProfile.filters?.transactionSources &&
				!exportProfile.filters.transactionSources.includes(transaction.source)
			) {
				continue;
			}
			if (
				exportProfile.filters?.categoryIds &&
				(!transaction.bookkeeping?.categoryId ||
					!exportProfile.filters.categoryIds.includes(transaction.bookkeeping.categoryId))
			) {
				continue;
			}

			if (exportProfile.rowMode === "transactions") {
				if (
					exportProfile.filters?.accountIds &&
					!transaction.postings.some((posting) => exportProfile.filters?.accountIds?.includes(posting.accountId))
				) {
					continue;
				}
				contexts.push({ transaction });
				continue;
			}

			for (const posting of transaction.postings) {
				if (
					exportProfile.filters?.accountIds &&
					!exportProfile.filters.accountIds.includes(posting.accountId)
				) {
					continue;
				}
				contexts.push({ transaction, posting });
			}
		}
		return contexts;
	}
}

function projectRow(
	context: ExportRowContext,
	exportProfile: BookkeepingExportProfileDefinition,
): BookkeepingExportRow {
	const row: Record<string, BookkeepingExportCell> = {};
	for (const column of exportProfile.columns) {
		row[column.header] = readColumn(context, column.source, exportProfile.amountSign);
	}
	return row;
}

function readColumn(
	context: ExportRowContext,
	source: BookkeepingExportColumnSource,
	amountSign: BookkeepingExportAmountSign,
): BookkeepingExportCell {
	const { transaction, posting } = context;
	if (source.startsWith("customFields.")) {
		const fieldId = source.slice("customFields.".length);
		return toCell(transaction.bookkeeping?.customFields[fieldId]);
	}
	switch (source) {
		case "transaction.id":
			return transaction.id;
		case "transaction.description":
			return transaction.description;
		case "transaction.occurredAt":
			return transaction.occurredAt;
		case "transaction.date":
			return transaction.occurredAt.slice(0, 10);
		case "transaction.currency":
			return transaction.currency;
		case "transaction.source":
			return transaction.source;
		case "transaction.idempotencyKey":
			return transaction.idempotencyKey ?? null;
		case "transaction.reversalOf":
			return transaction.reversalOf ?? null;
		case "bookkeeping.profileRevision":
			return transaction.bookkeeping?.profileRevision ?? null;
		case "bookkeeping.categoryId":
			return transaction.bookkeeping?.categoryId ?? null;
		case "bookkeeping.categoryLabel":
			return transaction.bookkeeping?.categoryLabel ?? null;
		case "bookkeeping.ruleId":
			return transaction.bookkeeping?.categorizationRuleId ?? null;
		case "bookkeeping.resolutionSource":
			return transaction.bookkeeping?.resolutionSource ?? null;
		case "posting.id":
			return requirePosting(posting, source).id;
		case "posting.accountId":
			return requirePosting(posting, source).accountId;
		case "posting.accountName":
			return requirePosting(posting, source).accountName;
		case "posting.amount": {
			const selected = requirePosting(posting, source);
			const amountMinor =
				amountSign === "credit-positive"
					? -selected.amountMinor
					: amountSign === "absolute"
						? Math.abs(selected.amountMinor)
						: selected.amountMinor;
			return formatDecimalAmount(amountMinor, transaction.currency);
		}
		case "posting.memo":
			return requirePosting(posting, source).memo ?? null;
	}
	throw new BookkeepingProfileError(`Unsupported export column source "${source}".`);
}

function requirePosting(posting: Posting | undefined, source: string): Posting {
	if (!posting) throw new BookkeepingProfileError(`Export column "${source}" requires posting row mode.`);
	return posting;
}

function toCell(value: TransactionCustomFieldValue | undefined): BookkeepingExportCell {
	return value ?? null;
}

function renderRows(
	rows: readonly BookkeepingExportRow[],
	exportProfile: BookkeepingExportProfileDefinition,
): string {
	if (exportProfile.format === "json") return `${JSON.stringify(rows, null, "\t")}\n`;
	const delimiter = exportProfile.delimiter ?? ",";
	const headers = exportProfile.columns.map((column) => escapeCsv(column.header, delimiter)).join(delimiter);
	const body = rows.map((row) =>
		exportProfile.columns
			.map((column) => escapeCsv(cellText(row[column.header]), delimiter))
			.join(delimiter),
	);
	return `${[headers, ...body].join("\n")}\n`;
}

function cellText(value: BookkeepingExportCell | undefined): string {
	return value === null || value === undefined ? "" : String(value);
}

function escapeCsv(value: string, delimiter: string): string {
	const protectedValue = protectCsvFormula(value);
	if (!protectedValue.includes(delimiter) && !/["\r\n]/.test(protectedValue)) return protectedValue;
	return `"${protectedValue.replaceAll('"', '""')}"`;
}

function protectCsvFormula(value: string): string {
	const trimmedStart = value.trimStart();
	const isPlainNegativeDecimal = /^-\d+(?:\.\d+)?$/.test(trimmedStart);
	if (
		/^[\t\r\n]/.test(value) ||
		/^[=+@]/.test(trimmedStart) ||
		(trimmedStart.startsWith("-") && !isPlainNegativeDecimal)
	) {
		return `'${value}`;
	}
	return value;
}

function normalizeDate(value: string, label: string): string {
	const date = value.trim();
	if (!DATE_PATTERN.test(date)) throw new BookkeepingProfileError(`${label} must use YYYY-MM-DD.`);
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
		throw new BookkeepingProfileError(`${label} must be a valid calendar date.`);
	}
	return date;
}
