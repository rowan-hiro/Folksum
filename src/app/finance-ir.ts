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
} from "../core/types.ts";

export type FinanceIrSource = "agent" | "channel" | "scheduler";
export type FinanceRisk = "none" | "low" | "medium" | "high";

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
	Omit<RecordExpenseInput, "idempotencyKey">
>;
export type RecordIncomeIr = MutationFinanceIrBase<"record_income", Omit<RecordIncomeInput, "idempotencyKey">>;
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

export type FinanceMutationIr =
	| CreateAccountIr
	| RecordExpenseIr
	| RecordIncomeIr
	| RecordTransferIr
	| ReverseTransactionIr
	| RecordCardStatementIr
	| RecordCardPaymentIr
	| RegisterAssetIr
	| RecordAssetValuationIr;

export type ListAccountsIr = FinanceIrBase<"list_accounts", Record<string, never>>;
export type ListTransactionsIr = FinanceIrBase<"list_transactions", { limit?: number }>;
export type ListCardRemindersIr = FinanceIrBase<"list_card_reminders", ListCardRemindersInput>;
export type GetNetWorthIr = FinanceIrBase<"get_net_worth", { asOf?: string }>;
export type GetSpendingSummaryIr = FinanceIrBase<"get_spending_summary", { from: string; to: string }>;

export type FinanceReadIr =
	| ListAccountsIr
	| ListTransactionsIr
	| ListCardRemindersIr
	| GetNetWorthIr
	| GetSpendingSummaryIr;

export type FinanceIr = FinanceMutationIr | FinanceReadIr;

const READ_KINDS = new Set<FinanceIr["kind"]>([
	"list_accounts",
	"list_transactions",
	"list_card_reminders",
	"get_net_worth",
	"get_spending_summary",
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
			return "none";
		case "record_expense":
		case "record_income":
			return "low";
		case "create_account":
		case "record_transfer":
		case "record_card_statement":
		case "register_asset":
		case "record_asset_valuation":
			return "medium";
		case "reverse_transaction":
		case "record_card_payment":
			return "high";
	}
}
