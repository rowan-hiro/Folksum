import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { BookkeepingExportArtifact } from "./bookkeeping-export.ts";
import {
	compileBookkeepingDsl,
	parseBookkeepingDsl,
	rewriteExpectedRevision,
	type BookkeepingDslDocument,
} from "./bookkeeping-dsl.ts";
import {
	BookkeepingProfileError,
	parseBookkeepingProfileJson,
	type ActiveBookkeepingProfile,
	type BookkeepingProfile,
} from "./bookkeeping-profile.ts";

export const BOOKKEEPING_PROFILE_FILE_FORMAT_VERSION = 1 as const;
export const DEFAULT_BOOKKEEPING_PROFILE_PATH = ".data/bookkeeping-profile.json";
export const DEFAULT_BOOKKEEPING_DSL_PATH = ".data/bookkeeping.folksum";

export interface BookkeepingProfileFileDocument {
	fileFormatVersion: typeof BOOKKEEPING_PROFILE_FILE_FORMAT_VERSION;
	expectedRevision: number;
	profile: BookkeepingProfile;
}

export interface WritePrivateFileOptions {
	overwrite?: boolean;
	cwd?: string;
}

export class BookkeepingFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BookkeepingFileError";
	}
}

export function parseBookkeepingProfileFile(
	text: string,
	source = "bookkeeping profile file",
): BookkeepingProfileFileDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(`Could not parse ${source}: ${reason}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new BookkeepingFileError(`${source} must contain a JSON object.`);
	}
	const record = parsed as Record<string, unknown>;
	const allowed = new Set(["fileFormatVersion", "expectedRevision", "profile"]);
	const unknown = Object.keys(record).find((key) => !allowed.has(key));
	if (unknown) throw new BookkeepingFileError(`${source} contains unknown property "${unknown}".`);
	if (record.fileFormatVersion !== BOOKKEEPING_PROFILE_FILE_FORMAT_VERSION) {
		throw new BookkeepingFileError(
			`Unsupported bookkeeping profile file format version "${String(record.fileFormatVersion)}".`,
		);
	}
	if (!Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 0) {
		throw new BookkeepingFileError(`${source} expectedRevision must be a non-negative integer.`);
	}
	try {
		return {
			fileFormatVersion: BOOKKEEPING_PROFILE_FILE_FORMAT_VERSION,
			expectedRevision: Number(record.expectedRevision),
			profile: parseBookkeepingProfileJson(JSON.stringify(record.profile), `${source} profile`),
		};
	} catch (error) {
		if (error instanceof BookkeepingProfileError) throw new BookkeepingFileError(error.message);
		throw error;
	}
}

export function serializeBookkeepingProfileFile(active: ActiveBookkeepingProfile): string {
	return `${JSON.stringify(
		{
			fileFormatVersion: BOOKKEEPING_PROFILE_FILE_FORMAT_VERSION,
			expectedRevision: active.revision,
			profile: active.profile,
		},
		null,
		"\t",
	)}\n`;
}

export function readBookkeepingProfileFile(path: string, cwd = process.cwd()): BookkeepingProfileFileDocument {
	const resolvedPath = resolve(cwd, path);
	let text: string;
	try {
		text = readFileSync(resolvedPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(`Could not read bookkeeping profile file ${resolvedPath}: ${reason}`);
	}
	return parseBookkeepingProfileFile(text, resolvedPath);
}

export function readBookkeepingDslFile(
	path: string,
	baseProfile: BookkeepingProfile,
	cwd = process.cwd(),
	activeRevision?: number,
): { document: BookkeepingDslDocument; profile: BookkeepingProfile } {
	const resolvedPath = resolve(cwd, path);
	let text: string;
	try {
		text = readFileSync(resolvedPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(`Could not read bookkeeping DSL file ${resolvedPath}: ${reason}`);
	}
	try {
		const document = parseBookkeepingDsl(text, resolvedPath);
		if (activeRevision !== undefined && document.expectedRevision !== activeRevision) {
			throw new BookkeepingFileError(
				`Bookkeeping DSL revision conflict: expected ${document.expectedRevision}, active revision is ${activeRevision}.`,
			);
		}
		return compileBookkeepingDsl(text, baseProfile, resolvedPath);
	} catch (error) {
		if (error instanceof BookkeepingFileError) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(reason);
	}
}

export function rewriteBookkeepingDslExpectedRevision(
	path: string,
	revision: number,
	options: { cwd?: string; text?: string } = {},
): string {
	const resolvedPath = resolve(options.cwd ?? process.cwd(), path);
	let text = options.text;
	if (text === undefined) {
		try {
			text = readFileSync(resolvedPath, "utf8");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new BookkeepingFileError(`Could not read bookkeeping DSL file ${resolvedPath}: ${reason}`);
		}
	}
	const next = rewriteExpectedRevision(text, revision, resolvedPath);
	if (next === text) return resolvedPath;
	const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, next, { encoding: "utf8", flag: "wx" });
		renameSync(temporaryPath, resolvedPath);
		return resolvedPath;
	} catch (error) {
		if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(
			`Activated profile revision ${revision}, but could not update expected-revision in ${resolvedPath}: ${reason}`,
		);
	}
}

export function writeBookkeepingProfileFile(
	path: string,
	active: ActiveBookkeepingProfile,
	options: WritePrivateFileOptions = {},
): string {
	return writePrivateFile(path, serializeBookkeepingProfileFile(active), options);
}

export function writeBookkeepingExportFile(
	path: string,
	artifact: Pick<BookkeepingExportArtifact, "content">,
	options: WritePrivateFileOptions = {},
): string {
	return writePrivateFile(path, artifact.content, options);
}

function writePrivateFile(path: string, content: string, options: WritePrivateFileOptions): string {
	const resolvedPath = resolve(options.cwd ?? process.cwd(), path);
	const directory = dirname(resolvedPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!options.overwrite) {
		try {
			writeFileSync(resolvedPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return resolvedPath;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new BookkeepingFileError(`Could not create ${resolvedPath}: ${reason}`);
		}
	}

	const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, resolvedPath);
		return resolvedPath;
	} catch (error) {
		if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
		const reason = error instanceof Error ? error.message : String(error);
		throw new BookkeepingFileError(`Could not replace ${resolvedPath}: ${reason}`);
	}
}
