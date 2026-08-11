const ZERO_DECIMAL_CURRENCIES = new Set([
	"BIF",
	"CLP",
	"DJF",
	"GNF",
	"JPY",
	"KMF",
	"KRW",
	"PYG",
	"RWF",
	"UGX",
	"VND",
	"VUV",
	"XAF",
	"XOF",
	"XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export type MoneyErrorCode = "currency" | "format" | "scale" | "range";

export class MoneyError extends Error {
	readonly code: MoneyErrorCode;

	constructor(code: MoneyErrorCode, message: string) {
		super(message);
		this.name = "MoneyError";
		this.code = code;
	}
}

export function normalizeCurrency(currency: string): string {
	const normalized = currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(normalized)) {
		throw new MoneyError("currency", `Currency must be a three-letter code, received "${currency}".`);
	}
	return normalized;
}

export function getCurrencyScale(currency: string): number {
	const normalized = normalizeCurrency(currency);
	if (ZERO_DECIMAL_CURRENCIES.has(normalized)) return 0;
	if (THREE_DECIMAL_CURRENCIES.has(normalized)) return 3;
	return 2;
}

export function parseDecimalAmount(amount: string, currency: string): number {
	const normalizedCurrency = normalizeCurrency(currency);
	const scale = getCurrencyScale(normalizedCurrency);
	const value = amount.trim();
	const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);

	if (!match) {
		throw new MoneyError(
			"format",
			`Amount must be a plain decimal string such as "38.50", received "${amount}".`,
		);
	}

	const sign = match[1] === "-" ? -1n : 1n;
	const whole = match[2] ?? "0";
	const fraction = match[3] ?? "";
	if (fraction.length > scale) {
		throw new MoneyError(
			"scale",
			`${normalizedCurrency} supports ${scale} fractional digit${scale === 1 ? "" : "s"}; received "${amount}".`,
		);
	}

	const factor = 10n ** BigInt(scale);
	const paddedFraction = fraction.padEnd(scale, "0");
	const unsignedMinorUnits = BigInt(whole) * factor + BigInt(paddedFraction || "0");
	const minorUnits = sign * unsignedMinorUnits;

	if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER) || minorUnits < BigInt(Number.MIN_SAFE_INTEGER)) {
		throw new MoneyError("range", `Amount "${amount}" exceeds the safe ledger range.`);
	}

	return Number(minorUnits);
}

export function formatDecimalAmount(amountMinor: number, currency: string): string {
	if (!Number.isSafeInteger(amountMinor)) {
		throw new MoneyError("range", `Minor-unit amount must be a safe integer, received ${String(amountMinor)}.`);
	}

	const scale = getCurrencyScale(currency);
	const value = BigInt(amountMinor);
	const sign = value < 0n ? "-" : "";
	const absolute = value < 0n ? -value : value;

	if (scale === 0) return `${sign}${absolute.toString()}`;

	const factor = 10n ** BigInt(scale);
	const whole = absolute / factor;
	const fraction = (absolute % factor).toString().padStart(scale, "0");
	return `${sign}${whole.toString()}.${fraction}`;
}

export function normalizeDecimalAmount(amount: string, currency: string): string {
	return formatDecimalAmount(parseDecimalAmount(amount, currency), currency);
}
