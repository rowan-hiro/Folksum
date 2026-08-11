import assert from "node:assert/strict";
import test from "node:test";

import {
	formatDecimalAmount,
	getCurrencyScale,
	MoneyError,
	normalizeCurrency,
	normalizeDecimalAmount,
	parseDecimalAmount,
} from "../src/core/money.ts";

test("round-trips two-decimal currencies without floating-point values", () => {
	assert.equal(parseDecimalAmount("38.50", "HKD"), 3850);
	assert.equal(parseDecimalAmount("38.5", "hkd"), 3850);
	assert.equal(formatDecimalAmount(3850, "HKD"), "38.50");
	assert.equal(normalizeDecimalAmount("00038.5", "HKD"), "38.50");
	assert.equal(normalizeDecimalAmount("-12.34", "USD"), "-12.34");
});

test("uses the currency scale for zero- and three-decimal currencies", () => {
	assert.equal(getCurrencyScale("JPY"), 0);
	assert.equal(parseDecimalAmount("1250", "JPY"), 1250);
	assert.equal(formatDecimalAmount(1250, "JPY"), "1250");

	assert.equal(getCurrencyScale("BHD"), 3);
	assert.equal(parseDecimalAmount("1.250", "BHD"), 1250);
	assert.equal(formatDecimalAmount(1250, "BHD"), "1.250");
});

test("normalizes and validates currency codes", () => {
	assert.equal(normalizeCurrency(" hkd "), "HKD");
	assert.throws(() => normalizeCurrency("Hong Kong Dollar"), (error: unknown) => {
		assert.ok(error instanceof MoneyError);
		assert.equal(error.code, "currency");
		return true;
	});
});

test("rejects ambiguous formats, excess precision, and unsafe values", () => {
	assert.throws(() => parseDecimalAmount("1,000.00", "HKD"), { name: "MoneyError" });
	assert.throws(() => parseDecimalAmount("1e3", "HKD"), { name: "MoneyError" });
	assert.throws(() => parseDecimalAmount("38.501", "HKD"), (error: unknown) => {
		assert.ok(error instanceof MoneyError);
		assert.equal(error.code, "scale");
		return true;
	});
	assert.throws(() => parseDecimalAmount("90071992547409.92", "HKD"), (error: unknown) => {
		assert.ok(error instanceof MoneyError);
		assert.equal(error.code, "range");
		return true;
	});
	assert.throws(() => formatDecimalAmount(1.5, "HKD"), { name: "MoneyError" });
});
