import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 9;

export class WealthDatabase {
	readonly connection: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.connection = new DatabaseSync(path);
		this.connection.exec("PRAGMA foreign_keys = ON");
		this.connection.exec("PRAGMA journal_mode = WAL");
		this.migrate();
	}

	close(): void {
		this.connection.close();
	}

	transaction<T>(operation: () => T): T {
		this.connection.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.connection.exec("COMMIT");
			return result;
		} catch (error) {
			this.connection.exec("ROLLBACK");
			throw error;
		}
	}

	private migrate(): void {
		const row = this.connection.prepare("PRAGMA user_version").get() as { user_version: number };
		let version = row.user_version;
		if (version > SCHEMA_VERSION) {
			throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`);
		}
		if (version < 1) {
			this.connection.exec(`
			BEGIN;

			CREATE TABLE households (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				base_currency TEXT NOT NULL CHECK (length(base_currency) = 3),
				created_at TEXT NOT NULL
			) STRICT;

			CREATE TABLE accounts (
				id TEXT PRIMARY KEY,
				household_id TEXT NOT NULL REFERENCES households(id),
				name TEXT NOT NULL COLLATE NOCASE,
				type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'income', 'expense', 'equity')),
				subtype TEXT,
				currency TEXT NOT NULL CHECK (length(currency) = 3),
				owner_name TEXT,
				created_at TEXT NOT NULL,
				closed_at TEXT,
				UNIQUE (household_id, name)
			) STRICT;

			CREATE TABLE transactions (
				id TEXT PRIMARY KEY,
				household_id TEXT NOT NULL REFERENCES households(id),
				description TEXT NOT NULL,
				currency TEXT NOT NULL CHECK (length(currency) = 3),
				occurred_at TEXT NOT NULL,
				source TEXT NOT NULL CHECK (source IN ('agent', 'manual', 'import', 'system')),
				idempotency_key TEXT,
				reversal_of TEXT UNIQUE REFERENCES transactions(id),
				created_at TEXT NOT NULL,
				UNIQUE (household_id, idempotency_key)
			) STRICT;

			CREATE TABLE postings (
				id TEXT PRIMARY KEY,
				transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
				account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
				amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
				memo TEXT
			) STRICT;

			CREATE INDEX postings_transaction_idx ON postings(transaction_id);
			CREATE INDEX postings_account_idx ON postings(account_id);
			CREATE INDEX transactions_household_occurred_idx ON transactions(household_id, occurred_at DESC);

			CREATE TRIGGER postings_match_transaction
			BEFORE INSERT ON postings
			WHEN NOT EXISTS (
				SELECT 1
				FROM transactions AS t
				JOIN accounts AS a ON a.id = NEW.account_id
				WHERE t.id = NEW.transaction_id
					AND t.household_id = a.household_id
					AND t.currency = a.currency
			)
			BEGIN
				SELECT RAISE(ABORT, 'Posting account must match transaction household and currency');
			END;

			PRAGMA user_version = 1;
			COMMIT;
		`);
			version = 1;
		}

		if (version < 2) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE credit_card_statements (
					id TEXT PRIMARY KEY,
					card_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
					period_start TEXT NOT NULL,
					period_end TEXT NOT NULL,
					statement_date TEXT NOT NULL,
					due_date TEXT NOT NULL,
					currency TEXT NOT NULL CHECK (length(currency) = 3),
					statement_amount_minor INTEGER NOT NULL CHECK (statement_amount_minor > 0),
					minimum_payment_minor INTEGER NOT NULL CHECK (minimum_payment_minor >= 0),
					created_at TEXT NOT NULL,
					UNIQUE (card_account_id, statement_date)
				) STRICT;

				CREATE TABLE statement_payments (
					id TEXT PRIMARY KEY,
					statement_id TEXT NOT NULL REFERENCES credit_card_statements(id) ON DELETE RESTRICT,
					transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
					amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
					created_at TEXT NOT NULL
				) STRICT;

				CREATE INDEX card_statements_due_idx ON credit_card_statements(due_date);
				CREATE INDEX statement_payments_statement_idx ON statement_payments(statement_id);

				PRAGMA user_version = 2;
				COMMIT;
			`);
			version = 2;
		}

		if (version < 3) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE tracked_assets (
					id TEXT PRIMARY KEY,
					account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
					kind TEXT NOT NULL CHECK (kind IN ('property', 'investment', 'vehicle', 'collectible', 'business', 'other')),
					freshness_days INTEGER NOT NULL CHECK (freshness_days > 0),
					created_at TEXT NOT NULL
				) STRICT;

				CREATE TABLE asset_valuations (
					id TEXT PRIMARY KEY,
					asset_id TEXT NOT NULL REFERENCES tracked_assets(id) ON DELETE RESTRICT,
					valued_at TEXT NOT NULL,
					currency TEXT NOT NULL CHECK (length(currency) = 3),
					amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
					note TEXT,
					created_at TEXT NOT NULL,
					UNIQUE (asset_id, valued_at)
				) STRICT;

				CREATE INDEX asset_valuations_asset_date_idx ON asset_valuations(asset_id, valued_at DESC);

				PRAGMA user_version = 3;
				COMMIT;
			`);
			version = 3;
		}

		if (version < 4) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE pending_operations (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					actor_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					ir_kind TEXT NOT NULL,
					ir_json TEXT NOT NULL,
					ir_hash TEXT NOT NULL,
					risk TEXT NOT NULL CHECK (risk IN ('medium', 'high')),
					status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'executed', 'rejected', 'expired', 'failed')),
					token_hash TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					created_at TEXT NOT NULL,
					confirmed_at TEXT,
					executed_at TEXT,
					error_message TEXT
				) STRICT;

				CREATE INDEX pending_operations_scope_idx
					ON pending_operations(household_id, actor_id, session_id, status);
				CREATE INDEX pending_operations_expiry_idx ON pending_operations(status, expires_at);

				PRAGMA user_version = 4;
				COMMIT;
			`);
			version = 4;
		}

		if (version < 5) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE household_members (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					display_name TEXT NOT NULL,
					role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
					timezone TEXT NOT NULL,
					created_at TEXT NOT NULL
				) STRICT;

				CREATE TABLE channel_identities (
					id TEXT PRIMARY KEY,
					member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE RESTRICT,
					channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web', 'cli', 'scheduler')),
					external_id TEXT NOT NULL,
					created_at TEXT NOT NULL,
					UNIQUE (channel, external_id)
				) STRICT;

				CREATE TABLE app_sessions (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					actor_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE RESTRICT,
					channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web', 'cli', 'scheduler')),
					conversation_key TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					UNIQUE (actor_id, channel, conversation_key)
				) STRICT;

				CREATE TABLE session_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE RESTRICT,
					sequence INTEGER NOT NULL,
					role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
					content_json TEXT NOT NULL,
					created_at TEXT NOT NULL,
					UNIQUE (session_id, sequence)
				) STRICT;

				CREATE TABLE memory_rules (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					kind TEXT NOT NULL CHECK (kind IN ('account_alias', 'default_account', 'merchant_category', 'reminder_policy', 'preference')),
					rule_key TEXT NOT NULL,
					value_json TEXT NOT NULL,
					author_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE RESTRICT,
					provenance TEXT NOT NULL CHECK (provenance IN ('user', 'admin', 'import')),
					enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
					expires_at TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE (household_id, kind, rule_key)
				) STRICT;

				CREATE INDEX app_sessions_scope_idx ON app_sessions(household_id, actor_id, last_active_at DESC);
				CREATE INDEX session_messages_session_idx ON session_messages(session_id, sequence);
				CREATE INDEX memory_rules_active_idx ON memory_rules(household_id, kind, enabled, expires_at);

				PRAGMA user_version = 5;
				COMMIT;
			`);
			version = 5;
		}

		if (version < 6) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE notification_outbox (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					recipient_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE RESTRICT,
					channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web', 'cli', 'scheduler')),
					kind TEXT NOT NULL,
					dedupe_key TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
					available_at TEXT NOT NULL,
					attempts INTEGER NOT NULL CHECK (attempts >= 0),
					created_at TEXT NOT NULL,
					sent_at TEXT,
					error_message TEXT,
					UNIQUE (household_id, recipient_id, channel, dedupe_key)
				) STRICT;

				CREATE INDEX notification_outbox_delivery_idx
					ON notification_outbox(status, available_at, channel);

				PRAGMA user_version = 6;
				COMMIT;
			`);
			version = 6;
		}

		if (version < 7) {
			this.connection.exec(`
				BEGIN;

				ALTER TABLE credit_card_statements
					ADD COLUMN accounting_mode TEXT NOT NULL DEFAULT 'lightweight'
					CHECK (accounting_mode IN ('lightweight', 'integrated'));

				CREATE TABLE standalone_statement_payments (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					statement_id TEXT NOT NULL REFERENCES credit_card_statements(id) ON DELETE RESTRICT,
					funding_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
					amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
					occurred_at TEXT NOT NULL,
					idempotency_key TEXT,
					created_at TEXT NOT NULL,
					UNIQUE (household_id, idempotency_key)
				) STRICT;

				CREATE INDEX standalone_statement_payments_statement_idx
					ON standalone_statement_payments(statement_id);
				CREATE INDEX standalone_statement_payments_funding_idx
					ON standalone_statement_payments(funding_account_id);

				INSERT INTO standalone_statement_payments
					(id, household_id, statement_id, funding_account_id, amount_minor,
					 occurred_at, idempotency_key, created_at)
				SELECT sp.id, card.household_id, sp.statement_id,
					(
						SELECT p.account_id
						FROM postings AS p
						JOIN accounts AS funding ON funding.id = p.account_id
						WHERE p.transaction_id = sp.transaction_id
							AND funding.household_id = card.household_id
							AND funding.type = 'asset'
							AND funding.currency = s.currency
							AND p.amount_minor = -sp.amount_minor
						ORDER BY p.rowid
						LIMIT 1
					),
					sp.amount_minor, t.occurred_at, t.idempotency_key, sp.created_at
				FROM statement_payments AS sp
				JOIN credit_card_statements AS s ON s.id = sp.statement_id
				JOIN accounts AS card ON card.id = s.card_account_id
				JOIN transactions AS t ON t.id = sp.transaction_id;

				CREATE TRIGGER standalone_statement_payments_match_statement
				BEFORE INSERT ON standalone_statement_payments
				WHEN NOT EXISTS (
					SELECT 1
					FROM credit_card_statements AS s
					JOIN accounts AS card ON card.id = s.card_account_id
					WHERE s.id = NEW.statement_id
						AND s.accounting_mode = 'lightweight'
						AND card.household_id = NEW.household_id
						AND (
							NEW.funding_account_id IS NULL
							OR EXISTS (
								SELECT 1
								FROM accounts AS funding
								WHERE funding.id = NEW.funding_account_id
									AND funding.household_id = NEW.household_id
									AND funding.type = 'asset'
									AND funding.currency = s.currency
							)
						)
				)
				BEGIN
					SELECT RAISE(ABORT, 'Standalone payment must match a lightweight statement and its household');
				END;

				CREATE TRIGGER statement_payments_match_integrated_statement
				BEFORE INSERT ON statement_payments
				WHEN NOT EXISTS (
					SELECT 1
					FROM credit_card_statements AS s
					JOIN accounts AS card ON card.id = s.card_account_id
					JOIN transactions AS payment_transaction ON payment_transaction.id = NEW.transaction_id
					WHERE s.id = NEW.statement_id
						AND s.accounting_mode = 'integrated'
						AND payment_transaction.household_id = card.household_id
						AND payment_transaction.currency = s.currency
				)
				BEGIN
					SELECT RAISE(ABORT, 'Ledger payment allocation requires an integrated statement');
				END;

				CREATE TRIGGER transactions_reject_standalone_idempotency
				BEFORE INSERT ON transactions
				WHEN NEW.idempotency_key IS NOT NULL AND EXISTS (
					SELECT 1
					FROM standalone_statement_payments AS ssp
					WHERE ssp.household_id = NEW.household_id
						AND ssp.idempotency_key = NEW.idempotency_key
				)
				BEGIN
					SELECT RAISE(ABORT, 'Idempotency key belongs to a standalone card payment');
				END;

				CREATE TRIGGER transaction_updates_reject_standalone_idempotency
				BEFORE UPDATE OF household_id, idempotency_key ON transactions
				WHEN (NEW.household_id != OLD.household_id OR NEW.idempotency_key IS NOT OLD.idempotency_key)
					AND NEW.idempotency_key IS NOT NULL
					AND EXISTS (
						SELECT 1
						FROM standalone_statement_payments AS ssp
						WHERE ssp.household_id = NEW.household_id
							AND ssp.idempotency_key = NEW.idempotency_key
					)
				BEGIN
					SELECT RAISE(ABORT, 'Idempotency key belongs to a standalone card payment');
				END;

				CREATE TRIGGER standalone_payments_reject_transaction_idempotency
				BEFORE INSERT ON standalone_statement_payments
				WHEN NEW.idempotency_key IS NOT NULL AND EXISTS (
					SELECT 1
					FROM transactions AS t
					WHERE t.household_id = NEW.household_id
						AND t.idempotency_key = NEW.idempotency_key
				)
				BEGIN
					SELECT RAISE(ABORT, 'Idempotency key belongs to a ledger transaction');
				END;

				CREATE TRIGGER standalone_payment_updates_reject_transaction_idempotency
				BEFORE UPDATE OF household_id, idempotency_key ON standalone_statement_payments
				WHEN (NEW.household_id != OLD.household_id OR NEW.idempotency_key IS NOT OLD.idempotency_key)
					AND NEW.idempotency_key IS NOT NULL
					AND EXISTS (
						SELECT 1
						FROM transactions AS t
						WHERE t.household_id = NEW.household_id
							AND t.idempotency_key = NEW.idempotency_key
					)
				BEGIN
					SELECT RAISE(ABORT, 'Idempotency key belongs to a ledger transaction');
				END;

				CREATE TRIGGER card_statement_accounting_mode_immutable
				BEFORE UPDATE OF accounting_mode ON credit_card_statements
				WHEN NEW.accounting_mode != OLD.accounting_mode
				BEGIN
					SELECT RAISE(ABORT, 'Card statement accounting mode is immutable');
				END;

				PRAGMA user_version = 7;
				COMMIT;
			`);
			version = 7;
		}

		if (version < 8) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE bookkeeping_profile_revisions (
					id TEXT PRIMARY KEY,
					household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
					revision INTEGER NOT NULL CHECK (revision > 0),
					profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
					profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
					author_id TEXT REFERENCES household_members(id) ON DELETE RESTRICT,
					source TEXT NOT NULL CHECK (source IN ('user', 'agent', 'import', 'system')),
					created_at TEXT NOT NULL,
					UNIQUE (household_id, revision),
					UNIQUE (id, household_id)
				) STRICT;

				CREATE TABLE active_bookkeeping_profiles (
					household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE RESTRICT,
					revision_id TEXT NOT NULL,
					activated_at TEXT NOT NULL,
					FOREIGN KEY (revision_id, household_id)
						REFERENCES bookkeeping_profile_revisions(id, household_id) ON DELETE RESTRICT
				) STRICT;

				CREATE TABLE transaction_bookkeeping (
					transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE RESTRICT,
					profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
					profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
					category_id TEXT,
					category_label TEXT,
					categorization_rule_id TEXT,
					custom_fields_json TEXT NOT NULL CHECK (json_valid(custom_fields_json)),
					resolution_source TEXT NOT NULL CHECK (
						resolution_source IN ('explicit', 'rule', 'account_binding', 'unclassified', 'reversal')
					),
					created_at TEXT NOT NULL,
					CHECK ((category_id IS NULL) = (category_label IS NULL))
				) STRICT;

				CREATE INDEX bookkeeping_profile_revisions_household_idx
					ON bookkeeping_profile_revisions(household_id, revision DESC);

				CREATE TRIGGER bookkeeping_profile_revisions_match_author
					BEFORE INSERT ON bookkeeping_profile_revisions
					WHEN NEW.author_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM household_members
						WHERE id = NEW.author_id AND household_id = NEW.household_id
					)
					BEGIN
						SELECT RAISE(ABORT, 'Bookkeeping profile author must belong to the household');
					END;

				CREATE TRIGGER bookkeeping_profile_revisions_immutable_update
					BEFORE UPDATE ON bookkeeping_profile_revisions
					BEGIN
						SELECT RAISE(ABORT, 'Bookkeeping profile revisions are immutable');
					END;

				CREATE TRIGGER bookkeeping_profile_revisions_immutable_delete
					BEFORE DELETE ON bookkeeping_profile_revisions
					BEGIN
						SELECT RAISE(ABORT, 'Bookkeeping profile revisions are immutable');
					END;

				CREATE TRIGGER transaction_bookkeeping_immutable_update
					BEFORE UPDATE ON transaction_bookkeeping
					BEGIN
						SELECT RAISE(ABORT, 'Transaction bookkeeping metadata is immutable');
					END;

				CREATE TRIGGER transaction_bookkeeping_match_profile_revision
					BEFORE INSERT ON transaction_bookkeeping
					WHEN NEW.profile_revision > 0 AND NOT EXISTS (
						SELECT 1
						FROM transactions AS transactions
						JOIN bookkeeping_profile_revisions AS revisions
							ON revisions.household_id = transactions.household_id
							AND revisions.revision = NEW.profile_revision
							AND revisions.profile_hash = NEW.profile_hash
						WHERE transactions.id = NEW.transaction_id
					)
					BEGIN
						SELECT RAISE(ABORT, 'Transaction bookkeeping profile revision does not match its household');
					END;

				CREATE TRIGGER transaction_bookkeeping_immutable_delete
					BEFORE DELETE ON transaction_bookkeeping
					BEGIN
						SELECT RAISE(ABORT, 'Transaction bookkeeping metadata is immutable');
					END;

				PRAGMA user_version = 8;
				COMMIT;
			`);
			version = 8;
		}

		if (version < 9) {
			this.connection.exec(`
				BEGIN;

				CREATE TABLE channel_update_receipts (
					id TEXT PRIMARY KEY,
					channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web', 'cli', 'scheduler')),
					external_update_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
					claimed_at TEXT NOT NULL,
					completed_at TEXT,
					error_message TEXT,
					UNIQUE (channel, external_update_id)
				) STRICT;

				CREATE INDEX channel_update_receipts_status_idx
					ON channel_update_receipts(channel, status, claimed_at);

				PRAGMA user_version = 9;
				COMMIT;
			`);
		}
	}
}
