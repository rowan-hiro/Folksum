import type {
	CreateAccountInput,
	ListCardRemindersInput,
	RecordAssetValuationInput,
	RecordCardPaymentInput,
	RecordCardStatementInput,
	RecordExpenseInput,
	RecordIncomeInput,
	RecordTransferInput,
	RegisterAssetInput,
	ReverseTransactionInput,
	TransactionCustomFieldValue,
} from "../core/types.ts";
import type { BookkeepingProfilePatch, BookkeepingCategoryKind } from "./bookkeeping-profile.ts";

export type FinanceIrSource = "agent" | "channel" | "scheduler";
export type FinanceRisk = "none" | "low" | "medium" | "high";

export interface BookkeepingProfileExpectation {
	revision: number;
	profileHash: string;
}

interface FinanceIrBase<TKind extends string, TPayload> {
	version: 1;
	kind: TKind;
	householdId: string;
	actorId: string;
	sessionId: string;
	source: FinanceIrSource;
	payload: TPayload;
}

interface MutationFinanceIrBase<TKind extends string, TPayload> extends FinanceIrBase<TKind, TPayload> {
	idempotencyKey: string;
}

export type CreateAccountIr = MutationFinanceIrBase<"create_account", CreateAccountInput>;
export type RecordExpenseIr = MutationFinanceIrBase<
	"record_expense",
	Omit<RecordExpenseInput, "idempotencyKey" | "expenseAccountId" | "description" | "amount"> & {
		expenseAccountId?: string;
		categoryId?: string;
		customFields?: Readonly<Record<string, TransactionCustomFieldValue>>;
		shortcutId?: string;
		expectedBookkeepingProfile?: BookkeepingProfileExpectation;
		description?: string;
		amount?: string;
	}
>;
export type RecordIncomeIr = MutationFinanceIrBase<
	"record_income",
	Omit<RecordIncomeInput, "idempotencyKey" | "incomeAccountId" | "description" | "amount"> & {
		incomeAccountId?: string;
		categoryId?: string;
		customFields?: Readonly<Record<string, TransactionCustomFieldValue>>;
		shortcutId?: string;
		expectedBookkeepingProfile?: BookkeepingProfileExpectation;
		description?: string;
		amount?: string;
	}
>;
export type RecordTransferIr = MutationFinanceIrBase<
	"record_transfer",
	Omit<RecordTransferInput, "idempotencyKey">
>;
export type ReverseTransactionIr = MutationFinanceIrBase<
	"reverse_transaction",
	Omit<ReverseTransactionInput, "idempotencyKey">
>;
export type RecordCardStatementIr = MutationFinanceIrBase<"record_card_statement", RecordCardStatementInput>;
export type RecordCardPaymentIr = MutationFinanceIrBase<
	"record_card_payment",
	Omit<RecordCardPaymentInput, "idempotencyKey">
>;
export type RegisterAssetIr = MutationFinanceIrBase<"register_asset", RegisterAssetInput>;
export type RecordAssetValuationIr = MutationFinanceIrBase<"record_asset_valuation", RecordAssetValuationInput>;
export type UpdateBookkeepingProfileIr = MutationFinanceIrBase<
	"update_bookkeeping_profile",
	{ expectedRevision: number; patch: BookkeepingProfilePatch }
>;

export type FinanceMutationIr =
	| CreateAccountIr
	| RecordExpenseIr
	| RecordIncomeIr
	| RecordTransferIr
	| ReverseTransactionIr
	| RecordCardStatementIr
	| RecordCardPaymentIr
	| RegisterAssetIr
	| RecordAssetValuationIr
	| UpdateBookkeepingProfileIr;

export type ListAccountsIr = FinanceIrBase<"list_accounts", Record<string, never>>;
export type ListTransactionsIr = FinanceIrBase<"list_transactions", { limit?: number }>;
export type ListCardRemindersIr = FinanceIrBase<"list_card_reminders", ListCardRemindersInput>;
export type GetNetWorthIr = FinanceIrBase<"get_net_worth", { asOf?: string }>;
export type GetSpendingSummaryIr = FinanceIrBase<"get_spending_summary", { from: string; to: string }>;
export type GetBookkeepingProfileIr = FinanceIrBase<"get_bookkeeping_profile", Record<string, never>>;
export type PreviewBookkeepingExportIr = FinanceIrBase<
	"preview_bookkeeping_export",
	{ exportProfileId: string; from: string; to: string; limit?: number }
>;
export type ExplainBookkeepingMatchIr = FinanceIrBase<
	"explain_bookkeeping_match",
	{
		transactionKind: BookkeepingCategoryKind;
		description?: string;
		amount?: string;
		currency: string;
		accountId?: string;
		categoryId?: string;
		customFields?: Readonly<Record<string, TransactionCustomFieldValue>>;
		shortcutId?: string;
	}
>;

export type FinanceReadIr =
	| ListAccountsIr
	| ListTransactionsIr
	| ListCardRemindersIr
	| GetNetWorthIr
	| GetSpendingSummaryIr
	| GetBookkeepingProfileIr
	| PreviewBookkeepingExportIr
	| ExplainBookkeepingMatchIr;

export type FinanceIr = FinanceMutationIr | FinanceReadIr;

const READ_KINDS = new Set<FinanceIr["kind"]>([
	"list_accounts",
	"list_transactions",
	"list_card_reminders",
	"get_net_worth",
	"get_spending_summary",
	"get_bookkeeping_profile",
	"preview_bookkeeping_export",
	"explain_bookkeeping_match",
]);

export function isFinanceReadIr(ir: FinanceIr): ir is FinanceReadIr {
	return READ_KINDS.has(ir.kind);
}

export function getFinanceRisk(ir: FinanceIr): FinanceRisk {
	switch (ir.kind) {
		case "list_accounts":
		case "list_transactions":
		case "list_card_reminders":
		case "get_net_worth":
		case "get_spending_summary":
		case "get_bookkeeping_profile":
		case "preview_bookkeeping_export":
		case "explain_bookkeeping_match":
			return "none";
		case "record_expense":
		case "record_income":
			return "low";
		case "create_account":
		case "record_transfer":
		case "record_card_statement":
		case "register_asset":
		case "record_asset_valuation":
		case "update_bookkeeping_profile":
			return "medium";
		case "reverse_transaction":
		case "record_card_payment":
			return "high";
	}
}
