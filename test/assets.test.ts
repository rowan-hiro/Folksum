import assert from "node:assert/strict";
import test from "node:test";

import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

function createFixture(): { database: WealthDatabase; service: WealthService } {
	const database = new WealthDatabase(":memory:");
	const service = new WealthService(database, { baseCurrency: "HKD" });
	return { database, service };
}

test("uses the latest eligible valuation and keeps net worth separated by currency", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	service.createAccount({ name: "HKD Checking", type: "asset", currency: "HKD", openingBalance: "1000.00" });
	const home = service.createAccount({
		name: "Family Home",
		type: "asset",
		currency: "HKD",
		openingBalance: "5000000.00",
	});
	service.createAccount({
		name: "Mortgage",
		type: "liability",
		currency: "HKD",
		openingBalance: "2000000.00",
	});
	service.createAccount({ name: "USD Cash", type: "asset", currency: "USD", openingBalance: "100.00" });

	const asset = service.registerAsset({ accountId: home.id, kind: "property", freshnessDays: 30 });
	service.recordAssetValuation({ assetId: asset.asset.id, valuedAt: "2026-07-01", amount: "5500000.00" });
	service.recordAssetValuation({ assetId: asset.asset.id, valuedAt: "2026-08-10", amount: "6000000.00" });
	service.recordAssetValuation({ assetId: asset.asset.id, valuedAt: "2026-08-12", amount: "6100000.00" });

	const report = service.getNetWorth("2026-08-11");
	assert.equal(report.warnings.length, 0);
	assert.deepEqual(
		report.totals.map((total) => [total.currency, total.assets, total.liabilities, total.netWorth]),
		[
			["HKD", "6001000.00", "2000000.00", "4001000.00"],
			["USD", "100.00", "0.00", "100.00"],
		],
	);
	const homeItem = report.totals[0]?.items.find((item) => item.accountId === home.id);
	assert.equal(homeItem?.source, "valuation");
	assert.equal(homeItem?.valuationDate, "2026-08-10");

	const stale = service.getNetWorth("2026-09-15");
	assert.equal(stale.totals[0]?.assets, "6101000.00");
	assert.match(stale.warnings[0] ?? "", /34 days old/);
});

test("deduplicates exact valuations and warns when a tracked asset has none", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const investment = service.createAccount({
		name: "Brokerage",
		type: "asset",
		openingBalance: "10000.00",
	});
	const registered = service.registerAsset({ accountId: investment.id, kind: "investment" });
	assert.equal(registered.created, true);
	assert.match(service.getNetWorth("2026-08-11").warnings[0] ?? "", /No valuation/);

	const input = {
		assetId: registered.asset.id,
		valuedAt: "2026-08-11",
		amount: "10500.50",
		note: "Broker statement",
	};
	const first = service.recordAssetValuation(input);
	const retry = service.recordAssetValuation(input);
	assert.equal(first.duplicate, false);
	assert.equal(retry.duplicate, true);
	assert.equal(retry.valuation.id, first.valuation.id);
	assert.equal(service.getNetWorth("2026-08-11").totals[0]?.netWorth, "10500.50");
});

test("summarizes net spending by category and currency", (context) => {
	const { database, service } = createFixture();
	context.after(() => database.close());

	const cash = service.createAccount({ name: "Cash", type: "asset", openingBalance: "100.00" });
	const dining = service.createAccount({ name: "Dining", type: "expense" });
	const transport = service.createAccount({ name: "Transport", type: "expense" });
	const lunch = service.recordExpense({
		description: "Lunch",
		amount: "20.00",
		expenseAccountId: dining.id,
		fundingAccountId: cash.id,
		occurredAt: "2026-08-05",
	});
	service.recordExpense({
		description: "Train",
		amount: "8.50",
		expenseAccountId: transport.id,
		fundingAccountId: cash.id,
		occurredAt: "2026-08-06",
	});
	service.reverseTransaction({ transactionId: lunch.transaction.id, occurredAt: "2026-08-07" });
	service.recordExpense({
		description: "Outside range",
		amount: "5.00",
		expenseAccountId: dining.id,
		fundingAccountId: cash.id,
		occurredAt: "2026-07-31",
	});

	const summary = service.getSpendingSummary("2026-08-01", "2026-08-31");
	assert.deepEqual(summary.totals, [{ currency: "HKD", amountMinor: 850, amount: "8.50" }]);
	assert.deepEqual(
		summary.categories.map((category) => [category.accountName, category.amount]),
		[
			["Transport", "8.50"],
			["Dining", "0.00"],
		],
	);
});
