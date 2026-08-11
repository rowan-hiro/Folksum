export type WealthErrorCode =
	| "account_not_found"
	| "asset_not_found"
	| "card_statement_not_found"
	| "currency_mismatch"
	| "duplicate"
	| "invalid_account"
	| "invalid_amount"
	| "invalid_asset"
	| "invalid_card_statement"
	| "invalid_date"
	| "invalid_transaction"
	| "transaction_not_found";

export class WealthError extends Error {
	readonly code: WealthErrorCode;

	constructor(code: WealthErrorCode, message: string) {
		super(message);
		this.name = "WealthError";
		this.code = code;
	}
}
