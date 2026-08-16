#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadApplicationConfig, type ApplicationConfig } from "../app/config.ts";
import { ChannelActionRegistry } from "../app/channel-actions.ts";
import { ChannelUpdateReceiptStore } from "../app/channel-updates.ts";
import { ConversationCoordinator, dateInTimezone } from "../app/conversation.ts";
import { BookkeepingProfileService } from "../app/bookkeeping-profile.ts";
import { BookkeepingExportService } from "../app/bookkeeping-export.ts";
import {
	DEFAULT_BOOKKEEPING_PROFILE_PATH,
	DEFAULT_BOOKKEEPING_DSL_PATH,
	readBookkeepingDslFile,
	readBookkeepingProfileFile,
	serializeBookkeepingProfileFile,
	writeBookkeepingExportFile,
	writeBookkeepingProfileFile,
} from "../app/bookkeeping-files.ts";
import { ConfirmationStore } from "../app/confirmation.ts";
import { FinanceApplication } from "../app/finance-application.ts";
import { containsLikelyCredential } from "../app/input-security.ts";
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
import { createVoiceTranscriber } from "../runtime/voice/python-transcriber.ts";
import { loadTelegramConfig, type TelegramChannelConfig } from "./telegram-config.ts";
import { runFolksumTelegram } from "./telegram.ts";
import { runFolksumTui } from "./tui.ts";

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
	} else if (command === "members") {
		console.log(JSON.stringify(identities.listMembers(wealth.household.id), null, 2));
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
	} else if (command === "telegram") {
		await runTelegramCommand({
			wealth,
			identities,
			database,
			config,
			profiles,
			scheduler,
			outbox,
		});
	} else {
		throw new Error(
			`Unknown command "${command}". Use tui, chat, telegram, members, reminders, schedule, profile, or export.`,
		);
	}
} finally {
	database.close();
}

async function runTelegramCommand(input: {
	wealth: WealthService;
	identities: SessionIdentityService;
	database: WealthDatabase;
	config: ApplicationConfig;
	profiles: BookkeepingProfileService;
	scheduler: ReminderScheduler;
	outbox: NotificationOutbox;
}): Promise<void> {
	const modelId = input.config.model;
	if (!modelId) {
		throw new Error("A model is required for Telegram. Set model in the JSON config or FOLKSUM_MODEL.");
	}
	const telegramConfig = loadTelegramConfig();
	const voiceTranscriber = createVoiceTranscriber(input.config);
	input.database.transaction(() => {
		bindTelegramIdentities(input.wealth, input.identities, telegramConfig);
	});
	const { models, settingsController } = createModelServices(input.config);
	const application = new FinanceApplication(
		input.wealth,
		new ConfirmationStore(input.database),
		undefined,
		input.profiles,
	);
	const coordinator = new ConversationCoordinator({
		identities: input.identities,
		application,
		runtimeFactory: ({ scope, currentDate, onConfirmationRequired, onChoiceRequired }) =>
			createPiRuntime({
				provider: input.config.provider,
				modelId,
				application,
				identityService: input.identities,
				scope,
				currentDate,
				cardTrackingMode: input.wealth.getCardTrackingMode(),
				thinkingLevel: input.config.thinkingLevel,
				models,
				settingsController,
				onConfirmationRequired,
				onChoiceRequired,
			}),
	});
	await runFolksumTelegram({
		config: telegramConfig,
		coordinator,
		actions: new ChannelActionRegistry(),
		receipts: new ChannelUpdateReceiptStore(input.database),
		scheduler: input.scheduler,
		outbox: input.outbox,
		...(voiceTranscriber ? { voiceTranscriber } : {}),
	});
}

function bindTelegramIdentities(
	wealth: WealthService,
	identities: SessionIdentityService,
	config: Pick<TelegramChannelConfig, "identities">,
): void {
	for (const identity of config.identities) {
		const member = identities.getMember(identity.memberId);
		if (member.householdId !== wealth.household.id) {
			throw new IdentityError(
				`Telegram member "${identity.memberId}" belongs to another household.`,
			);
		}
		identities.ensureChannelIdentity({
			memberId: identity.memberId,
			channel: "telegram",
			externalId: identity.userId,
		});
	}
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
	if (action === "check-dsl" || action === "apply-dsl") {
		if (force || positional.length > 2) {
			throw new Error(`Usage: folksum profile ${action} [path]`);
		}
		const path = positional[1] ?? DEFAULT_BOOKKEEPING_DSL_PATH;
		const active = profiles.getActiveProfile(scope.householdId);
		const compiled = readBookkeepingDslFile(path, active.profile, process.cwd(), active.revision);
		if (action === "check-dsl") {
			console.log(
				JSON.stringify({
					status: "valid",
					expectedRevision: compiled.document.expectedRevision,
					categories: compiled.profile.categories.length,
					customFields: compiled.profile.customFields.length,
					categorizationRules: compiled.profile.categorizationRules.length,
					captureShortcuts: compiled.profile.captureShortcuts?.length ?? 0,
					exportProfiles: compiled.profile.exportProfiles.length,
				}),
			);
			return;
		}
		const result = profiles.activateProfile(scope, {
			profile: compiled.profile,
			expectedRevision: compiled.document.expectedRevision,
			source: "import",
		});
		console.log(
			JSON.stringify({
				status: result.duplicate ? "unchanged" : "activated",
				revision: result.active.revision,
				profileHash: result.active.profileHash,
				expectedRevision: result.active.revision,
			}),
		);
		return;
	}
	throw new Error(
		"Usage: folksum profile show | export [path] [--force] | apply [path] | check-dsl [path] | apply-dsl [path]",
	);
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
