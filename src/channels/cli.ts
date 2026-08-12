#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadApplicationConfig, type ApplicationConfig } from "../app/config.ts";
import { BookkeepingProfileService } from "../app/bookkeeping-profile.ts";
import { BookkeepingExportService } from "../app/bookkeeping-export.ts";
import {
	DEFAULT_BOOKKEEPING_PROFILE_PATH,
	readBookkeepingProfileFile,
	serializeBookkeepingProfileFile,
	writeBookkeepingExportFile,
	writeBookkeepingProfileFile,
} from "../app/bookkeeping-files.ts";
import { ConfirmationStore } from "../app/confirmation.ts";
import { FinanceApplication } from "../app/finance-application.ts";
import { MemoryRuleService } from "../app/memory.ts";
import { NotificationOutbox, ReminderScheduler } from "../app/scheduler.ts";
import { IdentityError, SessionIdentityService } from "../app/session.ts";
import { ApplicationSettingsController } from "../app/settings.ts";
import { WealthDatabase } from "../core/database.ts";
import { WealthService } from "../core/wealth-service.ts";
import { FileCredentialStore } from "../runtime/pi/credential-store.ts";
import { createFolksumModels } from "../runtime/pi/models.ts";
import { createPiRuntime } from "../runtime/pi/runtime.ts";
import { PiRuntimeSettingsController } from "../runtime/pi/settings.ts";
import type { PiConfirmationRequest } from "../runtime/pi/tools.ts";
import { containsLikelyCredential, runFolksumTui } from "./tui.ts";

const config = loadApplicationConfig();
const databasePath = resolve(config.databasePath);
const database = new WealthDatabase(databasePath);

try {
	const applicationSettingsController = new ApplicationSettingsController({ config });
	const wealth = new WealthService(database, {
		householdName: config.householdName,
		baseCurrency: config.baseCurrency,
		cardTrackingMode: applicationSettingsController.current().cardTrackingMode,
	});
	const identities = new SessionIdentityService(database);
	const scope = ensureCliIdentity(wealth, identities, config);
	const memory = new MemoryRuleService(database);
	const profiles = new BookkeepingProfileService(database);
	const exporter = new BookkeepingExportService(wealth, profiles);
	const outbox = new NotificationOutbox(database);
	const scheduler = new ReminderScheduler(wealth, memory, outbox);
	const command = process.argv[2] ?? "tui";
	const today = dateInTimezone(scope.timezone);

	if (command === "reminders") {
		printReminders(wealth.listCardReminders({ asOf: today }));
	} else if (command === "schedule") {
		const result = scheduler.run({ asOf: today, recipients: [scope] });
		console.log(JSON.stringify(result, null, 2));
	} else if (command === "profile") {
		runProfileCommand(profiles, scope, process.argv.slice(3));
	} else if (command === "export") {
		runExportCommand(exporter, scope.householdId, process.argv.slice(3));
	} else if (command === "tui") {
		const { models, settingsController } = createModelServices(config);
		await runFolksumTui({
			wealth,
			identities,
			scope,
			database,
			currentDate: today,
			config,
			models,
			settingsController,
			applicationSettingsController,
		});
	} else if (command === "chat") {
		printReminders(wealth.listCardReminders({ asOf: today }));
		const { models, settingsController } = createModelServices(config);
		await runChat({
			wealth,
			identities,
			scope,
			database,
			today,
			config,
			models,
			settingsController,
			profiles,
		});
	} else {
		throw new Error(`Unknown command "${command}". Use tui, chat, reminders, schedule, profile, or export.`);
	}
} finally {
	database.close();
}

function ensureCliIdentity(wealth: WealthService, identities: SessionIdentityService, config: ApplicationConfig) {
	const externalId = config.cliIdentity;
	const conversationKey = config.session;
	try {
		return identities.resolve({ channel: "cli", externalId, conversationKey });
	} catch (error) {
		if (!(error instanceof IdentityError) || !error.message.includes("is not registered")) throw error;
		const owner = identities.createMember({
			householdId: wealth.household.id,
			displayName: config.memberName,
			role: "owner",
			timezone: config.timezone,
		});
		identities.bindChannelIdentity({ memberId: owner.id, channel: "cli", externalId });
		return identities.resolve({ channel: "cli", externalId, conversationKey });
	}
}

async function runChat(input: {
	wealth: WealthService;
	identities: SessionIdentityService;
	scope: ReturnType<SessionIdentityService["resolve"]>;
	database: WealthDatabase;
	today: string;
	config: ApplicationConfig;
	models: ReturnType<typeof createFolksumModels>;
	settingsController: PiRuntimeSettingsController;
	profiles: BookkeepingProfileService;
}): Promise<void> {
	const modelId = input.config.model;
	if (!modelId) {
		throw new Error("A model is required for chat. Set model in the JSON config or FOLKSUM_MODEL.");
	}
	const provider = input.config.provider;
	const application = new FinanceApplication(
		input.wealth,
		new ConfirmationStore(input.database),
		undefined,
		input.profiles,
	);
	const pending: PiConfirmationRequest[] = [];
	const runtime = await createPiRuntime({
		provider,
		modelId,
		application,
		identityService: input.identities,
		scope: input.scope,
		currentDate: input.today,
		cardTrackingMode: input.wealth.getCardTrackingMode(),
		thinkingLevel: input.config.thinkingLevel,
		models: input.models,
		settingsController: input.settingsController,
		onConfirmationRequired: (request) => pending.push(request),
	});
	const readline = createInterface({ input: stdin, output: stdout });
	console.log(`Folksum — Financial Intelligence & Record Engine (${provider}/${modelId}). Type /exit to quit.`);

	try {
		while (true) {
			const text = (await readline.question("> ")).trim();
			if (!text) continue;
			if (text === "/exit" || text === "/quit") break;
			if (containsLikelyCredential(text)) {
				console.log("This input looks like a provider credential and was not sent or stored. Use the TUI login flow instead.");
				continue;
			}
			try {
				await runtime.prompt(text, (delta) => stdout.write(delta));
				stdout.write("\n");
			} catch {
				stdout.write("\nModel provider request failed. Check authentication and model settings, then retry.\n");
				continue;
			}

			while (pending.length > 0) {
				const request = pending.shift();
				if (!request) break;
				const answer = (await readline.question(`${request.summary} Confirm? [y/N] `)).trim().toLowerCase();
				if (answer === "y" || answer === "yes") {
					const result = runtime.confirm(request.confirmationToken);
					console.log(JSON.stringify({ status: result.status, result: result.status === "executed" ? result.result : null }, null, 2));
				} else {
					runtime.reject(request.pendingOperationId);
					console.log("Operation rejected.");
				}
			}
		}
	} finally {
		readline.close();
	}
}

function createModelServices(config: ApplicationConfig): {
	models: ReturnType<typeof createFolksumModels>;
	settingsController: PiRuntimeSettingsController;
} {
	const credentials = new FileCredentialStore();
	const models = createFolksumModels({ credentials });
	const settingsController = new PiRuntimeSettingsController({ models, config });
	return { models, settingsController };
}

function printReminders(reminders: ReturnType<WealthService["listCardReminders"]>): void {
	if (reminders.length === 0) {
		console.log("No credit-card repayments are due soon or overdue.");
		return;
	}
	console.log("Credit-card repayment reminders:");
	for (const reminder of reminders) {
		console.log(
			`- ${reminder.cardAccountName}: ${reminder.currency} ${reminder.outstandingAmount}, due ${reminder.dueDate} (${reminder.status})`,
		);
	}
}

function runProfileCommand(
	profiles: BookkeepingProfileService,
	scope: ReturnType<SessionIdentityService["resolve"]>,
	args: string[],
): void {
	const force = args.includes("--force");
	const positional = args.filter((argument) => argument !== "--force");
	const action = positional[0] ?? "show";
	if (action === "show") {
		if (positional.length > 1 || force) {
			throw new Error("Usage: folksum profile show");
		}
		stdout.write(serializeBookkeepingProfileFile(profiles.getActiveProfile(scope.householdId)));
		return;
	}
	if (action === "export") {
		if (positional.length > 2) {
			throw new Error("Usage: folksum profile export [path] [--force]");
		}
		const path = positional[1] ?? DEFAULT_BOOKKEEPING_PROFILE_PATH;
		const active = profiles.getActiveProfile(scope.householdId);
		const writtenPath = writeBookkeepingProfileFile(path, active, { overwrite: force });
		console.log(JSON.stringify({ status: "exported", path: writtenPath, revision: active.revision }));
		return;
	}
	if (action === "apply") {
		if (force || positional.length > 2) {
			throw new Error("Usage: folksum profile apply [path]");
		}
		const path = positional[1] ?? DEFAULT_BOOKKEEPING_PROFILE_PATH;
		const document = readBookkeepingProfileFile(path);
		const result = profiles.activateProfile(scope, {
			profile: document.profile,
			expectedRevision: document.expectedRevision,
			source: "import",
		});
		console.log(
			JSON.stringify({
				status: result.duplicate ? "unchanged" : "activated",
				revision: result.active.revision,
				profileHash: result.active.profileHash,
			}),
		);
		return;
	}
	throw new Error("Usage: folksum profile show | export [path] [--force] | apply [path]");
}

function runExportCommand(
	exporter: BookkeepingExportService,
	householdId: string,
	args: string[],
): void {
	const force = args.includes("--force");
	const positional = args.filter((argument) => argument !== "--force");
	if (positional.length < 3 || positional.length > 4 || (force && positional.length < 4)) {
		throw new Error("Usage: folksum export <profile-id> <from> <to> [output-path] [--force]");
	}
	const [exportProfileId, from, to, outputPath] = positional;
	if (!exportProfileId || !from || !to) {
		throw new Error("Usage: folksum export <profile-id> <from> <to> [output-path] [--force]");
	}
	const artifact = exporter.render({ householdId, exportProfileId, from, to });
	if (!outputPath) {
		stdout.write(artifact.content);
		return;
	}
	const writtenPath = writeBookkeepingExportFile(outputPath, artifact, { overwrite: force });
	console.log(
		JSON.stringify({
			status: "exported",
			path: writtenPath,
			format: artifact.format,
			rows: artifact.totalRows,
		}),
	);
}

function dateInTimezone(timezone: string): string {
	const parts = new Intl.DateTimeFormat("en", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const day = parts.find((part) => part.type === "day")?.value;
	if (!year || !month || !day) throw new Error(`Could not calculate date in timezone ${timezone}.`);
	return `${year}-${month}-${day}`;
}
