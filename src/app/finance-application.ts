import type { Account } from "../core/types.ts";
import { WealthService } from "../core/wealth-service.ts";
import { BookkeepingProfileService } from "./bookkeeping-profile.ts";
import { BookkeepingExportService } from "./bookkeeping-export.ts";
import { ConfirmationStore, type PendingOperation } from "./confirmation.ts";
import { getFinanceRisk, isFinanceReadIr, type FinanceIr, type FinanceRisk } from "./finance-ir.ts";
import type { IdentityScope } from "./identity.ts";

export interface ConfirmationPolicy {
	requiresConfirmation(ir: FinanceIr, risk: FinanceRisk, scope: IdentityScope): boolean;
}

export class DefaultConfirmationPolicy implements ConfirmationPolicy {
	requiresConfirmation(_ir: FinanceIr, risk: FinanceRisk, _scope: IdentityScope): boolean {
		return risk === "medium" || risk === "high";
	}
}

export type FinanceApplicationResult =
	| { status: "executed"; risk: FinanceRisk; ir: FinanceIr; result: unknown }
	| {
			status: "confirmation_required";
			risk: "medium" | "high";
			ir: FinanceIr;
			pendingOperation: PendingOperation;
			confirmationToken: string;
			summary: string;
	  };

export class FinanceApplication {
	private readonly wealth: WealthService;
	private readonly confirmations: ConfirmationStore;
	private readonly profiles: BookkeepingProfileService | undefined;
	private readonly exports: BookkeepingExportService | undefined;
	private readonly policy: ConfirmationPolicy;

	constructor(
		wealth: WealthService,
		confirmations: ConfirmationStore,
		policy: ConfirmationPolicy = new DefaultConfirmationPolicy(),
		profiles?: BookkeepingProfileService,
	) {
		this.wealth = wealth;
		this.confirmations = confirmations;
		this.profiles = profiles;
		this.exports = profiles ? new BookkeepingExportService(wealth, profiles) : undefined;
		this.policy = policy;
	}

	submit(ir: FinanceIr, scope: IdentityScope): FinanceApplicationResult {
		this.assertScope(ir, scope);
		const risk = getFinanceRisk(ir);
		if (!isFinanceReadIr(ir) && this.policy.requiresConfirmation(ir, risk, scope)) {
			if (risk === "none") throw new Error(`Invalid confirmation risk ${risk}.`);
			const confirmationRisk = risk === "high" ? "high" : "medium";
			const pending = this.confirmations.create(ir, confirmationRisk);
			return {
				status: "confirmation_required",
				risk: confirmationRisk,
				ir,
				pendingOperation: pending.operation,
				confirmationToken: pending.confirmationToken,
				summary: this.summarizeFinanceIr(ir),
			};
		}
		return { status: "executed", risk, ir, result: this.execute(ir, scope) };
	}

	confirm(confirmationToken: string, scope: IdentityScope): FinanceApplicationResult {
		const operation = this.confirmations.consume(confirmationToken, scope);
		try {
			const result = this.execute(operation.ir, scope);
			this.confirmations.markExecuted(operation.id);
			return { status: "executed", risk: operation.risk, ir: operation.ir, result };
		} catch (error) {
			this.confirmations.markFailed(operation.id, error);
			throw error;
		}
	}

	reject(pendingOperationId: string, scope: IdentityScope): PendingOperation {
		return this.confirmations.reject(pendingOperationId, scope);
	}

	private assertScope(ir: FinanceIr, scope: IdentityScope): void {
		if (
			ir.householdId !== scope.householdId ||
			ir.actorId !== scope.actorId ||
			ir.sessionId !== scope.sessionId ||
			ir.householdId !== this.wealth.household.id
		) {
			throw new Error("Finance IR identity scope does not match the active application scope.");
		}
		if (scope.role === "viewer" && !isFinanceReadIr(ir)) {
			throw new Error("Viewer role cannot submit financial mutations.");
		}
	}

	private execute(ir: FinanceIr, scope: IdentityScope): unknown {
		switch (ir.kind) {
			case "list_accounts":
				return this.wealth.listAccounts();
			case "list_transactions":
				return this.wealth.listTransactions(ir.payload.limit);
			case "list_card_reminders":
				return this.wealth.listCardReminders(ir.payload);
			case "get_net_worth":
				return this.wealth.getNetWorth(ir.payload.asOf);
			case "get_spending_summary":
				return this.wealth.getSpendingSummary(ir.payload.from, ir.payload.to);
			case "get_bookkeeping_profile":
				return this.requireProfiles().getActiveProfile(ir.householdId);
			case "preview_bookkeeping_export":
				return this.requireExports().preview({
					householdId: ir.householdId,
					exportProfileId: ir.payload.exportProfileId,
					from: ir.payload.from,
					to: ir.payload.to,
					...(ir.payload.limit === undefined ? {} : { limit: ir.payload.limit }),
				});
			case "explain_bookkeeping_match":
				return this.explainBookkeepingMatch(ir);
			case "create_account":
				return this.wealth.createAccount(ir.payload);
			case "record_expense":
				return this.recordExpense(ir);
			case "record_income":
				return this.recordIncome(ir);
			case "record_transfer":
				return this.wealth.recordTransfer({ ...ir.payload, idempotencyKey: ir.idempotencyKey });
			case "reverse_transaction":
				return this.wealth.reverseTransaction({ ...ir.payload, idempotencyKey: ir.idempotencyKey });
			case "record_card_statement":
				return this.wealth.recordCardStatement(ir.payload);
			case "record_card_payment":
				return this.wealth.recordCardPayment({ ...ir.payload, idempotencyKey: ir.idempotencyKey });
			case "register_asset":
				return this.wealth.registerAsset(ir.payload);
			case "record_asset_valuation":
				return this.wealth.recordAssetValuation(ir.payload);
			case "update_bookkeeping_profile":
				return this.requireProfiles().patchProfile(scope, {
					patch: ir.payload.patch,
					expectedRevision: ir.payload.expectedRevision,
					source: ir.source === "agent" ? "agent" : "user",
				});
		}
	}

	private requireProfiles(): BookkeepingProfileService {
		if (!this.profiles) throw new Error("Bookkeeping profile service is not configured.");
		return this.profiles;
	}

	private requireExports(): BookkeepingExportService {
		if (!this.exports) throw new Error("Bookkeeping export service is not configured.");
		return this.exports;
	}

	private recordExpense(ir: Extract<FinanceIr, { kind: "record_expense" }>): unknown {
		const duplicate = this.wealth.findLedgerTransactionByIdempotencyKey(ir.idempotencyKey);
		if (duplicate) return duplicate;
		const { categoryId, customFields, expenseAccountId, shortcutId, ...payload } = ir.payload;
		if (!this.profiles) {
			if (!expenseAccountId) throw new Error("Expense account id is required without a bookkeeping profile service.");
			if (!payload.description || !payload.amount) {
				throw new Error("Expense description and amount are required without a bookkeeping profile service.");
			}
			return this.wealth.recordExpense({
				...payload,
				description: payload.description,
				amount: payload.amount,
				expenseAccountId,
				idempotencyKey: ir.idempotencyKey,
			});
		}
		const funding = this.wealth.getAccount(payload.fundingAccountId);
		const capture = this.expandCapture({
			householdId: ir.householdId,
			transactionKind: "expense",
			currency: funding.currency,
			...(shortcutId ? { shortcutId } : {}),
			...(payload.description ? { description: payload.description } : {}),
			...(payload.amount ? { amount: payload.amount } : {}),
			...(categoryId ? { categoryId } : {}),
			...(customFields ? { customFields } : {}),
		});
		const resolved = this.profiles.resolveTransaction({
			householdId: ir.householdId,
			transactionKind: "expense",
			description: capture.description,
			amount: capture.amount,
			currency: funding.currency,
			...(expenseAccountId ? { accountId: expenseAccountId } : {}),
			...(capture.categoryId ? { categoryId: capture.categoryId } : {}),
			...(shortcutId ? { shortcutId } : {}),
			...(capture.customFields ? { customFields: capture.customFields } : {}),
		});
		return this.wealth.recordExpense(
			{
				...payload,
				description: capture.description,
				amount: capture.amount,
				expenseAccountId: resolved.accountId,
				idempotencyKey: ir.idempotencyKey,
			},
			resolved.bookkeeping,
		);
	}

	private recordIncome(ir: Extract<FinanceIr, { kind: "record_income" }>): unknown {
		const duplicate = this.wealth.findLedgerTransactionByIdempotencyKey(ir.idempotencyKey);
		if (duplicate) return duplicate;
		const { categoryId, customFields, incomeAccountId, shortcutId, ...payload } = ir.payload;
		if (!this.profiles) {
			if (!incomeAccountId) throw new Error("Income account id is required without a bookkeeping profile service.");
			if (!payload.description || !payload.amount) {
				throw new Error("Income description and amount are required without a bookkeeping profile service.");
			}
			return this.wealth.recordIncome({
				...payload,
				description: payload.description,
				amount: payload.amount,
				incomeAccountId,
				idempotencyKey: ir.idempotencyKey,
			});
		}
		const destination = this.wealth.getAccount(payload.destinationAccountId);
		const capture = this.expandCapture({
			householdId: ir.householdId,
			transactionKind: "income",
			currency: destination.currency,
			...(shortcutId ? { shortcutId } : {}),
			...(payload.description ? { description: payload.description } : {}),
			...(payload.amount ? { amount: payload.amount } : {}),
			...(categoryId ? { categoryId } : {}),
			...(customFields ? { customFields } : {}),
		});
		const resolved = this.profiles.resolveTransaction({
			householdId: ir.householdId,
			transactionKind: "income",
			description: capture.description,
			amount: capture.amount,
			currency: destination.currency,
			...(incomeAccountId ? { accountId: incomeAccountId } : {}),
			...(capture.categoryId ? { categoryId: capture.categoryId } : {}),
			...(shortcutId ? { shortcutId } : {}),
			...(capture.customFields ? { customFields: capture.customFields } : {}),
		});
		return this.wealth.recordIncome(
			{
				...payload,
				description: capture.description,
				amount: capture.amount,
				incomeAccountId: resolved.accountId,
				idempotencyKey: ir.idempotencyKey,
			},
			resolved.bookkeeping,
		);
	}

	private explainBookkeepingMatch(ir: Extract<FinanceIr, { kind: "explain_bookkeeping_match" }>): unknown {
		const profiles = this.requireProfiles();
		const capture = this.expandCapture({
			householdId: ir.householdId,
			transactionKind: ir.payload.transactionKind,
			currency: ir.payload.currency,
			...(ir.payload.shortcutId ? { shortcutId: ir.payload.shortcutId } : {}),
			...(ir.payload.description ? { description: ir.payload.description } : {}),
			...(ir.payload.amount ? { amount: ir.payload.amount } : {}),
			...(ir.payload.categoryId ? { categoryId: ir.payload.categoryId } : {}),
			...(ir.payload.customFields ? { customFields: ir.payload.customFields } : {}),
		});
		return profiles.explainMatch({
			householdId: ir.householdId,
			transactionKind: ir.payload.transactionKind,
			description: capture.description,
			amount: capture.amount,
			currency: ir.payload.currency,
			...(ir.payload.accountId ? { accountId: ir.payload.accountId } : {}),
			...(capture.categoryId ? { categoryId: capture.categoryId } : {}),
			...(ir.payload.shortcutId ? { shortcutId: ir.payload.shortcutId } : {}),
			...(capture.customFields ? { customFields: capture.customFields } : {}),
		});
	}

	private expandCapture(input: {
		householdId: string;
		transactionKind: "expense" | "income";
		currency: string;
		shortcutId?: string;
		description?: string;
		amount?: string;
		categoryId?: string;
		customFields?: Readonly<Record<string, string | boolean | number>>;
	}): { description: string; amount: string; categoryId?: string; customFields?: Readonly<Record<string, string | boolean | number>> } {
		if (!input.shortcutId) {
			if (!input.description?.trim() || !input.amount?.trim()) {
				throw new Error(`${input.transactionKind === "expense" ? "Expense" : "Income"} description and amount are required.`);
			}
			return {
				description: input.description,
				amount: input.amount,
				...(input.categoryId ? { categoryId: input.categoryId } : {}),
				...(input.customFields ? { customFields: input.customFields } : {}),
			};
		}
		return this.requireProfiles().expandCaptureShortcut({
			householdId: input.householdId,
			transactionKind: input.transactionKind,
			shortcutId: input.shortcutId,
			currency: input.currency,
			...(input.description ? { description: input.description } : {}),
			...(input.amount ? { amount: input.amount } : {}),
			...(input.categoryId ? { categoryId: input.categoryId } : {}),
			...(input.customFields ? { customFields: input.customFields } : {}),
		});
	}

	private summarizeFinanceIr(ir: FinanceIr): string {
		switch (ir.kind) {
			case "create_account":
				return `Create ${ir.payload.type} account "${ir.payload.name}".`;
			case "record_transfer":
				return `Record transfer of ${ir.payload.amount}.`;
			case "record_card_statement":
				return `Record card statement of ${ir.payload.statementAmount} due ${ir.payload.dueDate}.`;
			case "register_asset":
				return `Register ${ir.payload.kind} asset.`;
			case "record_asset_valuation":
				return `Record asset valuation of ${ir.payload.amount} on ${ir.payload.valuedAt}.`;
			case "update_bookkeeping_profile":
				return `Update bookkeeping profile revision ${ir.payload.expectedRevision}.`;
			case "reverse_transaction":
				return `Reverse transaction ${ir.payload.transactionId}.`;
			case "record_card_payment":
				return `Record card payment of ${ir.payload.amount}.`;
			case "record_expense":
				return `Record expense of ${this.summarizeCaptureAmount(ir)}.`;
			case "record_income":
				return `Record income of ${this.summarizeCaptureAmount(ir)}.`;
			default:
				return `Execute ${ir.kind}.`;
		}
	}

	private summarizeCaptureAmount(
		ir: Extract<FinanceIr, { kind: "record_expense" | "record_income" }>,
	): string {
		if (ir.payload.amount?.trim()) return ir.payload.amount.trim();
		if (!ir.payload.shortcutId) {
			throw new Error(
				`${ir.kind === "record_expense" ? "Expense" : "Income"} description and amount are required.`,
			);
		}
		const accountId =
			ir.kind === "record_expense" ? ir.payload.fundingAccountId : ir.payload.destinationAccountId;
		const currency = this.wealth.getAccount(accountId).currency;
		return this.expandCapture({
			householdId: ir.householdId,
			transactionKind: ir.kind === "record_expense" ? "expense" : "income",
			currency,
			shortcutId: ir.payload.shortcutId,
			...(ir.payload.description ? { description: ir.payload.description } : {}),
			...(ir.payload.categoryId ? { categoryId: ir.payload.categoryId } : {}),
			...(ir.payload.customFields ? { customFields: ir.payload.customFields } : {}),
		}).amount;
	}
}

export function getExecutedAccounts(result: FinanceApplicationResult): Account[] | undefined {
	return result.status === "executed" && Array.isArray(result.result)
		? result.result.filter((item): item is Account => isAccount(item))
		: undefined;
}

function isAccount(value: unknown): value is Account {
	return typeof value === "object" && value !== null && "id" in value && "type" in value && "currency" in value;
}
