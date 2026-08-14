import {
	applyBookkeepingProfilePatch,
	BookkeepingProfileError,
	type AmountBound,
	type BookkeepingCategoryDefinition,
	type BookkeepingExportColumnDefinition,
	type BookkeepingExportColumnSource,
	type BookkeepingExportProfileDefinition,
	type BookkeepingProfile,
	type BookkeepingProfilePatch,
	type CaptureShortcutDefinition,
	type CategorizationRuleDefinition,
	type CustomFieldDefinition,
	type CustomFieldValue,
	type RulePredicate,
} from "./bookkeeping-profile.ts";

export const BOOKKEEPING_DSL_FORMAT_VERSION = 1 as const;

export interface BookkeepingDslDocument {
	formatVersion: typeof BOOKKEEPING_DSL_FORMAT_VERSION;
	expectedRevision: number;
	extends: "folksum/default@1";
	patch: BookkeepingProfilePatch;
}

interface Token {
	value: string;
	quoted: boolean;
}

interface SourceLine {
	number: number;
	tokens: Token[];
}

type DeclarationKind = "category" | "field" | "rule" | "shortcut" | "export";

const COLLECTION_NAMES = {
	category: "categories",
	field: "customFields",
	rule: "categorizationRules",
	shortcut: "captureShortcuts",
	export: "exportProfiles",
} as const;

const AMOUNT_BOUND_KEYS = ["eq", "gte", "gt", "lte", "lt"] as const;

export class BookkeepingDslError extends Error {
	readonly line: number | undefined;

	constructor(message: string, line?: number) {
		super(line === undefined ? message : `Line ${line}: ${message}`);
		this.name = "BookkeepingDslError";
		this.line = line;
	}
}

export function parseBookkeepingDsl(text: string, source = "bookkeeping DSL"): BookkeepingDslDocument {
	if (Buffer.byteLength(text, "utf8") > 1_000_000) {
		throw new BookkeepingDslError(`${source} must not exceed 1000000 bytes.`);
	}
	const lines = tokenizeDocument(text);
	const header = lines.shift();
	if (!header || !tokensEqual(header.tokens, ["folksum-bookkeeping", "1"])) {
		throw new BookkeepingDslError(`${source} must start with \"folksum-bookkeeping 1\".`, header?.number ?? 1);
	}

	let expectedRevision: number | undefined;
	let extendsProfile: "folksum/default@1" | undefined;
	const upserts: Record<DeclarationKind, unknown[]> = {
		category: [],
		field: [],
		rule: [],
		shortcut: [],
		export: [],
	};
	const removals: Record<DeclarationKind, string[]> = {
		category: [],
		field: [],
		rule: [],
		shortcut: [],
		export: [],
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line) continue;
		const [command, ...rest] = line.tokens;
		if (!command) continue;
		if (command.value === "expected-revision") {
			if (expectedRevision !== undefined) fail("expected-revision may appear only once.", line);
			expectedRevision = parseNonNegativeInteger(singleToken(rest, line, "expected-revision"), line);
			continue;
		}
		if (command.value === "extends") {
			if (extendsProfile !== undefined) fail("extends may appear only once.", line);
			const value = singleToken(rest, line, "extends").value;
			if (value !== "folksum/default@1") fail('extends must be "folksum/default@1".', line);
			extendsProfile = value;
			continue;
		}
		if (command.value === "remove") {
			if (rest.length !== 2) fail("remove requires a declaration kind and id.", line);
			const kind = parseDeclarationKind(rest[0], line);
			removals[kind].push(requireBare(rest[1], line, "Removal id"));
			continue;
		}
		if (isDeclarationKind(command.value)) {
			if (rest.length !== 2 || rest[1]?.value !== "{") {
				fail(`${command.value} requires an id followed by \"{\".`, line);
			}
			const id = requireBare(rest[0], line, `${command.value} id`);
			const block: SourceLine[] = [];
			let closed = false;
			let depth = 1;
			for (index += 1; index < lines.length; index += 1) {
				const blockLine = lines[index];
				if (!blockLine) continue;
				if (depth === 1 && tokensEqual(blockLine.tokens, ["}"])) {
					closed = true;
					break;
				}
				depth += braceNet(blockLine);
				if (depth < 1) fail("Unbalanced block braces.", blockLine);
				block.push(blockLine);
			}
			if (!closed) fail(`Unclosed ${command.value} block.`, line);
			upserts[command.value].push(parseDeclaration(command.value, id, block, line));
			continue;
		}
		fail(`Unknown top-level directive \"${command.value}\".`, line);
	}

	if (expectedRevision === undefined) {
		throw new BookkeepingDslError(`${source} requires expected-revision.`);
	}
	if (extendsProfile === undefined) throw new BookkeepingDslError(`${source} requires extends.`);
	const patch: BookkeepingProfilePatch = {};
	for (const kind of Object.keys(COLLECTION_NAMES) as DeclarationKind[]) {
		const upsert = upserts[kind];
		const remove = removals[kind];
		if (upsert.length === 0 && remove.length === 0) continue;
		Object.assign(patch, {
			[COLLECTION_NAMES[kind]]: {
				...(upsert.length > 0 ? { upsert } : {}),
				...(remove.length > 0 ? { remove } : {}),
			},
		});
	}
	if (Object.keys(patch).length === 0) {
		throw new BookkeepingDslError(`${source} must declare or remove at least one profile item.`);
	}
	return {
		formatVersion: BOOKKEEPING_DSL_FORMAT_VERSION,
		expectedRevision,
		extends: extendsProfile,
		patch,
	};
}

export function compileBookkeepingDsl(
	text: string,
	baseProfile: BookkeepingProfile,
	source = "bookkeeping DSL",
): { document: BookkeepingDslDocument; profile: BookkeepingProfile } {
	const document = parseBookkeepingDsl(text, source);
	try {
		return { document, profile: applyBookkeepingProfilePatch(baseProfile, document.patch) };
	} catch (error) {
		if (error instanceof BookkeepingProfileError) {
			throw new BookkeepingDslError(`${source} does not compile: ${error.message}`);
		}
		throw error;
	}
}

export function rewriteExpectedRevision(text: string, revision: number, source = "bookkeeping DSL"): string {
	if (!Number.isSafeInteger(revision) || revision < 0) {
		throw new BookkeepingDslError(`${source}: revision must be a non-negative integer.`);
	}
	const pattern = /^(expected-revision)[ \t]+\d+[ \t]*$/m;
	if (!pattern.test(text)) {
		throw new BookkeepingDslError(`${source}: could not update expected-revision.`);
	}
	return text.replace(pattern, `expected-revision ${revision}`);
}

function parseDeclaration(
	kind: DeclarationKind,
	id: string,
	lines: SourceLine[],
	openingLine: SourceLine,
): unknown {
	switch (kind) {
		case "category":
			return parseCategory(id, lines, openingLine);
		case "field":
			return parseField(id, lines, openingLine);
		case "rule":
			return parseRule(id, lines, openingLine);
		case "shortcut":
			return parseShortcut(id, lines, openingLine);
		case "export":
			return parseExport(id, lines, openingLine);
	}
}

function parseCategory(id: string, lines: SourceLine[], openingLine: SourceLine): BookkeepingCategoryDefinition {
	let label: string | undefined;
	let kind: "expense" | "income" | undefined;
	let parentId: string | undefined;
	const accountIds: Record<string, string> = {};
	for (const line of lines) {
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "label":
				label = unique(label, requireQuoted(singleToken(args, line, "label"), line, "Category label"), line, "label");
				break;
			case "kind": {
				const value = requireBare(singleToken(args, line, "kind"), line, "Category kind");
				if (value !== "expense" && value !== "income") fail('kind must be "expense" or "income".', line);
				kind = unique(kind, value, line, "kind");
				break;
			}
			case "parent":
				parentId = unique(parentId, requireBare(singleToken(args, line, "parent"), line, "Parent id"), line, "parent");
				break;
			case "account": {
				if (args.length !== 2) fail("account requires a currency and quoted account id.", line);
				const currency = requireBare(args[0], line, "Account currency").toUpperCase();
				if (accountIds[currency]) fail(`account ${currency} is duplicated.`, line);
				accountIds[currency] = requireQuoted(args[1], line, "Account id");
				break;
			}
			default:
				unknownDirective("category", directive, line);
		}
	}
	return {
		id,
		label: required(label, "label", openingLine),
		kind: required(kind, "kind", openingLine),
		...(parentId ? { parentId } : {}),
		...(Object.keys(accountIds).length > 0 ? { accountIds } : {}),
	};
}

function parseField(id: string, lines: SourceLine[], openingLine: SourceLine): CustomFieldDefinition {
	let label: string | undefined;
	let type: CustomFieldDefinition["type"] | undefined;
	let requiredValue: boolean | undefined;
	let allowedValues: string[] | undefined;
	for (const line of lines) {
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "label":
				label = unique(label, requireQuoted(singleToken(args, line, "label"), line, "Field label"), line, "label");
				break;
			case "type": {
				const value = requireBare(singleToken(args, line, "type"), line, "Field type");
				if (!["text", "boolean", "integer", "date"].includes(value)) fail(`Unsupported field type \"${value}\".`, line);
				type = unique(type, value as CustomFieldDefinition["type"], line, "type");
				break;
			}
			case "required":
				requiredValue = unique(requiredValue, parseBoolean(singleToken(args, line, "required"), line), line, "required");
				break;
			case "values":
				if (allowedValues !== undefined) fail("values may appear only once.", line);
				if (args.length === 0) fail("values requires at least one quoted value.", line);
				allowedValues = args.map((token) => requireQuoted(token, line, "Allowed value"));
				break;
			default:
				unknownDirective("field", directive, line);
		}
	}
	return {
		id,
		label: required(label, "label", openingLine),
		target: "transaction",
		type: required(type, "type", openingLine),
		required: requiredValue ?? false,
		...(allowedValues ? { allowedValues } : {}),
	};
}

function parseRule(id: string, lines: SourceLine[], openingLine: SourceLine): CategorizationRuleDefinition {
	let priority: number | undefined;
	let transactionKind: "expense" | "income" | undefined;
	let predicate: RulePredicate | undefined;
	let categoryId: string | undefined;
	const fields: Record<string, CustomFieldValue> = {};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line) continue;
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "priority":
				priority = unique(priority, parseNonNegativeInteger(singleToken(args, line, "priority"), line), line, "priority");
				break;
			case "when": {
				const parsed = parseWhen(lines, index);
				transactionKind = unique(transactionKind, parsed.transactionKind, line, "when");
				predicate = unique(predicate, parsed.predicate, line, "when");
				index += parsed.consumed - 1;
				break;
			}
			case "category":
				categoryId = unique(categoryId, requireBare(singleToken(args, line, "category"), line, "Category id"), line, "category");
				break;
			case "field": {
				if (args.length !== 2) fail("field requires an id and scalar value.", line);
				const fieldId = requireBare(args[0], line, "Field id");
				if (fieldId in fields) fail(`field ${fieldId} is duplicated.`, line);
				fields[fieldId] = parseScalar(args[1], line);
				break;
			}
			default:
				unknownDirective("rule", directive, line);
		}
	}
	if (!categoryId && Object.keys(fields).length === 0) {
		fail("rule must assign a category or at least one field.", openingLine);
	}
	return {
		id,
		priority: required(priority, "priority", openingLine),
		match: {
			transactionKind: required(transactionKind, "when", openingLine),
			...required(predicate, "when", openingLine),
		},
		assign: {
			...(categoryId ? { categoryId } : {}),
			...(Object.keys(fields).length > 0 ? { fields } : {}),
		},
	};
}

function parseShortcut(id: string, lines: SourceLine[], openingLine: SourceLine): CaptureShortcutDefinition {
	let label: string | undefined;
	let transactionKind: "expense" | "income" | undefined;
	let description: string | undefined;
	let amount: string | undefined;
	let categoryId: string | undefined;
	const customFields: Record<string, CustomFieldValue> = {};
	for (const line of lines) {
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "label":
				label = unique(label, requireQuoted(singleToken(args, line, "label"), line, "Shortcut label"), line, "label");
				break;
			case "kind": {
				const value = requireBare(singleToken(args, line, "kind"), line, "Shortcut kind");
				if (value !== "expense" && value !== "income") fail('kind must be "expense" or "income".', line);
				transactionKind = unique(transactionKind, value, line, "kind");
				break;
			}
			case "description":
				description = unique(
					description,
					requireQuoted(singleToken(args, line, "description"), line, "Shortcut description"),
					line,
					"description",
				);
				break;
			case "amount":
				amount = unique(amount, requireQuoted(singleToken(args, line, "amount"), line, "Shortcut amount"), line, "amount");
				break;
			case "category":
				categoryId = unique(categoryId, requireBare(singleToken(args, line, "category"), line, "Category id"), line, "category");
				break;
			case "field": {
				if (args.length !== 2) fail("field requires an id and scalar value.", line);
				const fieldId = requireBare(args[0], line, "Field id");
				if (fieldId in customFields) fail(`field ${fieldId} is duplicated.`, line);
				customFields[fieldId] = parseScalar(args[1], line);
				break;
			}
			default:
				unknownDirective("shortcut", directive, line);
		}
	}
	return {
		id,
		label: required(label, "label", openingLine),
		transactionKind: required(transactionKind, "kind", openingLine),
		description: required(description, "description", openingLine),
		...(amount ? { amount } : {}),
		...(categoryId ? { categoryId } : {}),
		...(Object.keys(customFields).length > 0 ? { customFields } : {}),
	};
}

function parseExport(id: string, lines: SourceLine[], openingLine: SourceLine): BookkeepingExportProfileDefinition {
	let label: string | undefined;
	let format: "csv" | "json" | undefined;
	let rowMode: "transactions" | "postings" | undefined;
	let reversals: "include" | "exclude" | "only" | undefined;
	let amountSign: "debit-positive" | "credit-positive" | "absolute" | undefined;
	let delimiter: "," | ";" | "\t" | undefined;
	let utf8Bom: boolean | undefined;
	const categoryIds: string[] = [];
	const accountIds: string[] = [];
	const transactionSources: Array<"agent" | "manual" | "import" | "system"> = [];
	const columns: BookkeepingExportColumnDefinition[] = [];
	for (const line of lines) {
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "label":
				label = unique(label, requireQuoted(singleToken(args, line, "label"), line, "Export label"), line, "label");
				break;
			case "format": {
				const value = requireBare(singleToken(args, line, "format"), line, "Export format");
				if (value !== "csv" && value !== "json") fail('format must be "csv" or "json".', line);
				format = unique(format, value, line, "format");
				break;
			}
			case "rows": {
				const value = requireBare(singleToken(args, line, "rows"), line, "Export rows");
				if (value !== "transactions" && value !== "postings") fail('rows must be "transactions" or "postings".', line);
				rowMode = unique(rowMode, value, line, "rows");
				break;
			}
			case "reversals": {
				const value = requireBare(singleToken(args, line, "reversals"), line, "Reversals mode");
				if (value !== "include" && value !== "exclude" && value !== "only") fail("Unsupported reversals mode.", line);
				reversals = unique(reversals, value, line, "reversals");
				break;
			}
			case "amount-sign": {
				const value = requireBare(singleToken(args, line, "amount-sign"), line, "Amount sign");
				if (value !== "debit-positive" && value !== "credit-positive" && value !== "absolute") fail("Unsupported amount-sign.", line);
				amountSign = unique(amountSign, value, line, "amount-sign");
				break;
			}
			case "delimiter": {
				const value = requireQuoted(singleToken(args, line, "delimiter"), line, "Delimiter");
				if (value !== "," && value !== ";" && value !== "\t") fail("delimiter must be comma, semicolon, or tab.", line);
				delimiter = unique(delimiter, value, line, "delimiter");
				break;
			}
			case "category":
				categoryIds.push(requireBare(singleToken(args, line, "category"), line, "Category filter"));
				break;
			case "account":
				accountIds.push(requireQuoted(singleToken(args, line, "account"), line, "Account filter"));
				break;
			case "source": {
				const value = requireBare(singleToken(args, line, "source"), line, "Transaction source");
				if (value !== "agent" && value !== "manual" && value !== "import" && value !== "system") fail("Unsupported transaction source.", line);
				transactionSources.push(value);
				break;
			}
			case "utf8-bom":
				utf8Bom = unique(utf8Bom, parseBoolean(singleToken(args, line, "utf8-bom"), line), line, "utf8-bom");
				break;
			case "column":
				columns.push(parseExportColumn(args, line));
				break;
			default:
				unknownDirective("export", directive, line);
		}
	}
	return {
		id,
		label: required(label, "label", openingLine),
		format: required(format, "format", openingLine),
		rowMode: required(rowMode, "rows", openingLine),
		reversals: required(reversals, "reversals", openingLine),
		amountSign: required(amountSign, "amount-sign", openingLine),
		...(delimiter !== undefined ? { delimiter } : {}),
		...(utf8Bom ? { utf8Bom: true } : {}),
		...(
			categoryIds.length > 0 || accountIds.length > 0 || transactionSources.length > 0
				? {
					filters: {
						...(categoryIds.length > 0 ? { categoryIds } : {}),
						...(accountIds.length > 0 ? { accountIds } : {}),
						...(transactionSources.length > 0 ? { transactionSources } : {}),
					},
				}
				: {}
		),
		columns,
	};
}

function parseWhen(
	lines: SourceLine[],
	index: number,
): { transactionKind: "expense" | "income"; predicate: RulePredicate; consumed: number } {
	const line = lines[index];
	if (!line) fail("Missing when clause.", lines[0] ?? { number: 1, tokens: [] });
	const args = line.tokens.slice(1);
	if (args.length < 2) fail('when syntax is: when <expense|income> <predicate>.', line);
	const value = requireBare(args[0], line, "Transaction kind");
	if (value !== "expense" && value !== "income") fail('when kind must be "expense" or "income".', line);
	const parsed = parsePredicate(args.slice(1), lines, index);
	return { transactionKind: value, predicate: parsed.predicate, consumed: parsed.consumed };
}

function parsePredicate(
	tokens: Token[],
	lines: SourceLine[],
	index: number,
): { predicate: RulePredicate; consumed: number } {
	const line = lines[index];
	if (!line) fail("Missing match predicate.", lines[0] ?? { number: 1, tokens: [] });
	const head = tokens[0];
	if (!head || head.quoted) fail("unexpected match predicate.", line);
	if (head.value === "description") {
		if (tokens.length !== 3 || tokens[1]?.value !== "contains") {
			fail('when syntax is: when <expense|income> description contains "text".', line);
		}
		return { predicate: { descriptionContains: requireQuoted(tokens[2], line, "Description match") }, consumed: 1 };
	}
	if (head.value === "amountPerPerson") {
		const participantCount = parseNonNegativeInteger(tokens[1], line);
		if (participantCount < 1) fail("amountPerPerson participant count must be >= 1.", line);
		return {
			predicate: { amountPerPerson: { participantCount, ...parseAmountBound(tokens.slice(2), line) } },
			consumed: 1,
		};
	}
	if (head.value === "amount") {
		return { predicate: { amount: parseAmountBound(tokens.slice(1), line) }, consumed: 1 };
	}
	if (head.value === "not" && tokens[1]?.value !== "{") {
		const inner = parsePredicate(tokens.slice(1), lines, index);
		return { predicate: { not: inner.predicate }, consumed: inner.consumed };
	}
	if (head.value === "all" || head.value === "any" || head.value === "not") {
		if (tokens.length !== 2 || tokens[1]?.value !== "{") fail(`${head.value} requires a block.`, line);
		const children: RulePredicate[] = [];
		let consumed = 1;
		let cursor = index + 1;
		while (cursor < lines.length) {
			const innerLine = lines[cursor];
			if (!innerLine) {
				cursor += 1;
				consumed += 1;
				continue;
			}
			if (tokensEqual(innerLine.tokens, ["}"])) {
				consumed += 1;
				if (head.value === "not") {
					if (children.length !== 1) fail("not must contain exactly one predicate.", line);
					return { predicate: { not: children[0] as RulePredicate }, consumed };
				}
				if (children.length === 0) fail(`${head.value} must contain at least one predicate.`, line);
				return { predicate: head.value === "all" ? { all: children } : { any: children }, consumed };
			}
			if (head.value === "not" && children.length > 0) fail("not must contain exactly one predicate.", innerLine);
			const inner = parsePredicate(innerLine.tokens, lines, cursor);
			children.push(inner.predicate);
			consumed += inner.consumed;
			cursor += inner.consumed;
		}
		fail(`Unclosed ${head.value} block.`, line);
	}
	fail(`unexpected match predicate "${head.value}".`, line);
}

function parseAmountBound(tokens: Token[], line: SourceLine): AmountBound {
	const bound: AmountBound = {};
	if (tokens.length === 0 || tokens.length % 2 !== 0) {
		fail("amount bound must contain pairs of eq|gte|gt|lte|lt and a quoted decimal.", line);
	}
	for (let index = 0; index < tokens.length; index += 2) {
		const key = requireBare(tokens[index], line, "Amount bound");
		if (!(AMOUNT_BOUND_KEYS as readonly string[]).includes(key)) {
			fail(`unknown amount bound "${key}".`, line);
		}
		if (bound[key as keyof AmountBound] !== undefined) fail(`duplicate amount bound "${key}".`, line);
		bound[key as keyof AmountBound] = requireQuoted(tokens[index + 1], line, "Amount");
	}
	return bound;
}

function parseExportColumn(args: Token[], line: SourceLine): BookkeepingExportColumnDefinition {
	if (args.length < 2) fail("column requires a quoted header and source or literal.", line);
	const header = requireQuoted(args[0], line, "Column header");
	if (args[1]?.value === "literal") {
		if (args.length !== 3) fail('literal column syntax is: column "Header" literal "value".', line);
		return { header, literal: requireQuoted(args[2], line, "Column literal") };
	}
	const source = requireBare(args[1], line, "Column source") as BookkeepingExportColumnSource;
	let amountRole: BookkeepingExportColumnDefinition["amountRole"];
	let dateFormat: BookkeepingExportColumnDefinition["dateFormat"];
	for (let index = 2; index < args.length; index += 2) {
		const extra = requireBare(args[index], line, "Column option");
		if (extra === "amount-role") {
			const role = requireBare(args[index + 1], line, "Amount role");
			if (role !== "pnl" && role !== "funding" && role !== "debit" && role !== "credit") {
				fail('amount-role must be pnl, funding, debit, or credit.', line);
			}
			if (amountRole !== undefined) fail("amount-role may appear only once.", line);
			amountRole = role;
			continue;
		}
		if (extra === "date-format") {
			const format = requireBare(args[index + 1], line, "Date format");
			if (format !== "yyyy-mm-dd" && format !== "yyyy/mm/dd" && format !== "dd/mm/yyyy") {
				fail("date-format must be yyyy-mm-dd, yyyy/mm/dd, or dd/mm/yyyy.", line);
			}
			if (dateFormat !== undefined) fail("date-format may appear only once.", line);
			if (format !== "yyyy-mm-dd") dateFormat = format;
			continue;
		}
		fail(`unknown column option "${extra}".`, line);
	}
	return {
		header,
		source,
		...(amountRole ? { amountRole } : {}),
		...(dateFormat ? { dateFormat } : {}),
	};
}

function tokenizeDocument(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	for (const [index, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
		const tokens = tokenizeLine(rawLine, index + 1);
		if (tokens.length > 0) lines.push({ number: index + 1, tokens });
	}
	return lines;
}

function tokenizeLine(line: string, lineNumber: number): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < line.length) {
		while (/\s/.test(line[index] ?? "")) index += 1;
		if (index >= line.length || line[index] === "#") break;
		if (line[index] === "{" || line[index] === "}") {
			tokens.push({ value: line[index] ?? "", quoted: false });
			index += 1;
			continue;
		}
		if (line[index] === '"') {
			const start = index;
			index += 1;
			let escaped = false;
			while (index < line.length) {
				const character = line[index];
				if (character === '"' && !escaped) break;
				escaped = character === "\\" && !escaped;
				if (character !== "\\") escaped = false;
				index += 1;
			}
			if (index >= line.length) throw new BookkeepingDslError("Unterminated quoted string.", lineNumber);
			const raw = line.slice(start, index + 1);
			try {
				tokens.push({ value: JSON.parse(raw) as string, quoted: true });
			} catch {
				throw new BookkeepingDslError("Invalid JSON-style quoted string.", lineNumber);
			}
			index += 1;
			continue;
		}
		const start = index;
		while (index < line.length && !/\s/.test(line[index] ?? "") && line[index] !== "{" && line[index] !== "}" && line[index] !== "#") {
			index += 1;
		}
		tokens.push({ value: line.slice(start, index), quoted: false });
	}
	return tokens;
}

function parseScalar(token: Token | undefined, line: SourceLine): CustomFieldValue {
	if (!token) fail("Missing scalar value.", line);
	if (token.quoted) return token.value;
	if (token.value === "true") return true;
	if (token.value === "false") return false;
	if (/^-?\d+$/.test(token.value)) {
		const value = Number(token.value);
		if (Number.isSafeInteger(value)) return value;
	}
	fail("Scalar values must be quoted text, a boolean, or a safe integer.", line);
}

function parseBoolean(token: Token | undefined, line: SourceLine): boolean {
	const value = requireBare(token, line, "Boolean");
	if (value === "true") return true;
	if (value === "false") return false;
	fail('Boolean must be "true" or "false".', line);
}

function parseNonNegativeInteger(token: Token | undefined, line: SourceLine): number {
	const value = requireBare(token, line, "Integer");
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("Value must be a non-negative safe integer.", line);
	return Number(value);
}

function parseDeclarationKind(token: Token | undefined, line: SourceLine): DeclarationKind {
	const value = requireBare(token, line, "Declaration kind");
	if (!isDeclarationKind(value)) fail(`Unknown declaration kind \"${value}\".`, line);
	return value;
}

function isDeclarationKind(value: string): value is DeclarationKind {
	return value === "category" || value === "field" || value === "rule" || value === "shortcut" || value === "export";
}

function singleToken(tokens: Token[], line: SourceLine, directive: string): Token {
	if (tokens.length !== 1 || !tokens[0]) fail(`${directive} requires exactly one value.`, line);
	return tokens[0];
}

function requireBare(token: Token | undefined, line: SourceLine, label: string): string {
	if (!token || token.quoted || token.value.length === 0) fail(`${label} must be an unquoted token.`, line);
	return token.value;
}

function requireQuoted(token: Token | undefined, line: SourceLine, label: string): string {
	if (!token?.quoted) fail(`${label} must be a quoted string.`, line);
	return token.value;
}

function required<T>(value: T | undefined, directive: string, line: SourceLine): T {
	if (value === undefined) fail(`Block requires ${directive}.`, line);
	return value;
}

function unique<T>(current: T | undefined, next: T, line: SourceLine, directive: string): T {
	if (current !== undefined) fail(`${directive} may appear only once.`, line);
	return next;
}

function unknownDirective(kind: string, token: Token | undefined, line: SourceLine): never {
	fail(`Unknown ${kind} directive \"${token?.value ?? ""}\".`, line);
}

function tokensEqual(tokens: Token[], values: string[]): boolean {
	return (
		tokens.length === values.length &&
		tokens.every((token, index) => !token.quoted && token.value === values[index])
	);
}

function braceNet(line: SourceLine): number {
	let net = 0;
	for (const token of line.tokens) {
		if (token.quoted) continue;
		if (token.value === "{") net += 1;
		if (token.value === "}") net -= 1;
	}
	return net;
}

function fail(message: string, line: SourceLine): never {
	throw new BookkeepingDslError(message, line.number);
}
