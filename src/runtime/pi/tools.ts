import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { FinanceApplication, type FinanceApplicationResult } from "../../app/finance-application.ts";
import type { FinanceIr } from "../../app/finance-ir.ts";
import type { IdentityScope } from "../../app/identity.ts";
import type { CardTrackingMode } from "../../core/card-tracking.ts";

export interface PiConfirmationRequest {
	pendingOperationId: string;
	risk: "medium" | "high";
	summary: string;
	confirmationToken: string;
}

export interface FinanceToolDetails {
	status: "executed" | "confirmation_required";
	kind: FinanceIr["kind"];
	pendingOperationId?: string;
}

export interface CreateFinanceToolsOptions {
	application: FinanceApplication;
	scope: IdentityScope;
	cardTrackingMode: CardTrackingMode;
	onConfirmationRequired?: (request: PiConfirmationRequest) => void;
}

interface CreateAccountParams {
	name: string;
	type: "asset" | "liability" | "income" | "expense" | "equity";
	currency?: string;
	subtype?: string;
	ownerName?: string;
	openingBalance?: string;
}

interface RecordExpenseParams {
	description: string;
	amount: string;
	expenseAccountId: string;
	fundingAccountId: string;
	occurredAt?: string;
}

interface RecordIncomeParams {
	description: string;
	amount: string;
	incomeAccountId: string;
	destinationAccountId: string;
	occurredAt?: string;
}

interface RecordTransferParams {
	description: string;
	amount: string;
	fromAccountId: string;
	toAccountId: string;
	occurredAt?: string;
}

interface ListTransactionsParams {
	limit?: number;
}

interface ReverseTransactionParams {
	transactionId: string;
	description?: string;
	occurredAt?: string;
}

interface RecordCardStatementParams {
	cardAccountId: string;
	periodStart: string;
	periodEnd: string;
	statementDate: string;
	dueDate: string;
	statementAmount: string;
	minimumPayment?: string;
}

interface RecordCardPaymentParams {
	statementId: string;
	fundingAccountId?: string;
	amount: string;
	occurredAt?: string;
}

interface ListCardRemindersParams {
	asOf?: string;
	windowDays?: number;
}

interface RegisterAssetParams {
	accountId: string;
	kind: "property" | "investment" | "vehicle" | "collectible" | "business" | "other";
	freshnessDays?: number;
}

interface RecordAssetValuationParams {
	assetId: string;
	valuedAt: string;
	amount: string;
	note?: string;
}

interface GetNetWorthParams {
	asOf?: string;
}

interface GetSpendingSummaryParams {
	from: string;
	to: string;
}

export function createFinanceTools(options: CreateFinanceToolsOptions): AgentTool[] {
	const { application, scope, cardTrackingMode, onConfirmationRequired } = options;

	function base(kind: FinanceIr["kind"], payload: object): Omit<FinanceIr, "kind" | "payload"> & {
		kind: FinanceIr["kind"];
		payload: object;
	} {
		return {
			version: 1,
			kind,
			householdId: scope.householdId,
			actorId: scope.actorId,
			sessionId: scope.sessionId,
			source: "agent",
			payload,
		};
	}

	function mutation(kind: FinanceIr["kind"], payload: object, toolCallId: string): FinanceIr {
		return {
			...base(kind, payload),
			idempotencyKey: `${scope.sessionId}:${toolCallId}`,
		} as FinanceIr;
	}

	function read(kind: FinanceIr["kind"], payload: object): FinanceIr {
		return base(kind, payload) as FinanceIr;
	}

	function submit(ir: FinanceIr): AgentToolResult<FinanceToolDetails> {
		const result = application.submit(ir, scope);
		if (result.status === "confirmation_required") {
			onConfirmationRequired?.({
				pendingOperationId: result.pendingOperation.id,
				risk: result.risk,
				summary: result.summary,
				confirmationToken: result.confirmationToken,
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							status: "confirmation_required",
							pendingOperationId: result.pendingOperation.id,
							risk: result.risk,
							summary: result.summary,
						}),
					},
				],
				details: {
					status: "confirmation_required",
					kind: ir.kind,
					pendingOperationId: result.pendingOperation.id,
				},
				terminate: true,
			};
		}
		return executedToolResult(ir, result);
	}

	const accountType = Type.Union([
		Type.Literal("asset"),
		Type.Literal("liability"),
		Type.Literal("income"),
		Type.Literal("expense"),
		Type.Literal("equity"),
	]);
	const assetKind = Type.Union([
		Type.Literal("property"),
		Type.Literal("investment"),
		Type.Literal("vehicle"),
		Type.Literal("collectible"),
		Type.Literal("business"),
		Type.Literal("other"),
	]);

	return [
		{
			name: "list_accounts",
			label: "List accounts",
			description: "List household accounts, ids, types, currencies, and current balances.",
			parameters: Type.Object({}),
			async execute() {
				return submit(read("list_accounts", {}));
			},
		},
		{
			name: "create_account",
			label: "Create account",
			description: "Propose a new ledger account. This normally requires user confirmation.",
			parameters: Type.Object({
				name: Type.String({ description: "Unique account name" }),
				type: accountType,
				currency: Type.Optional(Type.String({ description: "Three-letter currency code" })),
				subtype: Type.Optional(Type.String({ description: "Use credit_card for a card liability" })),
				ownerName: Type.Optional(Type.String()),
				openingBalance: Type.Optional(Type.String({ description: "Positive decimal amount" })),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as CreateAccountParams;
				return submit(
					mutation(
						"create_account",
						{
							name: params.name,
							type: params.type,
							...(params.currency ? { currency: params.currency } : {}),
							...(params.subtype ? { subtype: params.subtype } : {}),
							...(params.ownerName ? { ownerName: params.ownerName } : {}),
							...(params.openingBalance ? { openingBalance: params.openingBalance } : {}),
						},
						toolCallId,
					),
				);
			},
			executionMode: "sequential",
		},
		{
			name: "record_expense",
			label: "Record expense",
			description:
				cardTrackingMode === "integrated"
					? "Record an everyday expense against an expense account and an asset or credit-card ledger account."
					: "Record an everyday ledger expense paid from an asset account. Credit-card obligations are tracked separately in lightweight mode.",
			parameters: Type.Object({
				description: Type.String(),
				amount: Type.String({ description: "Plain decimal amount" }),
				expenseAccountId: Type.String(),
				fundingAccountId: Type.String(),
				occurredAt: Type.Optional(Type.String({ description: "YYYY-MM-DD or ISO timestamp" })),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordExpenseParams;
				return submit(
					mutation(
						"record_expense",
						{ ...params, ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}) },
						toolCallId,
					),
				);
			},
			executionMode: "sequential",
		},
		{
			name: "record_income",
			label: "Record income",
			description: "Record income received into an asset account.",
			parameters: Type.Object({
				description: Type.String(),
				amount: Type.String(),
				incomeAccountId: Type.String(),
				destinationAccountId: Type.String(),
				occurredAt: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordIncomeParams;
				return submit(mutation("record_income", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "record_transfer",
			label: "Record transfer",
			description: "Propose a transfer between compatible asset or liability accounts.",
			parameters: Type.Object({
				description: Type.String(),
				amount: Type.String(),
				fromAccountId: Type.String(),
				toAccountId: Type.String(),
				occurredAt: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordTransferParams;
				return submit(mutation("record_transfer", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "list_transactions",
			label: "List transactions",
			description: "List recent immutable ledger transactions and postings.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
			async execute(_toolCallId, rawParams) {
				const params = rawParams as ListTransactionsParams;
				return submit(read("list_transactions", params.limit ? { limit: params.limit } : {}));
			},
		},
		{
			name: "reverse_transaction",
			label: "Reverse transaction",
			description: "Propose an auditable reversal of an existing transaction. Always requires confirmation.",
			parameters: Type.Object({
				transactionId: Type.String(),
				description: Type.Optional(Type.String()),
				occurredAt: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as ReverseTransactionParams;
				return submit(mutation("reverse_transaction", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "record_card_statement",
			label: "Record card statement",
			description: `Propose a credit-card statement with its statement period, amount, and due date. The statement will retain the current ${cardTrackingMode} accounting mode.`,
			parameters: Type.Object({
				cardAccountId: Type.String(),
				periodStart: Type.String({ description: "YYYY-MM-DD" }),
				periodEnd: Type.String({ description: "YYYY-MM-DD" }),
				statementDate: Type.String({ description: "YYYY-MM-DD" }),
				dueDate: Type.String({ description: "YYYY-MM-DD" }),
				statementAmount: Type.String(),
				minimumPayment: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordCardStatementParams;
				return submit(mutation("record_card_statement", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "record_card_payment",
			label: "Record card payment",
			description:
				cardTrackingMode === "integrated"
					? "Propose recording and allocating a card repayment through the ledger. fundingAccountId is required. Always requires confirmation."
					: "Propose marking a standalone card-statement repayment without changing ledger balances. fundingAccountId is optional metadata. Always requires confirmation.",
			parameters: Type.Object({
				statementId: Type.String(),
				...(cardTrackingMode === "integrated"
					? { fundingAccountId: Type.String() }
					: { fundingAccountId: Type.Optional(Type.String()) }),
				amount: Type.String(),
				occurredAt: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordCardPaymentParams;
				return submit(mutation("record_card_payment", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "list_card_reminders",
			label: "List card reminders",
			description: "List due-soon and overdue credit-card statements. This does not initiate payment.",
			parameters: Type.Object({
				asOf: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
				windowDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
			}),
			async execute(_toolCallId, rawParams) {
				const params = rawParams as ListCardRemindersParams;
				return submit(read("list_card_reminders", params));
			},
		},
		{
			name: "register_asset",
			label: "Register asset",
			description: "Propose marking an asset account for dated market valuations.",
			parameters: Type.Object({
				accountId: Type.String(),
				kind: assetKind,
				freshnessDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RegisterAssetParams;
				return submit(mutation("register_asset", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "record_asset_valuation",
			label: "Record asset valuation",
			description: "Propose a dated total valuation for a registered non-cash asset.",
			parameters: Type.Object({
				assetId: Type.String(),
				valuedAt: Type.String({ description: "YYYY-MM-DD" }),
				amount: Type.String(),
				note: Type.Optional(Type.String()),
			}),
			async execute(toolCallId, rawParams) {
				const params = rawParams as RecordAssetValuationParams;
				return submit(mutation("record_asset_valuation", params, toolCallId));
			},
			executionMode: "sequential",
		},
		{
			name: "get_net_worth",
			label: "Get net worth",
			description: "Calculate assets, liabilities, and net worth separately by currency.",
			parameters: Type.Object({ asOf: Type.Optional(Type.String({ description: "YYYY-MM-DD" })) }),
			async execute(_toolCallId, rawParams) {
				const params = rawParams as GetNetWorthParams;
				return submit(read("get_net_worth", params));
			},
		},
		{
			name: "get_spending_summary",
			label: "Get spending summary",
			description: "Summarize net expense postings by category and currency for an inclusive date range.",
			parameters: Type.Object({
				from: Type.String({ description: "YYYY-MM-DD" }),
				to: Type.String({ description: "YYYY-MM-DD" }),
			}),
			async execute(_toolCallId, rawParams) {
				const params = rawParams as GetSpendingSummaryParams;
				return submit(read("get_spending_summary", params));
			},
		},
	];
}

function executedToolResult(
	ir: FinanceIr,
	result: Extract<FinanceApplicationResult, { status: "executed" }>,
): AgentToolResult<FinanceToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify({ status: "executed", result: result.result }) }],
		details: { status: "executed", kind: ir.kind },
	};
}
