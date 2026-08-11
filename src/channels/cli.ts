import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { ConfirmationStore } from "../app/confirmation.ts";
import { FinanceApplication } from "../app/finance-application.ts";
import { MemoryRuleService } from "../app/memory.ts";
import { NotificationOutbox, ReminderScheduler } from "../app/scheduler.ts";
import { IdentityError, SessionIdentityService } from "../app/session.ts";
import { WealthDatabase } from "../core/database.ts";
import { WealthService } from "../core/wealth-service.ts";
import { createPiRuntime, type PiProviderId } from "../runtime/pi/runtime.ts";
import type { PiConfirmationRequest } from "../runtime/pi/tools.ts";

const databasePath = resolve(process.env.HWM_DB_PATH ?? ".data/wealth.db");
const database = new WealthDatabase(databasePath);

try {
	const wealth = new WealthService(database, {
		householdName: process.env.HWM_HOUSEHOLD_NAME ?? "My Household",
		baseCurrency: process.env.HWM_BASE_CURRENCY ?? "HKD",
	});
	const identities = new SessionIdentityService(database);
	const scope = ensureCliIdentity(wealth, identities);
	const memory = new MemoryRuleService(database);
	const outbox = new NotificationOutbox(database);
	const scheduler = new ReminderScheduler(wealth, memory, outbox);
	const command = process.argv[2] ?? "chat";
	const today = dateInTimezone(scope.timezone);

	if (command === "reminders") {
		printReminders(wealth.listCardReminders({ asOf: today }));
	} else if (command === "schedule") {
		const result = scheduler.run({ asOf: today, recipients: [scope] });
		console.log(JSON.stringify(result, null, 2));
	} else if (command === "chat") {
		printReminders(wealth.listCardReminders({ asOf: today }));
		await runChat({ wealth, identities, scope, database, today });
	} else {
		throw new Error(`Unknown command "${command}". Use chat, reminders, or schedule.`);
	}
} finally {
	database.close();
}

function ensureCliIdentity(wealth: WealthService, identities: SessionIdentityService) {
	const externalId = process.env.HWM_CLI_IDENTITY ?? "local-owner";
	const conversationKey = process.env.HWM_SESSION ?? "default";
	try {
		return identities.resolve({ channel: "cli", externalId, conversationKey });
	} catch (error) {
		if (!(error instanceof IdentityError) || !error.message.includes("is not registered")) throw error;
		const owner = identities.createMember({
			householdId: wealth.household.id,
			displayName: process.env.HWM_MEMBER_NAME ?? "Local Owner",
			role: "owner",
			timezone: process.env.HWM_TIMEZONE ?? "Asia/Hong_Kong",
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
}): Promise<void> {
	const modelId = process.env.HWM_MODEL;
	if (!modelId) throw new Error("HWM_MODEL is required for chat, for example an installed Pi model id.");
	const provider = parseProvider(process.env.HWM_PROVIDER ?? "openai");
	const application = new FinanceApplication(input.wealth, new ConfirmationStore(input.database));
	const pending: PiConfirmationRequest[] = [];
	const runtime = await createPiRuntime({
		provider,
		modelId,
		application,
		identityService: input.identities,
		scope: input.scope,
		currentDate: input.today,
		onConfirmationRequired: (request) => pending.push(request),
	});
	const readline = createInterface({ input: stdin, output: stdout });
	console.log(`Home Wealth Agent (${provider}/${modelId}). Type /exit to quit.`);

	try {
		while (true) {
			const text = (await readline.question("> ")).trim();
			if (!text) continue;
			if (text === "/exit" || text === "/quit") break;
			await runtime.prompt(text, (delta) => stdout.write(delta));
			stdout.write("\n");

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

function parseProvider(value: string): PiProviderId {
	if (value === "openai" || value === "anthropic" || value === "google") return value;
	throw new Error(`Unsupported HWM_PROVIDER "${value}". Use openai, anthropic, or google.`);
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
