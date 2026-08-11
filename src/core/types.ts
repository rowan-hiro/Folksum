export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";
export type TransactionSource = "agent" | "manual" | "import" | "system";

export interface Household {
	id: string;
	name: string;
	baseCurrency: string;
	createdAt: string;
}

export interface Account {
	id: string;
	householdId: string;
	name: string;
	type: AccountType;
	subtype?: string;
	currency: string;
	ownerName?: string;
	balanceMinor: number;
	balance: string;
	createdAt: string;
}

export interface Posting {
	id: string;
	transactionId: string;
	accountId: string;
	accountName: string;
	amountMinor: number;
	amount: string;
	memo?: string;
}

export interface LedgerTransaction {
	id: string;
	householdId: string;
	description: string;
	currency: string;
	occurredAt: string;
	source: TransactionSource;
	idempotencyKey?: string;
	reversalOf?: string;
	createdAt: string;
	postings: Posting[];
}

export interface PostedTransaction {
	transaction: LedgerTransaction;
	duplicate: boolean;
}

export interface CreateAccountInput {
	name: string;
	type: AccountType;
	currency?: string;
	subtype?: string;
	ownerName?: string;
	openingBalance?: string;
}

export interface RecordExpenseInput {
	description: string;
	amount: string;
	expenseAccountId: string;
	fundingAccountId: string;
	occurredAt?: string;
	idempotencyKey?: string;
}

export interface RecordIncomeInput {
	description: string;
	amount: string;
	incomeAccountId: string;
	destinationAccountId: string;
	occurredAt?: string;
	idempotencyKey?: string;
}

export interface RecordTransferInput {
	description: string;
	amount: string;
	fromAccountId: string;
	toAccountId: string;
	occurredAt?: string;
	idempotencyKey?: string;
}

export interface ReverseTransactionInput {
	transactionId: string;
	description?: string;
	occurredAt?: string;
	idempotencyKey?: string;
}

export type CardStatementStatus = "open" | "due_soon" | "due_today" | "overdue" | "paid";

export interface CardStatement {
	id: string;
	cardAccountId: string;
	cardAccountName: string;
	periodStart: string;
	periodEnd: string;
	statementDate: string;
	dueDate: string;
	currency: string;
	statementAmountMinor: number;
	statementAmount: string;
	minimumPaymentMinor: number;
	minimumPayment: string;
	paidAmountMinor: number;
	paidAmount: string;
	outstandingAmountMinor: number;
	outstandingAmount: string;
	status: CardStatementStatus;
	daysUntilDue: number;
	createdAt: string;
}

export interface RecordedCardStatement {
	statement: CardStatement;
	duplicate: boolean;
}

export interface CardPaymentResult {
	payment: PostedTransaction;
	statement: CardStatement;
}

export interface CardReminder {
	statementId: string;
	cardAccountId: string;
	cardAccountName: string;
	dueDate: string;
	daysUntilDue: number;
	status: "due_soon" | "due_today" | "overdue";
	currency: string;
	outstandingAmountMinor: number;
	outstandingAmount: string;
}

export interface RecordCardStatementInput {
	cardAccountId: string;
	periodStart: string;
	periodEnd: string;
	statementDate: string;
	dueDate: string;
	statementAmount: string;
	minimumPayment?: string;
}

export interface RecordCardPaymentInput {
	statementId: string;
	fundingAccountId: string;
	amount: string;
	occurredAt?: string;
	idempotencyKey?: string;
}

export interface ListCardRemindersInput {
	asOf?: string;
	windowDays?: number;
}

export type AssetKind = "property" | "investment" | "vehicle" | "collectible" | "business" | "other";

export interface TrackedAsset {
	id: string;
	accountId: string;
	accountName: string;
	kind: AssetKind;
	currency: string;
	freshnessDays: number;
	createdAt: string;
}

export interface RegisteredAsset {
	asset: TrackedAsset;
	created: boolean;
}

export interface AssetValuation {
	id: string;
	assetId: string;
	valuedAt: string;
	currency: string;
	amountMinor: number;
	amount: string;
	note?: string;
	createdAt: string;
}

export interface RecordedAssetValuation {
	valuation: AssetValuation;
	duplicate: boolean;
}

export interface RegisterAssetInput {
	accountId: string;
	kind: AssetKind;
	freshnessDays?: number;
}

export interface RecordAssetValuationInput {
	assetId: string;
	valuedAt: string;
	amount: string;
	note?: string;
}

export interface NetWorthItem {
	accountId: string;
	accountName: string;
	type: "asset" | "liability";
	currency: string;
	amountMinor: number;
	amount: string;
	source: "ledger" | "valuation";
	valuationDate?: string;
}

export interface NetWorthCurrencySummary {
	currency: string;
	assetsMinor: number;
	assets: string;
	liabilitiesMinor: number;
	liabilities: string;
	netWorthMinor: number;
	netWorth: string;
	items: NetWorthItem[];
}

export interface NetWorthReport {
	asOf: string;
	totals: NetWorthCurrencySummary[];
	warnings: string[];
}

export interface SpendingCategorySummary {
	accountId: string;
	accountName: string;
	currency: string;
	amountMinor: number;
	amount: string;
}

export interface SpendingCurrencySummary {
	currency: string;
	amountMinor: number;
	amount: string;
}

export interface SpendingSummary {
	from: string;
	to: string;
	totals: SpendingCurrencySummary[];
	categories: SpendingCategorySummary[];
}
