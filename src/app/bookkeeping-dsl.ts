import {
	applyBookkeepingProfilePatch,
	BookkeepingProfileError,
	type BookkeepingCategoryDefinition,
	type BookkeepingExportProfileDefinition,
	type BookkeepingProfile,
	type BookkeepingProfilePatch,
	type CategorizationRuleDefinition,
	type CustomFieldDefinition,
	type CustomFieldValue,
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

type DeclarationKind = "category" | "field" | "rule" | "export";

const COLLECTION_NAMES = {
	category: "categories",
	field: "customFields",
	rule: "categorizationRules",
	export: "exportProfiles",
} as const;

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
		export: [],
	};
	const removals: Record<DeclarationKind, string[]> = {
		category: [],
		field: [],
		rule: [],
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
			for (index += 1; index < lines.length; index += 1) {
				const blockLine = lines[index];
				if (!blockLine) continue;
				if (tokensEqual(blockLine.tokens, ["}"])) {
					closed = true;
					break;
				}
				if (blockLine.tokens.some((token) => token.value === "{" || token.value === "}")) {
					fail("Nested blocks and trailing block tokens are not supported.", blockLine);
				}
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
	let descriptionContains: string | undefined;
	let categoryId: string | undefined;
	const fields: Record<string, CustomFieldValue> = {};
	for (const line of lines) {
		const [directive, ...args] = line.tokens;
		switch (directive?.value) {
			case "priority":
				priority = unique(priority, parseNonNegativeInteger(singleToken(args, line, "priority"), line), line, "priority");
				break;
			case "when": {
				if (args.length !== 4 || args[1]?.value !== "description" || args[2]?.value !== "contains") {
					fail('when syntax is: when <expense|income> description contains "text".', line);
				}
				const value = requireBare(args[0], line, "Transaction kind");
				if (value !== "expense" && value !== "income") fail('when kind must be "expense" or "income".', line);
				transactionKind = unique(transactionKind, value, line, "when");
				descriptionContains = requireQuoted(args[3], line, "Description match");
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
			descriptionContains: required(descriptionContains, "when", openingLine),
		},
		assign: {
			...(categoryId ? { categoryId } : {}),
			...(Object.keys(fields).length > 0 ? { fields } : {}),
		},
	};
}

function parseExport(id: string, lines: SourceLine[], openingLine: SourceLine): BookkeepingExportProfileDefinition {
	let label: string | undefined;
	let format: "csv" | "json" | undefined;
	let rowMode: "transactions" | "postings" | undefined;
	let reversals: "include" | "exclude" | "only" | undefined;
	let amountSign: "debit-positive" | "credit-positive" | "absolute" | undefined;
	let delimiter: "," | ";" | "\t" | undefined;
	const categoryIds: string[] = [];
	const accountIds: string[] = [];
	const transactionSources: Array<"agent" | "manual" | "import" | "system"> = [];
	const columns: Array<{ header: string; source: BookkeepingExportProfileDefinition["columns"][number]["source"] }> = [];
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
			case "column":
				if (args.length !== 2) fail("column requires a quoted header and source.", line);
				columns.push({
					header: requireQuoted(args[0], line, "Column header"),
					source: requireBare(args[1], line, "Column source") as BookkeepingExportProfileDefinition["columns"][number]["source"],
				});
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
	return value === "category" || value === "field" || value === "rule" || value === "export";
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

function fail(message: string, line: SourceLine): never {
	throw new BookkeepingDslError(message, line.number);
}
