import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WealthDatabase } from "../src/core/database.ts";
import { WealthService } from "../src/core/wealth-service.ts";

test("migrates v6 statements and allocations to lightweight tracking without rewriting the ledger", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "folksum-migration-"));
	const path = join(directory, "wealth.db");
	context.after(() => rmSync(directory, { recursive: true, force: true }));

	const original = new WealthDatabase(path);
	const originalService = new WealthService(original, {
		baseCurrency: "HKD",
		cardTrackingMode: "integrated",
	});
	const householdId = originalService.household.id;
	const bank = originalService.createAccount({ name: "Checking", type: "asset", openingBalance: "200.00" });
	const card = originalService.createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
	const shopping = originalService.createAccount({ name: "Shopping", type: "expense" });
	const purchase = originalService.recordExpense({
		description: "Legacy purchases",
		amount: "100.00",
		expenseAccountId: shopping.id,
		fundingAccountId: card.id,
		occurredAt: "2026-07-31",
	});
	const statement = originalService.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-07-01",
		periodEnd: "2026-07-31",
		statementDate: "2026-08-01",
		dueDate: "2026-08-20",
		statementAmount: "100.00",
	}).statement;
	const payment = originalService.recordCardPayment({
		statementId: statement.id,
		fundingAccountId: bank.id,
		amount: "40.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "legacy-payment",
	});
	const unbackedStatement = originalService.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-08-01",
		periodEnd: "2026-08-31",
		statementDate: "2026-09-01",
		dueDate: "2026-09-20",
		statementAmount: "30.00",
	}).statement;
	if (payment.payment.accountingMode !== "integrated") {
		throw new Error("Expected an integrated fixture payment.");
	}
	const paymentTransactionId = payment.payment.transaction.id;
	const legacyPayment = original.connection
		.prepare("SELECT * FROM statement_payments WHERE transaction_id = ?")
		.get(paymentTransactionId) as {
			id: string;
			statement_id: string;
			transaction_id: string;
			amount_minor: number;
			created_at: string;
		};
	const balancesBeforeMigration = {
		bank: originalService.getAccount(bank.id).balance,
		card: originalService.getAccount(card.id).balance,
		shopping: originalService.getAccount(shopping.id).balance,
	};
	const transactionsBeforeMigration = originalService.listTransactions().map((transaction) => transaction.id);
	original.close();

	const downgrade = new DatabaseSync(path);
	downgrade.exec(`
		DROP TABLE channel_update_receipts;
		DROP TRIGGER transaction_bookkeeping_immutable_update;
		DROP TRIGGER transaction_bookkeeping_immutable_delete;
		DROP TRIGGER transaction_bookkeeping_match_profile_revision;
		DROP TRIGGER bookkeeping_profile_revisions_immutable_update;
		DROP TRIGGER bookkeeping_profile_revisions_immutable_delete;
		DROP TRIGGER bookkeeping_profile_revisions_match_author;
		DROP TABLE transaction_bookkeeping;
		DROP TABLE active_bookkeeping_profiles;
		DROP TABLE bookkeeping_profile_revisions;
		DROP TRIGGER standalone_statement_payments_match_statement;
		DROP TRIGGER statement_payments_match_integrated_statement;
		DROP TRIGGER transactions_reject_standalone_idempotency;
		DROP TRIGGER transaction_updates_reject_standalone_idempotency;
		DROP TRIGGER standalone_payments_reject_transaction_idempotency;
		DROP TRIGGER standalone_payment_updates_reject_transaction_idempotency;
		DROP TRIGGER card_statement_accounting_mode_immutable;
		DROP TABLE standalone_statement_payments;
		ALTER TABLE credit_card_statements DROP COLUMN accounting_mode;
		PRAGMA user_version = 6;
	`);
	downgrade.close();

	const migrated = new WealthDatabase(path);
	context.after(() => migrated.close());
	assert.equal(
		(migrated.connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
		9,
	);
	assert.deepEqual(
		migrated.connection
			.prepare(
				`SELECT name FROM sqlite_schema
				 WHERE type = 'table' AND name IN (
					'bookkeeping_profile_revisions', 'active_bookkeeping_profiles', 'transaction_bookkeeping'
				 ) ORDER BY name`,
			)
			.all()
			.map((row) => ({ ...row })),
		[
			{ name: "active_bookkeeping_profiles" },
			{ name: "bookkeeping_profile_revisions" },
			{ name: "transaction_bookkeeping" },
		],
	);
	assert.deepEqual(
		{
			...(migrated.connection
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'channel_update_receipts'")
				.get() as object),
		},
		{ name: "channel_update_receipts" },
	);
	assert.ok(
		(migrated.connection.prepare("PRAGMA table_info(credit_card_statements)").all() as Array<{ name: string }>).some(
			(column) => column.name === "accounting_mode",
		),
	);
	assert.deepEqual(
		migrated.connection
			.prepare("SELECT * FROM statement_payments WHERE transaction_id = ?")
			.get(paymentTransactionId),
		legacyPayment,
	);
	assert.deepEqual(
		{
			...(migrated.connection
				.prepare(
					`SELECT id, household_id, statement_id, funding_account_id, amount_minor,
						occurred_at, idempotency_key, created_at
					 FROM standalone_statement_payments WHERE id = ?`,
				)
				.get(legacyPayment.id) as object),
		},
		{
			id: legacyPayment.id,
			household_id: householdId,
			statement_id: statement.id,
			funding_account_id: bank.id,
			amount_minor: 4000,
			occurred_at: "2026-08-10T12:00:00.000Z",
			idempotency_key: "legacy-payment",
			created_at: legacyPayment.created_at,
		},
	);
	assert.deepEqual(
		migrated.connection
			.prepare("SELECT id, accounting_mode FROM credit_card_statements ORDER BY statement_date")
			.all()
			.map((row) => ({ ...row })),
		[
			{ id: statement.id, accounting_mode: "lightweight" },
			{ id: unbackedStatement.id, accounting_mode: "lightweight" },
		],
	);

	const migratedService = new WealthService(migrated, {
		householdId,
		cardTrackingMode: "lightweight",
	});
	const restored = migratedService.getCardStatement(statement.id, "2026-08-11");
	assert.equal(restored.accountingMode, "lightweight");
	assert.equal(restored.paidAmount, "40.00");
	assert.equal(restored.outstandingAmount, "60.00");
	const migratedRetry = migratedService.recordCardPayment({
		statementId: statement.id,
		fundingAccountId: bank.id,
		amount: "40.00",
		occurredAt: "2026-08-10",
		idempotencyKey: "legacy-payment",
	});
	if (migratedRetry.payment.accountingMode !== "lightweight") {
		throw new Error("Expected migrated payments to use lightweight tracking.");
	}
	assert.equal(migratedRetry.payment.duplicate, true);
	assert.equal(migratedRetry.payment.id, legacyPayment.id);
	const transactionCountBeforeCollision = migratedService.listTransactions().length;
	assert.throws(
		() =>
			migratedService.recordExpense({
				description: "Must not impersonate a migrated payment",
				amount: "1.00",
				expenseAccountId: shopping.id,
				fundingAccountId: bank.id,
				idempotencyKey: "legacy-payment",
			}),
		/standalone card payment/,
	);
	assert.equal(migratedService.listTransactions().length, transactionCountBeforeCollision);
	assert.deepEqual(
		{
			bank: migratedService.getAccount(bank.id).balance,
			card: migratedService.getAccount(card.id).balance,
			shopping: migratedService.getAccount(shopping.id).balance,
		},
		balancesBeforeMigration,
	);
	assert.deepEqual(
		migratedService.listTransactions().map((transaction) => transaction.id),
		transactionsBeforeMigration,
	);

	migratedService.recordCardPayment({
		statementId: statement.id,
		amount: "60.00",
		occurredAt: "2026-08-12",
	});
	migratedService.recordCardPayment({
		statementId: unbackedStatement.id,
		amount: "30.00",
		occurredAt: "2026-09-10",
	});
	assert.equal(migratedService.getCardStatement(statement.id, "2026-08-12").status, "paid");
	assert.equal(migratedService.getCardStatement(unbackedStatement.id, "2026-09-10").status, "paid");
	assert.deepEqual(
		{
			bank: migratedService.getAccount(bank.id).balance,
			card: migratedService.getAccount(card.id).balance,
			shopping: migratedService.getAccount(shopping.id).balance,
		},
		balancesBeforeMigration,
	);
	assert.deepEqual(
		migratedService.listTransactions().map((transaction) => transaction.id),
		transactionsBeforeMigration,
	);
	assert.throws(
		() =>
			migrated.connection
				.prepare("UPDATE credit_card_statements SET accounting_mode = 'integrated' WHERE id = ?")
				.run(statement.id),
		/Card statement accounting mode is immutable/,
	);

	migrated.connection
		.prepare("INSERT INTO households (id, name, base_currency, created_at) VALUES (?, ?, ?, ?)")
		.run("other-household", "Other", "HKD", "2026-08-11T00:00:00.000Z");
	assert.throws(
		() =>
			migrated.connection
				.prepare(
					`INSERT INTO standalone_statement_payments
						(id, household_id, statement_id, amount_minor, occurred_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"cross-household-payment",
					"other-household",
					statement.id,
					100,
					"2026-08-11T00:00:00.000Z",
					"2026-08-11T00:00:00.000Z",
				),
		/Standalone payment must match a lightweight statement and its household/,
	);

	migratedService.setCardTrackingMode("integrated");
	const integratedStatement = migratedService.recordCardStatement({
		cardAccountId: card.id,
		periodStart: "2026-09-01",
		periodEnd: "2026-09-30",
		statementDate: "2026-10-01",
		dueDate: "2026-10-20",
		statementAmount: "10.00",
	}).statement;
	assert.throws(
		() =>
			migrated.connection
				.prepare(
					`INSERT INTO standalone_statement_payments
						(id, household_id, statement_id, amount_minor, occurred_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"wrong-mode-standalone",
					householdId,
					integratedStatement.id,
					100,
					"2026-10-10T00:00:00.000Z",
					"2026-10-10T00:00:00.000Z",
				),
		/Standalone payment must match a lightweight statement and its household/,
	);
	assert.throws(
		() =>
			migrated.connection
				.prepare(
					`INSERT INTO statement_payments
						(id, statement_id, transaction_id, amount_minor, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(
					"wrong-mode-ledger",
					unbackedStatement.id,
					purchase.transaction.id,
					100,
					"2026-10-10T00:00:00.000Z",
				),
		/Ledger payment allocation requires an integrated statement/,
	);
});
