import { randomUUID } from "node:crypto";

import { isCardTrackingMode, type CardTrackingMode } from "./card-tracking.ts";
import { WealthDatabase } from "./database.ts";
import { WealthError } from "./errors.ts";
import { formatDecimalAmount, normalizeCurrency, parseDecimalAmount } from "./money.ts";
import type {
	Account,
	AccountType,
	AssetKind,
	AssetValuation,
	CardPaymentResult,
	CardReminder,
	CardStatement,
	CardStatementStatus,
	CreateAccountInput,
	Household,
	LedgerTransaction,
	LightweightCardPayment,
	ListCardRemindersInput,
	NetWorthCurrencySummary,
	NetWorthItem,
	NetWorthReport,
	PostedTransaction,
	Posting,
	RecordCardPaymentInput,
	RecordCardStatementInput,
	RecordAssetValuationInput,
	RecordExpenseInput,
	RecordIncomeInput,
	RecordTransactionBookkeepingInput,
	RecordedCardStatement,
	RecordedAssetValuation,
	RegisterAssetInput,
	RegisteredAsset,
	RecordTransferInput,
	ReverseTransactionInput,
	SpendingCategorySummary,
	SpendingSummary,
	TrackedAsset,
	TransactionBookkeepingMetadata,
	TransactionCustomFieldValue,
	TransactionSource,
} from "./types.ts";

export interface WealthServiceOptions {
	householdId?: string;
	householdName?: string;
	baseCurrency?: string;
	cardTrackingMode?: CardTrackingMode;
}

interface AccountRow {
	id: string;
	household_id: string;
	name: string;
	type: AccountType;
	subtype: string | null;
	currency: string;
	owner_name: string | null;
	created_at: string;
	balance_minor: number;
}

interface TransactionRow {
	id: string;
	household_id: string;
	description: string;
	currency: string;
	occurred_at: string;
	source: TransactionSource;
	idempotency_key: string | null;
	reversal_of: string | null;
	created_at: string;
}

interface PostingRow {
	id: string;
	transaction_id: string;
	account_id: string;
	account_name: string;
	amount_minor: number;
	memo: string | null;
}

interface CardStatementRow {
	id: string;
	card_account_id: string;
	card_account_name: string;
	period_start: string;
	period_end: string;
	statement_date: string;
	due_date: string;
	currency: string;
	statement_amount_minor: number;
	minimum_payment_minor: number;
	accounting_mode: CardTrackingMode;
	created_at: string;
	paid_amount_minor: number;
}

interface StandaloneStatementPaymentRow {
	id: string;
	household_id: string;
	statement_id: string;
	funding_account_id: string | null;
	amount_minor: number;
	occurred_at: string;
	idempotency_key: string | null;
	created_at: string;
}

interface TrackedAssetRow {
	id: string;
	account_id: string;
	account_name: string;
	kind: AssetKind;
	currency: string;
	freshness_days: number;
	created_at: string;
}

interface AssetValuationRow {
	id: string;
	asset_id: string;
	valued_at: string;
	currency: string;
	amount_minor: number;
	note: string | null;
	created_at: string;
}

interface SpendingRow {
	account_id: string;
	account_name: string;
	currency: string;
	amount_minor: number;
}

interface InternalPosting {
	accountId: string;
	amountMinor: number;
	memo?: string;
}

interface InternalTransactionInput {
	description: string;
	currency: string;
	occurredAt: string;
	source: TransactionSource;
	idempotencyKey?: string | undefined;
	reversalOf?: string | undefined;
	postings: InternalPosting[];
	bookkeeping?: RecordTransactionBookkeepingInput;
}

interface TransactionBookkeepingRow {
	profile_revision: number;
	profile_hash: string;
	category_id: string | null;
	category_label: string | null;
	categorization_rule_id: string | null;
	custom_fields_json: string;
	resolution_source: TransactionBookkeepingMetadata["resolutionSource"];
	created_at: string;
}

const ACCOUNT_TYPES = new Set<AccountType>(["asset", "liability", "income", "expense", "equity"]);
const ASSET_KINDS = new Set<AssetKind>(["property", "investment", "vehicle", "collectible", "business", "other"]);

export class WealthService {
	readonly household: Household;
	private readonly database: WealthDatabase;
	private cardTrackingMode: CardTrackingMode;

	constructor(database: WealthDatabase, options: WealthServiceOptions = {}) {
		this.database = database;
		const cardTrackingMode = options.cardTrackingMode ?? "lightweight";
		if (!isCardTrackingMode(cardTrackingMode)) {
			throw new Error(`Unsupported card tracking mode "${String(cardTrackingMode)}".`);
		}
		this.cardTrackingMode = cardTrackingMode;
		this.household = this.loadOrCreateHousehold(options);
	}

	getCardTrackingMode(): CardTrackingMode {
		return this.cardTrackingMode;
	}

	setCardTrackingMode(mode: CardTrackingMode): void {
		if (!isCardTrackingMode(mode)) {
			throw new Error(`Unsupported card tracking mode "${String(mode)}".`);
		}
		this.cardTrackingMode = mode;
	}

	createAccount(input: CreateAccountInput): Account {
		const name = input.name.trim();
		if (!name) throw new WealthError("invalid_account", "Account name is required.");
		if (!ACCOUNT_TYPES.has(input.type)) {
			throw new WealthError("invalid_account", `Unsupported account type "${input.type}".`);
		}

		const currency = normalizeCurrency(input.currency ?? this.household.baseCurrency);
		const subtype = cleanOptionalText(input.subtype);
		const openingBalanceMinor = input.openingBalance
			? parseDecimalAmount(input.openingBalance, currency)
			: 0;
		if (openingBalanceMinor < 0) {
			throw new WealthError("invalid_amount", "Opening balance must not be negative.");
		}
		if (openingBalanceMinor !== 0 && !["asset", "liability"].includes(input.type)) {
			throw new WealthError("invalid_account", "Only asset and liability accounts can have an opening balance.");
		}
		if (
			openingBalanceMinor !== 0 &&
			subtype === "credit_card" &&
			this.cardTrackingMode === "lightweight"
		) {
			throw new WealthError(
				"invalid_account",
				"Credit card opening balances require integrated card tracking mode.",
			);
		}

		const accountId = randomUUID();
		const now = new Date().toISOString();
		this.database.transaction(() => {
			try {
				this.database.connection
					.prepare(
						`INSERT INTO accounts
							(id, household_id, name, type, subtype, currency, owner_name, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						accountId,
						this.household.id,
						name,
						input.type,
						subtype ?? null,
						currency,
						cleanOptionalText(input.ownerName) ?? null,
						now,
					);
			} catch (error) {
				if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
					throw new WealthError("duplicate", `An account named "${name}" already exists.`);
				}
				throw error;
			}

			if (openingBalanceMinor !== 0) {
				const equityAccount = this.getOrCreateOpeningBalanceAccount(currency, now);
				const accountAmount = input.type === "asset" ? openingBalanceMinor : -openingBalanceMinor;
				this.postTransactionWithin({
					description: `Opening balance for ${name}`,
					currency,
					occurredAt: now,
					source: "system",
					idempotencyKey: `opening:${accountId}`,
					postings: [
						{ accountId, amountMinor: accountAmount },
						{ accountId: equityAccount.id, amountMinor: -accountAmount },
					],
				});
			}
		});

		return this.getAccount(accountId);
	}

	getAccount(accountId: string): Account {
		const row = this.database.connection
			.prepare(
				`SELECT a.id, a.household_id, a.name, a.type, a.subtype, a.currency,
					a.owner_name, a.created_at, COALESCE(SUM(p.amount_minor), 0) AS balance_minor
				 FROM accounts AS a
				 LEFT JOIN postings AS p ON p.account_id = a.id
				 WHERE a.id = ? AND a.household_id = ? AND a.closed_at IS NULL
				 GROUP BY a.id`,
			)
			.get(accountId, this.household.id) as unknown as AccountRow | undefined;
		if (!row) throw new WealthError("account_not_found", `Account "${accountId}" was not found.`);
		return mapAccount(row);
	}

	findAccountByName(name: string): Account | undefined {
		const row = this.database.connection
			.prepare(
				`SELECT a.id, a.household_id, a.name, a.type, a.subtype, a.currency,
					a.owner_name, a.created_at, COALESCE(SUM(p.amount_minor), 0) AS balance_minor
				 FROM accounts AS a
				 LEFT JOIN postings AS p ON p.account_id = a.id
				 WHERE a.household_id = ? AND a.name = ? COLLATE NOCASE AND a.closed_at IS NULL
				 GROUP BY a.id`,
			)
			.get(this.household.id, name.trim()) as unknown as AccountRow | undefined;
		return row ? mapAccount(row) : undefined;
	}

	listAccounts(): Account[] {
		const rows = this.database.connection
			.prepare(
				`SELECT a.id, a.household_id, a.name, a.type, a.subtype, a.currency,
					a.owner_name, a.created_at, COALESCE(SUM(p.amount_minor), 0) AS balance_minor
				 FROM accounts AS a
				 LEFT JOIN postings AS p ON p.account_id = a.id
				 WHERE a.household_id = ? AND a.closed_at IS NULL
				 GROUP BY a.id
				 ORDER BY a.type, a.name COLLATE NOCASE`,
			)
			.all(this.household.id) as unknown as AccountRow[];
		return rows.map(mapAccount);
	}

	recordExpense(
		input: RecordExpenseInput,
		bookkeeping?: RecordTransactionBookkeepingInput,
	): PostedTransaction {
		const duplicate = this.resolveLedgerIdempotency(input.idempotencyKey);
		if (duplicate) return duplicate;

		const expense = this.getAccount(input.expenseAccountId);
		const funding = this.getAccount(input.fundingAccountId);
		this.requireAccountType(expense, ["expense"], "Expense destination");
		this.requireAccountType(funding, ["asset", "liability"], "Expense funding");
		if (this.cardTrackingMode === "lightweight" && funding.subtype === "credit_card") {
			throw new WealthError(
				"invalid_transaction",
				"Credit card expenses require integrated card tracking mode.",
			);
		}
		this.requireSameCurrency(expense, funding);
		const amountMinor = this.requirePositiveAmount(input.amount, expense.currency);

		return this.postTransaction({
			description: requireDescription(input.description),
			currency: expense.currency,
			occurredAt: normalizeTimestamp(input.occurredAt),
			source: "agent",
			idempotencyKey: cleanOptionalText(input.idempotencyKey),
			postings: [
				{ accountId: expense.id, amountMinor },
				{ accountId: funding.id, amountMinor: -amountMinor },
			],
			...(bookkeeping ? { bookkeeping } : {}),
		});
	}

	recordIncome(
		input: RecordIncomeInput,
		bookkeeping?: RecordTransactionBookkeepingInput,
	): PostedTransaction {
		const duplicate = this.resolveLedgerIdempotency(input.idempotencyKey);
		if (duplicate) return duplicate;

		const income = this.getAccount(input.incomeAccountId);
		const destination = this.getAccount(input.destinationAccountId);
		this.requireAccountType(income, ["income"], "Income source");
		this.requireAccountType(destination, ["asset"], "Income destination");
		this.requireSameCurrency(income, destination);
		const amountMinor = this.requirePositiveAmount(input.amount, income.currency);

		return this.postTransaction({
			description: requireDescription(input.description),
			currency: income.currency,
			occurredAt: normalizeTimestamp(input.occurredAt),
			source: "agent",
			idempotencyKey: cleanOptionalText(input.idempotencyKey),
			postings: [
				{ accountId: destination.id, amountMinor },
				{ accountId: income.id, amountMinor: -amountMinor },
			],
			...(bookkeeping ? { bookkeeping } : {}),
		});
	}

	findLedgerTransactionByIdempotencyKey(idempotencyKey: string | undefined): PostedTransaction | undefined {
		return this.resolveLedgerIdempotency(idempotencyKey);
	}

	recordTransfer(input: RecordTransferInput): PostedTransaction {
		const duplicate = this.resolveLedgerIdempotency(input.idempotencyKey);
		if (duplicate) return duplicate;

		const source = this.getAccount(input.fromAccountId);
		const destination = this.getAccount(input.toAccountId);
		if (source.subtype === "credit_card" || destination.subtype === "credit_card") {
			throw new WealthError(
				"invalid_transaction",
				"Credit card payments must be recorded with recordCardPayment.",
			);
		}
		if (source.id === destination.id) {
			throw new WealthError("invalid_transaction", "Transfer accounts must be different.");
		}
		this.requireAccountType(source, ["asset", "liability"], "Transfer source");
		this.requireAccountType(destination, ["asset", "liability"], "Transfer destination");
		this.requireSameCurrency(source, destination);
		const amountMinor = this.requirePositiveAmount(input.amount, source.currency);

		return this.postTransaction({
			description: requireDescription(input.description),
			currency: source.currency,
			occurredAt: normalizeTimestamp(input.occurredAt),
			source: "agent",
			idempotencyKey: cleanOptionalText(input.idempotencyKey),
			postings: [
				{ accountId: source.id, amountMinor: -amountMinor },
				{ accountId: destination.id, amountMinor },
			],
		});
	}

	reverseTransaction(input: ReverseTransactionInput): PostedTransaction {
		return this.database.transaction(() => {
			const original = this.getTransaction(input.transactionId);
			const allocatedPayment = this.database.connection
				.prepare("SELECT id FROM statement_payments WHERE transaction_id = ?")
				.get(original.id) as { id: string } | undefined;
			if (allocatedPayment) {
				throw new WealthError(
					"invalid_transaction",
					"A statement payment cannot be reversed without also reversing its statement allocation.",
				);
			}
			const existingReversal = this.database.connection
				.prepare("SELECT id FROM transactions WHERE reversal_of = ?")
				.get(original.id) as { id: string } | undefined;
			if (existingReversal) {
				throw new WealthError("invalid_transaction", `Transaction "${original.id}" is already reversed.`);
			}

			return this.postTransactionWithin({
				description: input.description?.trim() || `Reversal: ${original.description}`,
				currency: original.currency,
				occurredAt: normalizeTimestamp(input.occurredAt),
				source: "agent",
				idempotencyKey: cleanOptionalText(input.idempotencyKey),
				reversalOf: original.id,
				postings: original.postings.map((posting) => ({
					accountId: posting.accountId,
					amountMinor: -posting.amountMinor,
					memo: `Reverses ${posting.id}`,
				})),
				...(original.bookkeeping
					? {
							bookkeeping: {
								profileRevision: original.bookkeeping.profileRevision,
								profileHash: original.bookkeeping.profileHash,
								...(original.bookkeeping.categoryId
									? {
											categoryId: original.bookkeeping.categoryId,
											categoryLabel: original.bookkeeping.categoryLabel,
										}
									: {}),
								...(original.bookkeeping.categorizationRuleId
									? { categorizationRuleId: original.bookkeeping.categorizationRuleId }
									: {}),
								customFields: original.bookkeeping.customFields,
								resolutionSource: "reversal",
							},
						}
					: {}),
			});
		});
	}

	getTransaction(transactionId: string): LedgerTransaction {
		const row = this.database.connection
			.prepare("SELECT * FROM transactions WHERE id = ? AND household_id = ?")
			.get(transactionId, this.household.id) as unknown as TransactionRow | undefined;
		if (!row) {
			throw new WealthError("transaction_not_found", `Transaction "${transactionId}" was not found.`);
		}
		return this.mapTransaction(row);
	}

	listTransactions(limit = 20): LedgerTransaction[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
			throw new WealthError("invalid_transaction", "Transaction limit must be an integer from 1 to 200.");
		}
		const rows = this.database.connection
			.prepare(
				`SELECT * FROM transactions
				 WHERE household_id = ?
				 ORDER BY occurred_at DESC, created_at DESC
				 LIMIT ?`,
			)
			.all(this.household.id, limit) as unknown as TransactionRow[];
		return rows.map((row) => this.mapTransaction(row));
	}

	listTransactionsInRange(from: string, to: string): LedgerTransaction[] {
		const fromDate = normalizeDate(from);
		const toDate = normalizeDate(to);
		if (fromDate > toDate) {
			throw new WealthError("invalid_date", "Transaction range start must not follow its end.");
		}
		const rows = this.database.connection
			.prepare(
				`SELECT * FROM transactions
				 WHERE household_id = ? AND occurred_at >= ? AND occurred_at < ?
				 ORDER BY occurred_at, created_at, rowid`,
			)
			.all(
				this.household.id,
				`${fromDate}T00:00:00.000Z`,
				`${addDays(toDate, 1)}T00:00:00.000Z`,
			) as unknown as TransactionRow[];
		return rows.map((row) => this.mapTransaction(row));
	}

	recordCardStatement(input: RecordCardStatementInput): RecordedCardStatement {
		const card = this.getAccount(input.cardAccountId);
		this.requireAccountType(card, ["liability"], "Credit card");
		if (card.subtype !== "credit_card") {
			throw new WealthError("invalid_account", `Account "${card.name}" is not marked as a credit card.`);
		}

		const periodStart = normalizeDate(input.periodStart);
		const periodEnd = normalizeDate(input.periodEnd);
		const statementDate = normalizeDate(input.statementDate);
		const dueDate = normalizeDate(input.dueDate);
		if (periodStart > periodEnd || periodEnd > statementDate || statementDate > dueDate) {
			throw new WealthError(
				"invalid_card_statement",
				"Statement dates must satisfy period start <= period end <= statement date <= due date.",
			);
		}

		const statementAmountMinor = this.requirePositiveAmount(input.statementAmount, card.currency);
		const minimumPaymentMinor = input.minimumPayment
			? parseDecimalAmount(input.minimumPayment, card.currency)
			: 0;
		if (minimumPaymentMinor < 0 || minimumPaymentMinor > statementAmountMinor) {
			throw new WealthError(
				"invalid_card_statement",
				"Minimum payment must be between zero and the statement amount.",
			);
		}

		const existing = this.database.connection
			.prepare("SELECT id FROM credit_card_statements WHERE card_account_id = ? AND statement_date = ?")
			.get(card.id, statementDate) as { id: string } | undefined;
		if (existing) {
			const statement = this.getCardStatement(existing.id);
			const unchanged =
				statement.periodStart === periodStart &&
				statement.periodEnd === periodEnd &&
				statement.dueDate === dueDate &&
				statement.statementAmountMinor === statementAmountMinor &&
				statement.minimumPaymentMinor === minimumPaymentMinor;
			if (!unchanged) {
				throw new WealthError(
					"duplicate",
					`A different statement already exists for "${card.name}" on ${statementDate}.`,
				);
			}
			return { statement, duplicate: true };
		}

		const id = randomUUID();
		const createdAt = new Date().toISOString();
		this.database.connection
			.prepare(
				`INSERT INTO credit_card_statements
					(id, card_account_id, period_start, period_end, statement_date, due_date,
					 currency, statement_amount_minor, minimum_payment_minor, accounting_mode, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				card.id,
				periodStart,
				periodEnd,
				statementDate,
				dueDate,
				card.currency,
				statementAmountMinor,
				minimumPaymentMinor,
				this.cardTrackingMode,
				createdAt,
			);

		return { statement: this.getCardStatement(id), duplicate: false };
	}

	getCardStatement(statementId: string, asOf?: string): CardStatement {
		const date = normalizeDate(asOf ?? currentDate());
		const row = this.getCardStatementRow(statementId, date);
		if (!row) {
			throw new WealthError("card_statement_not_found", `Card statement "${statementId}" was not found.`);
		}
		return mapCardStatement(row, date);
	}

	listCardStatements(asOf?: string): CardStatement[] {
		const date = normalizeDate(asOf ?? currentDate());
		const rows = this.database.connection
			.prepare(cardStatementQuery("WHERE a.household_id = ?", "ORDER BY s.due_date, s.id"))
			.all(paymentCutoff(date), paymentCutoff(date), this.household.id) as unknown as CardStatementRow[];
		return rows.map((row) => mapCardStatement(row, date));
	}

	recordCardPayment(input: RecordCardPaymentInput): CardPaymentResult {
		return this.database.transaction(() => {
			const occurredAt = normalizeTimestamp(input.occurredAt);
			const statement = this.getCardStatement(input.statementId, occurredAt.slice(0, 10));
			const amountMinor = this.requirePositiveAmount(input.amount, statement.currency);
			const idempotencyKey = cleanOptionalText(input.idempotencyKey);
			const fundingAccountId = cleanOptionalText(input.fundingAccountId);

			if (statement.accountingMode === "lightweight") {
				const funding = fundingAccountId ? this.getAccount(fundingAccountId) : undefined;
				if (funding) {
					this.requireAccountType(funding, ["asset"], "Card payment funding");
					if (funding.currency !== statement.currency) {
						throw new WealthError(
							"currency_mismatch",
							`Account "${funding.name}" uses ${funding.currency}, not ${statement.currency}.`,
						);
					}
				}

				if (idempotencyKey) {
					const existing = this.database.connection
						.prepare(
							"SELECT * FROM standalone_statement_payments WHERE household_id = ? AND idempotency_key = ?",
						)
						.get(this.household.id, idempotencyKey) as unknown as
						| StandaloneStatementPaymentRow
						| undefined;
					if (existing) {
						if (
							existing.statement_id !== statement.id ||
							existing.amount_minor !== amountMinor ||
							existing.funding_account_id !== (funding?.id ?? null)
						) {
							throw new WealthError("duplicate", "Idempotency key belongs to a different card payment.");
						}
						return {
							payment: mapStandaloneStatementPayment(existing, statement.currency, true),
							statement: this.getCardStatement(statement.id, occurredAt.slice(0, 10)),
						};
					}
					const ledgerCollision = this.database.connection
						.prepare("SELECT 1 FROM transactions WHERE household_id = ? AND idempotency_key = ?")
						.get(this.household.id, idempotencyKey);
					if (ledgerCollision) {
						throw new WealthError("duplicate", "Idempotency key belongs to a different operation.");
					}
				}

				this.requirePaymentWithinStatementBalance(amountMinor, statement);

				const row: StandaloneStatementPaymentRow = {
					id: randomUUID(),
					household_id: this.household.id,
					statement_id: statement.id,
					funding_account_id: funding?.id ?? null,
					amount_minor: amountMinor,
					occurred_at: occurredAt,
					idempotency_key: idempotencyKey ?? null,
					created_at: new Date().toISOString(),
				};
				this.database.connection
					.prepare(
						`INSERT INTO standalone_statement_payments
							(id, household_id, statement_id, funding_account_id, amount_minor,
							 occurred_at, idempotency_key, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						row.id,
						row.household_id,
						row.statement_id,
						row.funding_account_id,
						row.amount_minor,
						row.occurred_at,
						row.idempotency_key,
						row.created_at,
					);

				return {
					payment: mapStandaloneStatementPayment(row, statement.currency, false),
					statement: this.getCardStatement(statement.id, occurredAt.slice(0, 10)),
				};
			}

			if (!fundingAccountId) {
				throw new WealthError("invalid_account", "Integrated card payments require a funding account.");
			}
			const funding = this.getAccount(fundingAccountId);
			const card = this.getAccount(statement.cardAccountId);
			this.requireAccountType(funding, ["asset"], "Card payment funding");
			this.requireSameCurrency(funding, card);

			if (idempotencyKey) {
				const existing = this.database.connection
					.prepare("SELECT id FROM transactions WHERE household_id = ? AND idempotency_key = ?")
					.get(this.household.id, idempotencyKey) as { id: string } | undefined;
				if (existing) {
					const allocation = this.database.connection
						.prepare(
							"SELECT amount_minor FROM statement_payments WHERE statement_id = ? AND transaction_id = ?",
						)
						.get(statement.id, existing.id) as { amount_minor: number } | undefined;
					const transaction = this.getTransaction(existing.id);
					const matchesFunding = transaction.postings.some(
						(posting) => posting.accountId === funding.id && posting.amountMinor === -amountMinor,
					);
					if (!allocation || allocation.amount_minor !== amountMinor || !matchesFunding) {
						throw new WealthError("duplicate", "Idempotency key belongs to a different card payment.");
					}
					return {
						payment: { accountingMode: "integrated", transaction, duplicate: true },
						statement: this.getCardStatement(statement.id, occurredAt.slice(0, 10)),
					};
				}
				const standaloneCollision = this.database.connection
					.prepare(
						"SELECT 1 FROM standalone_statement_payments WHERE household_id = ? AND idempotency_key = ?",
					)
					.get(this.household.id, idempotencyKey);
				if (standaloneCollision) {
					throw new WealthError("duplicate", "Idempotency key belongs to a different operation.");
				}
			}

			this.requirePaymentWithinStatementBalance(amountMinor, statement);
			const maximumCardBalance = this.getMaximumAccountBalanceFromTimestamp(card.id, occurredAt);
			const ledgerLiabilityMinor = maximumCardBalance < 0 ? -maximumCardBalance : 0;
			if (amountMinor > ledgerLiabilityMinor) {
				throw new WealthError(
					"invalid_amount",
					`Payment ${formatDecimalAmount(amountMinor, statement.currency)} exceeds current card liability ${formatDecimalAmount(ledgerLiabilityMinor, statement.currency)}.`,
				);
			}

			const posted = this.postTransactionWithin({
				description: `Payment for ${statement.cardAccountName} statement ${statement.statementDate}`,
				currency: statement.currency,
				occurredAt,
				source: "agent",
				idempotencyKey,
				postings: [
					{ accountId: funding.id, amountMinor: -amountMinor },
					{ accountId: card.id, amountMinor },
				],
			});
			this.database.connection
				.prepare(
					`INSERT INTO statement_payments
						(id, statement_id, transaction_id, amount_minor, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(randomUUID(), statement.id, posted.transaction.id, amountMinor, new Date().toISOString());

			return {
				payment: { accountingMode: "integrated", ...posted },
				statement: this.getCardStatement(statement.id, occurredAt.slice(0, 10)),
			};
		});
	}

	listCardReminders(input: ListCardRemindersInput = {}): CardReminder[] {
		const asOf = normalizeDate(input.asOf ?? currentDate());
		const windowDays = input.windowDays ?? 7;
		if (!Number.isSafeInteger(windowDays) || windowDays < 0 || windowDays > 90) {
			throw new WealthError("invalid_card_statement", "Reminder window must be an integer from 0 to 90 days.");
		}

		return this.listCardStatements(asOf)
			.filter(
				(statement): statement is CardStatement & { status: "due_soon" | "due_today" | "overdue" } =>
					statement.status === "overdue" ||
					statement.status === "due_today" ||
					(statement.status === "due_soon" && statement.daysUntilDue <= windowDays),
			)
			.map((statement) => ({
				statementId: statement.id,
				cardAccountId: statement.cardAccountId,
				cardAccountName: statement.cardAccountName,
				dueDate: statement.dueDate,
				daysUntilDue: statement.daysUntilDue,
				status: statement.status,
				currency: statement.currency,
				outstandingAmountMinor: statement.outstandingAmountMinor,
				outstandingAmount: statement.outstandingAmount,
			}));
	}

	registerAsset(input: RegisterAssetInput): RegisteredAsset {
		const account = this.getAccount(input.accountId);
		this.requireAccountType(account, ["asset"], "Tracked asset");
		if (!ASSET_KINDS.has(input.kind)) {
			throw new WealthError("invalid_asset", `Unsupported asset kind "${input.kind}".`);
		}
		const freshnessDays = input.freshnessDays ?? 30;
		if (!Number.isSafeInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 3650) {
			throw new WealthError("invalid_asset", "Asset freshness must be an integer from 1 to 3650 days.");
		}

		const existing = this.getTrackedAssetByAccount(account.id);
		if (existing) {
			this.database.connection
				.prepare("UPDATE tracked_assets SET kind = ?, freshness_days = ? WHERE id = ?")
				.run(input.kind, freshnessDays, existing.id);
			return { asset: this.getTrackedAsset(existing.id), created: false };
		}

		const id = randomUUID();
		this.database.connection
			.prepare(
				"INSERT INTO tracked_assets (id, account_id, kind, freshness_days, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, account.id, input.kind, freshnessDays, new Date().toISOString());
		return { asset: this.getTrackedAsset(id), created: true };
	}

	getTrackedAsset(assetId: string): TrackedAsset {
		const row = this.database.connection
			.prepare(trackedAssetQuery("WHERE ta.id = ? AND a.household_id = ?"))
			.get(assetId, this.household.id) as unknown as TrackedAssetRow | undefined;
		if (!row) throw new WealthError("asset_not_found", `Tracked asset "${assetId}" was not found.`);
		return mapTrackedAsset(row);
	}

	recordAssetValuation(input: RecordAssetValuationInput): RecordedAssetValuation {
		const asset = this.getTrackedAsset(input.assetId);
		const valuedAt = normalizeDate(input.valuedAt);
		const amountMinor = parseDecimalAmount(input.amount, asset.currency);
		if (amountMinor < 0) throw new WealthError("invalid_amount", "Asset valuation must not be negative.");
		const note = cleanOptionalText(input.note);

		const existing = this.database.connection
			.prepare("SELECT * FROM asset_valuations WHERE asset_id = ? AND valued_at = ?")
			.get(asset.id, valuedAt) as unknown as AssetValuationRow | undefined;
		if (existing) {
			if (existing.amount_minor !== amountMinor || (existing.note ?? undefined) !== note) {
				throw new WealthError(
					"duplicate",
					`A different valuation already exists for "${asset.accountName}" on ${valuedAt}.`,
				);
			}
			return { valuation: mapAssetValuation(existing), duplicate: true };
		}

		const id = randomUUID();
		this.database.connection
			.prepare(
				`INSERT INTO asset_valuations
					(id, asset_id, valued_at, currency, amount_minor, note, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, asset.id, valuedAt, asset.currency, amountMinor, note ?? null, new Date().toISOString());
		return { valuation: this.getAssetValuation(id), duplicate: false };
	}

	getNetWorth(asOf = currentDate()): NetWorthReport {
		const date = normalizeDate(asOf);
		const warnings: string[] = [];
		const summaries = new Map<string, { assetsMinor: number; liabilitiesMinor: number; items: NetWorthItem[] }>();

		for (const account of this.listAccounts().filter((candidate) => ["asset", "liability"].includes(candidate.type))) {
			const summary = summaries.get(account.currency) ?? { assetsMinor: 0, liabilitiesMinor: 0, items: [] };
			const ledgerBalance = this.getAccountBalanceAt(account.id, date);
			if (account.type === "liability") {
				const amountMinor = -ledgerBalance;
				summary.liabilitiesMinor = safeAdd(summary.liabilitiesMinor, amountMinor);
				summary.items.push({
					accountId: account.id,
					accountName: account.name,
					type: "liability",
					currency: account.currency,
					amountMinor,
					amount: formatDecimalAmount(amountMinor, account.currency),
					source: "ledger",
				});
			} else {
				const trackedAsset = this.getTrackedAssetByAccount(account.id);
				const valuation = trackedAsset ? this.getLatestAssetValuation(trackedAsset.id, date) : undefined;
				const amountMinor = valuation?.amountMinor ?? ledgerBalance;
				summary.assetsMinor = safeAdd(summary.assetsMinor, amountMinor);
				summary.items.push({
					accountId: account.id,
					accountName: account.name,
					type: "asset",
					currency: account.currency,
					amountMinor,
					amount: formatDecimalAmount(amountMinor, account.currency),
					source: valuation ? "valuation" : "ledger",
					...(valuation ? { valuationDate: valuation.valuedAt } : {}),
				});

				if (trackedAsset && !valuation) {
					warnings.push(`No valuation is available for ${account.name} on or before ${date}; using ledger value.`);
				} else if (trackedAsset && valuation) {
					const ageDays = daysBetween(valuation.valuedAt, date);
					if (ageDays > trackedAsset.freshnessDays) {
						warnings.push(
							`Valuation for ${account.name} is ${ageDays} days old; freshness limit is ${trackedAsset.freshnessDays} days.`,
						);
					}
				}
			}
			summaries.set(account.currency, summary);
		}

		const totals: NetWorthCurrencySummary[] = [...summaries.entries()]
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([currency, summary]) => {
				const netWorthMinor = safeAdd(summary.assetsMinor, -summary.liabilitiesMinor);
				return {
					currency,
					assetsMinor: summary.assetsMinor,
					assets: formatDecimalAmount(summary.assetsMinor, currency),
					liabilitiesMinor: summary.liabilitiesMinor,
					liabilities: formatDecimalAmount(summary.liabilitiesMinor, currency),
					netWorthMinor,
					netWorth: formatDecimalAmount(netWorthMinor, currency),
					items: summary.items,
				};
			});

		return { asOf: date, totals, warnings };
	}

	getSpendingSummary(from: string, to: string): SpendingSummary {
		const fromDate = normalizeDate(from);
		const toDate = normalizeDate(to);
		if (fromDate > toDate) throw new WealthError("invalid_date", "Spending range start must not follow its end.");

		const rows = this.database.connection
			.prepare(
				`SELECT a.id AS account_id, a.name AS account_name, a.currency,
					COALESCE(SUM(p.amount_minor), 0) AS amount_minor
				 FROM postings AS p
				 JOIN accounts AS a ON a.id = p.account_id
				 JOIN transactions AS t ON t.id = p.transaction_id
				 WHERE a.household_id = ? AND a.type = 'expense'
					AND t.occurred_at >= ? AND t.occurred_at < ?
				 GROUP BY a.id
				 ORDER BY a.currency, amount_minor DESC, a.name COLLATE NOCASE`,
			)
			.all(this.household.id, `${fromDate}T00:00:00.000Z`, `${addDays(toDate, 1)}T00:00:00.000Z`) as unknown as SpendingRow[];

		const categories: SpendingCategorySummary[] = rows.map((row) => ({
			accountId: row.account_id,
			accountName: row.account_name,
			currency: row.currency,
			amountMinor: row.amount_minor,
			amount: formatDecimalAmount(row.amount_minor, row.currency),
		}));
		const totalsByCurrency = new Map<string, number>();
		for (const category of categories) {
			totalsByCurrency.set(
				category.currency,
				safeAdd(totalsByCurrency.get(category.currency) ?? 0, category.amountMinor),
			);
		}

		return {
			from: fromDate,
			to: toDate,
			totals: [...totalsByCurrency.entries()].map(([currency, amountMinor]) => ({
				currency,
				amountMinor,
				amount: formatDecimalAmount(amountMinor, currency),
			})),
			categories,
		};
	}

	private loadOrCreateHousehold(options: WealthServiceOptions): Household {
		if (options.householdId) {
			const existing = this.database.connection
				.prepare("SELECT * FROM households WHERE id = ?")
				.get(options.householdId) as
				| { id: string; name: string; base_currency: string; created_at: string }
				| undefined;
			if (!existing) throw new Error(`Household "${options.householdId}" was not found.`);
			return mapHousehold(existing);
		}

		const first = this.database.connection
			.prepare("SELECT * FROM households ORDER BY created_at, id LIMIT 1")
			.get() as { id: string; name: string; base_currency: string; created_at: string } | undefined;
		if (first) return mapHousehold(first);

		const household: Household = {
			id: randomUUID(),
			name: options.householdName?.trim() || "My Household",
			baseCurrency: normalizeCurrency(options.baseCurrency ?? "HKD"),
			createdAt: new Date().toISOString(),
		};
		this.database.connection
			.prepare("INSERT INTO households (id, name, base_currency, created_at) VALUES (?, ?, ?, ?)")
			.run(household.id, household.name, household.baseCurrency, household.createdAt);
		return household;
	}

	private getOrCreateOpeningBalanceAccount(currency: string, createdAt: string): Account {
		const subtype = `opening_balance_${currency.toLowerCase()}`;
		const existing = this.database.connection
			.prepare(
				`SELECT a.id, a.household_id, a.name, a.type, a.subtype, a.currency,
					a.owner_name, a.created_at, COALESCE(SUM(p.amount_minor), 0) AS balance_minor
				 FROM accounts AS a
				 LEFT JOIN postings AS p ON p.account_id = a.id
				 WHERE a.household_id = ? AND a.type = 'equity' AND a.subtype = ?
				 GROUP BY a.id`,
			)
			.get(this.household.id, subtype) as unknown as AccountRow | undefined;
		if (existing) return mapAccount(existing);

		const id = randomUUID();
		this.database.connection
			.prepare(
				`INSERT INTO accounts
					(id, household_id, name, type, subtype, currency, created_at)
				 VALUES (?, ?, ?, 'equity', ?, ?, ?)`,
			)
			.run(id, this.household.id, `Opening Balances (${currency})`, subtype, currency, createdAt);
		return this.getAccount(id);
	}

	private postTransaction(input: InternalTransactionInput): PostedTransaction {
		return this.database.transaction(() => this.postTransactionWithin(input));
	}

	private postTransactionWithin(input: InternalTransactionInput): PostedTransaction {
		const duplicate = this.resolveLedgerIdempotency(input.idempotencyKey);
		if (duplicate) return duplicate;

		if (input.postings.length < 2) {
			throw new WealthError("invalid_transaction", "A transaction requires at least two postings.");
		}
		let total = 0;
		for (const posting of input.postings) {
			if (!Number.isSafeInteger(posting.amountMinor) || posting.amountMinor === 0) {
				throw new WealthError("invalid_amount", "Posting amounts must be non-zero safe integers.");
			}
			const account = this.getAccount(posting.accountId);
			if (account.currency !== input.currency) {
				throw new WealthError(
					"currency_mismatch",
					`Account "${account.name}" uses ${account.currency}, not ${input.currency}.`,
				);
			}
			total += posting.amountMinor;
		}
		if (!Number.isSafeInteger(total) || total !== 0) {
			throw new WealthError("invalid_transaction", "Transaction postings must balance to zero.");
		}
		const bookkeeping = input.bookkeeping ? normalizeTransactionBookkeeping(input.bookkeeping) : undefined;

		const transactionId = randomUUID();
		const createdAt = new Date().toISOString();
		this.database.connection
			.prepare(
				`INSERT INTO transactions
					(id, household_id, description, currency, occurred_at, source,
					 idempotency_key, reversal_of, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				transactionId,
				this.household.id,
				input.description,
				input.currency,
				input.occurredAt,
				input.source,
				input.idempotencyKey ?? null,
				input.reversalOf ?? null,
				createdAt,
			);

		const insertPosting = this.database.connection.prepare(
			"INSERT INTO postings (id, transaction_id, account_id, amount_minor, memo) VALUES (?, ?, ?, ?, ?)",
		);
		for (const posting of input.postings) {
			insertPosting.run(randomUUID(), transactionId, posting.accountId, posting.amountMinor, posting.memo ?? null);
		}
		if (bookkeeping) {
			this.database.connection
				.prepare(
					`INSERT INTO transaction_bookkeeping
						(transaction_id, profile_revision, profile_hash, category_id, category_label,
						 categorization_rule_id, custom_fields_json, resolution_source, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					transactionId,
					bookkeeping.profileRevision,
					bookkeeping.profileHash,
					bookkeeping.categoryId ?? null,
					bookkeeping.categoryLabel ?? null,
					bookkeeping.categorizationRuleId ?? null,
					JSON.stringify(bookkeeping.customFields),
					bookkeeping.resolutionSource,
					createdAt,
				);
		}

		return { transaction: this.getTransaction(transactionId), duplicate: false };
	}

	private resolveLedgerIdempotency(idempotencyKey: string | undefined): PostedTransaction | undefined {
		const key = cleanOptionalText(idempotencyKey);
		if (!key) return undefined;

		const standaloneCollision = this.database.connection
			.prepare(
				"SELECT 1 FROM standalone_statement_payments WHERE household_id = ? AND idempotency_key = ?",
			)
			.get(this.household.id, key);
		if (standaloneCollision) {
			throw new WealthError("duplicate", "Idempotency key belongs to a standalone card payment.");
		}

		const existing = this.database.connection
			.prepare("SELECT id FROM transactions WHERE household_id = ? AND idempotency_key = ?")
			.get(this.household.id, key) as { id: string } | undefined;
		if (existing) return { transaction: this.getTransaction(existing.id), duplicate: true };
		return undefined;
	}

	private mapTransaction(row: TransactionRow): LedgerTransaction {
		const postingRows = this.database.connection
			.prepare(
				`SELECT p.id, p.transaction_id, p.account_id, a.name AS account_name,
					p.amount_minor, p.memo
				 FROM postings AS p
				 JOIN accounts AS a ON a.id = p.account_id
				 WHERE p.transaction_id = ?
				 ORDER BY p.rowid`,
			)
			.all(row.id) as unknown as PostingRow[];
		const postings: Posting[] = postingRows.map((posting) => ({
			id: posting.id,
			transactionId: posting.transaction_id,
			accountId: posting.account_id,
			accountName: posting.account_name,
			amountMinor: posting.amount_minor,
			amount: formatDecimalAmount(posting.amount_minor, row.currency),
			...(posting.memo ? { memo: posting.memo } : {}),
		}));
		const bookkeepingRow = this.database.connection
			.prepare("SELECT * FROM transaction_bookkeeping WHERE transaction_id = ?")
			.get(row.id) as unknown as TransactionBookkeepingRow | undefined;
		const bookkeeping = bookkeepingRow ? mapTransactionBookkeeping(bookkeepingRow) : undefined;
		return {
			id: row.id,
			householdId: row.household_id,
			description: row.description,
			currency: row.currency,
			occurredAt: row.occurred_at,
			source: row.source,
			createdAt: row.created_at,
			postings,
			...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
			...(row.reversal_of ? { reversalOf: row.reversal_of } : {}),
			...(bookkeeping ? { bookkeeping } : {}),
		};
	}

	private getCardStatementRow(statementId: string, asOf: string): CardStatementRow | undefined {
		return this.database.connection
			.prepare(cardStatementQuery("WHERE s.id = ? AND a.household_id = ?", ""))
			.get(paymentCutoff(asOf), paymentCutoff(asOf), statementId, this.household.id) as unknown as
			| CardStatementRow
			| undefined;
	}

	private getTrackedAssetByAccount(accountId: string): TrackedAsset | undefined {
		const row = this.database.connection
			.prepare(trackedAssetQuery("WHERE ta.account_id = ? AND a.household_id = ?"))
			.get(accountId, this.household.id) as unknown as TrackedAssetRow | undefined;
		return row ? mapTrackedAsset(row) : undefined;
	}

	private getAssetValuation(valuationId: string): AssetValuation {
		const row = this.database.connection
			.prepare(
				`SELECT av.* FROM asset_valuations AS av
				 JOIN tracked_assets AS ta ON ta.id = av.asset_id
				 JOIN accounts AS a ON a.id = ta.account_id
				 WHERE av.id = ? AND a.household_id = ?`,
			)
			.get(valuationId, this.household.id) as unknown as AssetValuationRow | undefined;
		if (!row) throw new WealthError("asset_not_found", `Asset valuation "${valuationId}" was not found.`);
		return mapAssetValuation(row);
	}

	private getLatestAssetValuation(assetId: string, asOf: string): AssetValuation | undefined {
		const row = this.database.connection
			.prepare(
				`SELECT * FROM asset_valuations
				 WHERE asset_id = ? AND valued_at <= ?
				 ORDER BY valued_at DESC, created_at DESC
				 LIMIT 1`,
			)
			.get(assetId, asOf) as unknown as AssetValuationRow | undefined;
		return row ? mapAssetValuation(row) : undefined;
	}

	private getAccountBalanceAt(accountId: string, asOf: string): number {
		const row = this.database.connection
			.prepare(
				`SELECT COALESCE(SUM(p.amount_minor), 0) AS balance_minor
				 FROM postings AS p
				 JOIN transactions AS t ON t.id = p.transaction_id
				 JOIN accounts AS a ON a.id = p.account_id
				 WHERE p.account_id = ? AND a.household_id = ? AND t.occurred_at < ?`,
			)
			.get(accountId, this.household.id, `${addDays(asOf, 1)}T00:00:00.000Z`) as { balance_minor: number };
		return row.balance_minor;
	}

	private getMaximumAccountBalanceFromTimestamp(accountId: string, occurredAt: string): number {
		const row = this.database.connection
			.prepare(
				`WITH account_deltas AS (
					SELECT t.occurred_at, SUM(p.amount_minor) AS amount_minor
					FROM postings AS p
					JOIN transactions AS t ON t.id = p.transaction_id
					JOIN accounts AS a ON a.id = p.account_id
					WHERE p.account_id = ? AND a.household_id = ?
					GROUP BY t.occurred_at
				), account_balances AS (
					SELECT occurred_at,
						SUM(amount_minor) OVER (ORDER BY occurred_at) AS balance_minor
					FROM account_deltas
				), relevant_balances AS (
					SELECT COALESCE((
						SELECT balance_minor
						FROM account_balances
						WHERE occurred_at <= ?
						ORDER BY occurred_at DESC
						LIMIT 1
					), 0) AS balance_minor
					UNION ALL
					SELECT balance_minor
					FROM account_balances
					WHERE occurred_at >= ?
				)
				SELECT COALESCE(MAX(balance_minor), 0) AS balance_minor
				FROM relevant_balances`,
			)
			.get(accountId, this.household.id, occurredAt, occurredAt) as { balance_minor: number };
		return row.balance_minor;
	}

	private requirePositiveAmount(amount: string, currency: string): number {
		const amountMinor = parseDecimalAmount(amount, currency);
		if (amountMinor <= 0) throw new WealthError("invalid_amount", "Amount must be greater than zero.");
		return amountMinor;
	}

	private requirePaymentWithinStatementBalance(amountMinor: number, statement: CardStatement): void {
		const paidAmountMinor =
			statement.accountingMode === "integrated"
				? (
						this.database.connection
							.prepare(
								"SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor FROM statement_payments WHERE statement_id = ?",
							)
							.get(statement.id) as { amount_minor: number }
					).amount_minor
				: (
						this.database.connection
							.prepare(
								"SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor FROM standalone_statement_payments WHERE statement_id = ?",
							)
							.get(statement.id) as { amount_minor: number }
					).amount_minor;
		const outstandingAmountMinor = statement.statementAmountMinor - paidAmountMinor;
		if (amountMinor > outstandingAmountMinor) {
			throw new WealthError(
				"invalid_amount",
				`Payment ${formatDecimalAmount(amountMinor, statement.currency)} exceeds outstanding amount ${formatDecimalAmount(outstandingAmountMinor, statement.currency)}.`,
			);
		}
	}

	private requireAccountType(account: Account, expected: AccountType[], role: string): void {
		if (!expected.includes(account.type)) {
			throw new WealthError(
				"invalid_account",
				`${role} account "${account.name}" must be ${expected.join(" or ")}, not ${account.type}.`,
			);
		}
	}

	private requireSameCurrency(first: Account, second: Account): void {
		if (first.currency !== second.currency) {
			throw new WealthError(
				"currency_mismatch",
				`Accounts "${first.name}" and "${second.name}" use different currencies.`,
			);
		}
	}
}

function mapHousehold(row: { id: string; name: string; base_currency: string; created_at: string }): Household {
	return {
		id: row.id,
		name: row.name,
		baseCurrency: row.base_currency,
		createdAt: row.created_at,
	};
}

function mapAccount(row: AccountRow): Account {
	return {
		id: row.id,
		householdId: row.household_id,
		name: row.name,
		type: row.type,
		currency: row.currency,
		balanceMinor: row.balance_minor,
		balance: formatDecimalAmount(row.balance_minor, row.currency),
		createdAt: row.created_at,
		...(row.subtype ? { subtype: row.subtype } : {}),
		...(row.owner_name ? { ownerName: row.owner_name } : {}),
	};
}

function normalizeTransactionBookkeeping(
	input: RecordTransactionBookkeepingInput,
): RecordTransactionBookkeepingInput {
	if (!Number.isSafeInteger(input.profileRevision) || input.profileRevision < 0) {
		throw new WealthError("invalid_transaction", "Bookkeeping profile revision must be a non-negative integer.");
	}
	const profileHash = input.profileHash.trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(profileHash)) {
		throw new WealthError("invalid_transaction", "Bookkeeping profile hash must be a SHA-256 hex digest.");
	}
	const categoryId = cleanOptionalText(input.categoryId);
	const categoryLabel = cleanOptionalText(input.categoryLabel);
	if (Boolean(categoryId) !== Boolean(categoryLabel)) {
		throw new WealthError(
			"invalid_transaction",
			"Bookkeeping category id and label must either both be present or both be absent.",
		);
	}
	if (
		!["explicit", "rule", "account_binding", "unclassified", "reversal"].includes(
			input.resolutionSource,
		)
	) {
		throw new WealthError("invalid_transaction", "Unsupported bookkeeping resolution source.");
	}
	const customFields: Record<string, TransactionCustomFieldValue> = {};
	for (const key of Object.keys(input.customFields).sort()) {
		const value = input.customFields[key];
		if (value === undefined) {
			throw new WealthError("invalid_transaction", `Bookkeeping custom field "${key}" is undefined.`);
		}
		if (!key.trim() || key.length > 80) {
			throw new WealthError("invalid_transaction", "Bookkeeping custom field ids must be 1 to 80 characters.");
		}
		if (typeof value === "number" && !Number.isSafeInteger(value)) {
			throw new WealthError("invalid_transaction", `Bookkeeping custom field "${key}" must be a safe integer.`);
		}
		if (typeof value === "string" && value.length > 1_000) {
			throw new WealthError(
				"invalid_transaction",
				`Bookkeeping custom field "${key}" must not exceed 1000 characters.`,
			);
		}
		if (!["string", "boolean", "number"].includes(typeof value)) {
			throw new WealthError("invalid_transaction", `Bookkeeping custom field "${key}" has an invalid value.`);
		}
		customFields[key] = value;
	}
	const categorizationRuleId = cleanOptionalText(input.categorizationRuleId);
	return {
		profileRevision: input.profileRevision,
		profileHash,
		...(categoryId && categoryLabel ? { categoryId, categoryLabel } : {}),
		...(categorizationRuleId ? { categorizationRuleId } : {}),
		customFields,
		resolutionSource: input.resolutionSource,
	};
}

function mapTransactionBookkeeping(row: TransactionBookkeepingRow): TransactionBookkeepingMetadata {
	const parsed = JSON.parse(row.custom_fields_json) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new WealthError("invalid_transaction", "Stored bookkeeping custom fields are invalid.");
	}
	const normalized = normalizeTransactionBookkeeping({
		profileRevision: row.profile_revision,
		profileHash: row.profile_hash,
		...(row.category_id && row.category_label
			? { categoryId: row.category_id, categoryLabel: row.category_label }
			: {}),
		...(row.categorization_rule_id ? { categorizationRuleId: row.categorization_rule_id } : {}),
		customFields: parsed as Record<string, TransactionCustomFieldValue>,
		resolutionSource: row.resolution_source,
	});
	return { ...normalized, createdAt: row.created_at };
}

function cleanOptionalText(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned || undefined;
}

function requireDescription(value: string): string {
	const description = value.trim();
	if (!description) throw new WealthError("invalid_transaction", "Transaction description is required.");
	return description;
}

function normalizeTimestamp(value: string | undefined): string {
	if (!value) return new Date().toISOString();
	const trimmed = value.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		const timestamp = `${trimmed}T12:00:00.000Z`;
		if (new Date(timestamp).toISOString().slice(0, 10) !== trimmed) {
			throw new WealthError("invalid_date", `Invalid calendar date "${value}".`);
		}
		return timestamp;
	}

	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) throw new WealthError("invalid_date", `Invalid timestamp "${value}".`);
	return parsed.toISOString();
}

function normalizeDate(value: string): string {
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		throw new WealthError("invalid_date", `Date must use YYYY-MM-DD, received "${value}".`);
	}
	const parsed = new Date(`${trimmed}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
		throw new WealthError("invalid_date", `Invalid calendar date "${value}".`);
	}
	return trimmed;
}

function currentDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function paymentCutoff(asOf: string): string {
	return `${addDays(asOf, 1)}T00:00:00.000Z`;
}

function daysBetween(fromDate: string, toDate: string): number {
	const from = Date.parse(`${fromDate}T00:00:00.000Z`);
	const to = Date.parse(`${toDate}T00:00:00.000Z`);
	return Math.round((to - from) / 86_400_000);
}

function cardStatementQuery(where: string, order: string): string {
	return `SELECT s.id, s.card_account_id, a.name AS card_account_name,
			s.period_start, s.period_end, s.statement_date, s.due_date, s.currency,
			s.statement_amount_minor, s.minimum_payment_minor, s.accounting_mode, s.created_at,
			CASE s.accounting_mode
				WHEN 'integrated' THEN (
					SELECT COALESCE(SUM(sp.amount_minor), 0)
					FROM statement_payments AS sp
					JOIN transactions AS payment_transaction ON payment_transaction.id = sp.transaction_id
					WHERE sp.statement_id = s.id
						AND payment_transaction.occurred_at < ?
				)
				ELSE (
					SELECT COALESCE(SUM(ssp.amount_minor), 0)
					FROM standalone_statement_payments AS ssp
					WHERE ssp.statement_id = s.id
						AND ssp.occurred_at < ?
				)
			END AS paid_amount_minor
		FROM credit_card_statements AS s
		JOIN accounts AS a ON a.id = s.card_account_id
		${where}
		${order}`;
}

function mapCardStatement(row: CardStatementRow, asOf: string): CardStatement {
	const paidAmountMinor = row.paid_amount_minor;
	const outstandingAmountMinor = row.statement_amount_minor - paidAmountMinor;
	const daysUntilDue = daysBetween(asOf, row.due_date);
	let status: CardStatementStatus;
	if (outstandingAmountMinor === 0) status = "paid";
	else if (daysUntilDue < 0) status = "overdue";
	else if (daysUntilDue === 0) status = "due_today";
	else if (daysUntilDue <= 7) status = "due_soon";
	else status = "open";

	return {
		id: row.id,
		cardAccountId: row.card_account_id,
		cardAccountName: row.card_account_name,
		periodStart: row.period_start,
		periodEnd: row.period_end,
		statementDate: row.statement_date,
		dueDate: row.due_date,
		currency: row.currency,
		statementAmountMinor: row.statement_amount_minor,
		statementAmount: formatDecimalAmount(row.statement_amount_minor, row.currency),
		minimumPaymentMinor: row.minimum_payment_minor,
		minimumPayment: formatDecimalAmount(row.minimum_payment_minor, row.currency),
		accountingMode: row.accounting_mode,
		paidAmountMinor,
		paidAmount: formatDecimalAmount(paidAmountMinor, row.currency),
		outstandingAmountMinor,
		outstandingAmount: formatDecimalAmount(outstandingAmountMinor, row.currency),
		status,
		daysUntilDue,
		createdAt: row.created_at,
	};
}

function mapStandaloneStatementPayment(
	row: StandaloneStatementPaymentRow,
	currency: string,
	duplicate: boolean,
): LightweightCardPayment {
	return {
		accountingMode: "lightweight",
		id: row.id,
		householdId: row.household_id,
		statementId: row.statement_id,
		amountMinor: row.amount_minor,
		amount: formatDecimalAmount(row.amount_minor, currency),
		occurredAt: row.occurred_at,
		createdAt: row.created_at,
		duplicate,
		...(row.funding_account_id ? { fundingAccountId: row.funding_account_id } : {}),
		...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
	};
}

function trackedAssetQuery(where: string): string {
	return `SELECT ta.id, ta.account_id, a.name AS account_name, ta.kind,
			a.currency, ta.freshness_days, ta.created_at
		FROM tracked_assets AS ta
		JOIN accounts AS a ON a.id = ta.account_id
		${where}`;
}

function mapTrackedAsset(row: TrackedAssetRow): TrackedAsset {
	return {
		id: row.id,
		accountId: row.account_id,
		accountName: row.account_name,
		kind: row.kind,
		currency: row.currency,
		freshnessDays: row.freshness_days,
		createdAt: row.created_at,
	};
}

function mapAssetValuation(row: AssetValuationRow): AssetValuation {
	return {
		id: row.id,
		assetId: row.asset_id,
		valuedAt: row.valued_at,
		currency: row.currency,
		amountMinor: row.amount_minor,
		amount: formatDecimalAmount(row.amount_minor, row.currency),
		createdAt: row.created_at,
		...(row.note ? { note: row.note } : {}),
	};
}

function addDays(date: string, amount: number): string {
	const timestamp = Date.parse(`${date}T00:00:00.000Z`);
	return new Date(timestamp + amount * 86_400_000).toISOString().slice(0, 10);
}

function safeAdd(first: number, second: number): number {
	const sum = first + second;
	if (!Number.isSafeInteger(sum)) throw new WealthError("invalid_amount", "Calculated total exceeds the safe ledger range.");
	return sum;
}
