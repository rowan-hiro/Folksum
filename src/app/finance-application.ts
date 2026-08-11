import type { Account } from "../core/types.ts";
import { WealthService } from "../core/wealth-service.ts";
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
	private readonly policy: ConfirmationPolicy;

	constructor(
		wealth: WealthService,
		confirmations: ConfirmationStore,
		policy: ConfirmationPolicy = new DefaultConfirmationPolicy(),
	) {
		this.wealth = wealth;
		this.confirmations = confirmations;
		this.policy = policy;
	}

	submit(ir: FinanceIr, scope: IdentityScope): FinanceApplicationResult {
		this.assertScope(ir, scope);
		const risk = getFinanceRisk(ir);
		if (!isFinanceReadIr(ir) && this.policy.requiresConfirmation(ir, risk, scope)) {
			if (risk !== "medium" && risk !== "high") throw new Error(`Invalid confirmation risk ${risk}.`);
			const pending = this.confirmations.create(ir, risk);
			return {
				status: "confirmation_required",
				risk,
				ir,
				pendingOperation: pending.operation,
				confirmationToken: pending.confirmationToken,
				summary: summarizeFinanceIr(ir),
			};
		}
		return { status: "executed", risk, ir, result: this.execute(ir) };
	}

	confirm(confirmationToken: string, scope: IdentityScope): FinanceApplicationResult {
		const operation = this.confirmations.consume(confirmationToken, scope);
		try {
			const result = this.execute(operation.ir);
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

	private execute(ir: FinanceIr): unknown {
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
			case "create_account":
				return this.wealth.createAccount(ir.payload);
			case "record_expense":
				return this.wealth.recordExpense({ ...ir.payload, idempotencyKey: ir.idempotencyKey });
			case "record_income":
				return this.wealth.recordIncome({ ...ir.payload, idempotencyKey: ir.idempotencyKey });
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
		}
	}
}

function summarizeFinanceIr(ir: FinanceIr): string {
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
		case "reverse_transaction":
			return `Reverse transaction ${ir.payload.transactionId}.`;
		case "record_card_payment":
			return `Record card payment of ${ir.payload.amount}.`;
		case "record_expense":
			return `Record expense of ${ir.payload.amount}.`;
		case "record_income":
			return `Record income of ${ir.payload.amount}.`;
		default:
			return `Execute ${ir.kind}.`;
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
