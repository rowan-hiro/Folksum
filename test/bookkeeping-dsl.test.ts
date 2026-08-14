import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
	BookkeepingDslError,
	compileBookkeepingDsl,
	parseBookkeepingDsl,
	rewriteExpectedRevision,
} from "../src/app/bookkeeping-dsl.ts";
import { getDefaultBookkeepingProfile } from "../src/app/bookkeeping-profile.ts";

const cliPath = resolve(import.meta.dirname, "../src/channels/cli.ts");

const COMPLETE_DSL = `folksum-bookkeeping 1
expected-revision 0 # current revision
extends folksum/default@1

# Private deployments can keep household values in this external file.
category expense.food.coffee {
  label "Coffee"
  kind expense
  parent expense.food
}

field participant {
  label "Participant"
  type text
  required false
  values "self" "partner" "shared"
}

rule merchant.coffee {
  priority 80
  when expense description contains "coffee shop"
  category expense.food.coffee
  field participant "shared"
}

export daily.json {
  label "Daily JSON"
  format json
  rows transactions
  reversals exclude
  amount-sign debit-positive
  source agent
  source manual
  column "Date" transaction.date
  column "Description" transaction.description
  column "Participant" customFields.participant
}

remove category expense.travel
`;

test("bookkeeping DSL compiles a revision-aware overlay through profile validation", () => {
	const { document, profile } = compileBookkeepingDsl(COMPLETE_DSL, getDefaultBookkeepingProfile());

	assert.equal(document.expectedRevision, 0);
	assert.equal(document.extends, "folksum/default@1");
	assert.ok(profile.categories.some((category) => category.id === "expense.food.coffee"));
	assert.ok(!profile.categories.some((category) => category.id === "expense.travel"));
	assert.deepEqual(profile.customFields[0], {
		id: "participant",
		label: "Participant",
		target: "transaction",
		type: "text",
		required: false,
		allowedValues: ["self", "partner", "shared"],
	});
	assert.deepEqual(profile.categorizationRules[0]?.assign, {
		categoryId: "expense.food.coffee",
		fields: { participant: "shared" },
	});
	assert.equal(profile.exportProfiles[0]?.columns[2]?.source, "customFields.participant");
});

test("bookkeeping DSL supports typed rule values and strict, line-aware syntax errors", () => {
	const profile = compileBookkeepingDsl(
		`folksum-bookkeeping 1
expected-revision 0
extends folksum/default@1
field reimbursable {
  label "Reimbursable"
  type boolean
}
field attendees {
  label "Attendees"
  type integer
}
rule team.meal {
  priority 25
  when expense description contains "team meal"
  category expense.food.dining
  field reimbursable true
  field attendees 4
}
`,
		getDefaultBookkeepingProfile(),
	).profile;
	assert.deepEqual(profile.categorizationRules[0]?.assign.fields, {
		reimbursable: true,
		attendees: 4,
	});

	assert.throws(
		() =>
			parseBookkeepingDsl(`folksum-bookkeeping 1
expected-revision 0
extends folksum/default@1
javascript "process.exit()"
`),
		(error: unknown) => error instanceof BookkeepingDslError && /Line 4: Unknown top-level directive/.test(error.message),
	);
	assert.throws(
		() => compileBookkeepingDsl(COMPLETE_DSL.replace("customFields.participant", "customFields.missing"), getDefaultBookkeepingProfile()),
		/references unknown custom field "missing"/,
	);
	assert.throws(
		() => parseBookkeepingDsl(COMPLETE_DSL.replace('label "Coffee"', "label Coffee")),
		/Line 7: Category label must be a quoted string/,
	);
});

test("bookkeeping DSL CLI checks and explicitly applies an external private overlay", (context) => {
	const directory = createDirectory(context);
	const configPath = join(directory, "config.json");
	const dslPath = join(directory, "household.folksum");
	writeFileSync(
		configPath,
		JSON.stringify({
			databasePath: join(directory, "wealth.db"),
			baseCurrency: "HKD",
			cliIdentity: "owner",
			session: "dsl",
		}),
	);
	writeFileSync(dslPath, COMPLETE_DSL);
	const environment = cleanFolksumEnvironment();
	environment.FOLKSUM_CONFIG_PATH = configPath;

	const checked = runCli(directory, environment, ["profile", "check-dsl", dslPath]);
	assert.equal(checked.status, 0, checked.stderr);
	assert.deepEqual(JSON.parse(checked.stdout), {
		status: "valid",
		expectedRevision: 0,
		categories: 19,
		customFields: 1,
		categorizationRules: 1,
		captureShortcuts: 0,
		exportProfiles: 1,
	});

	const applied = runCli(directory, environment, ["profile", "apply-dsl", dslPath]);
	assert.equal(applied.status, 0, applied.stderr);
	assert.equal(JSON.parse(applied.stdout).status, "activated");
	assert.equal(JSON.parse(applied.stdout).revision, 1);
	assert.match(readFileSync(dslPath, "utf8"), /^expected-revision 1 # current revision$/m);

	writeFileSync(dslPath, COMPLETE_DSL);
	const stale = runCli(directory, environment, ["profile", "check-dsl", dslPath]);
	assert.notEqual(stale.status, 0);
	assert.match(stale.stderr, /revision conflict: expected 0, active revision is 1/);
});

test("bookkeeping DSL rewrite preserves trailing comments on expected-revision", () => {
	assert.equal(
		rewriteExpectedRevision("expected-revision 0 # current revision\n", 1),
		"expected-revision 1 # current revision\n",
	);
	assert.equal(
		rewriteExpectedRevision("expected-revision 0#current\r\n", 2),
		"expected-revision 2#current\r\n",
	);
	assert.equal(
		rewriteExpectedRevision("\texpected-revision 3\n", 4),
		"\texpected-revision 4\n",
	);
	assert.throws(() => rewriteExpectedRevision("extends folksum/default@1\n", 1), /could not update expected-revision/);
});

test("bookkeeping DSL compiles amount predicates, shortcuts, and export primitives", () => {
	const { profile } = compileBookkeepingDsl(
		`folksum-bookkeeping 1
expected-revision 0
extends folksum/default@1

shortcut transit.bus {
  label "Bus"
  kind expense
  description "巴士"
  amount "5.00"
  category expense.transport
}

rule taxi.shared {
  priority 250
  when expense all {
    description contains "的士"
    amountPerPerson 2 gte "50"
  }
  category expense.transport
}

export household.csv {
  label "Household CSV"
  format csv
  rows transactions
  reversals include
  amount-sign debit-positive
  utf8-bom true
  column "Date" transaction.date date-format dd/mm/yyyy
  column "Amount" transaction.amount amount-role pnl
  column "Kind" literal "expense"
}
`,
		getDefaultBookkeepingProfile(),
	);
	assert.deepEqual(profile.captureShortcuts, [
		{
			id: "transit.bus",
			label: "Bus",
			transactionKind: "expense",
			description: "巴士",
			amount: "5.00",
			categoryId: "expense.transport",
		},
	]);
	assert.deepEqual(profile.categorizationRules.find((rule) => rule.id === "taxi.shared")?.match, {
		transactionKind: "expense",
		all: [{ descriptionContains: "的士" }, { amountPerPerson: { gte: "50", participantCount: 2 } }],
	});
	const exportProfile = profile.exportProfiles.find((item) => item.id === "household.csv");
	assert.equal(exportProfile?.utf8Bom, true);
	assert.deepEqual(exportProfile?.columns, [
		{ header: "Date", source: "transaction.date", dateFormat: "dd/mm/yyyy" },
		{ header: "Amount", source: "transaction.amount", amountRole: "pnl" },
		{ header: "Kind", literal: "expense" },
	]);
});

function createDirectory(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "folksum-dsl-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function cleanFolksumEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("FOLKSUM_")),
	) as NodeJS.ProcessEnv;
}

function runCli(directory: string, env: NodeJS.ProcessEnv, args: string[]) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", "--experimental-sqlite", cliPath, ...args],
		{ cwd: directory, env, encoding: "utf8", timeout: 10_000 },
	);
}
