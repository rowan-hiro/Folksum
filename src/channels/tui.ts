import {
	Container,
	Editor,
	Input,
	Key,
	ProcessTerminal,
	ScrollView,
	SelectList,
	SettingsList,
	Text,
	TuiAltScreen,
	VStack,
	matchesKey,
	stripTerminalSequences,
	type Component,
	type EditorTheme,
	type OverlayHandle,
	type SelectItem,
	type SelectListTheme,
	type SettingsListTheme,
	type Terminal,
} from "@earendil-works/pi-tui";

import type { ApplicationConfig, RuntimeThinkingLevel } from "../app/config.ts";
import { ConfirmationStore } from "../app/confirmation.ts";
import { FinanceApplication } from "../app/finance-application.ts";
import type { IdentityScope } from "../app/identity.ts";
import { SessionIdentityService } from "../app/session.ts";
import { WealthDatabase } from "../core/database.ts";
import { WealthService } from "../core/wealth-service.ts";
import { SUPPORTED_PI_PROVIDERS, type SupportedPiProviderId } from "../runtime/pi/models.ts";
import {
	createPiRuntime,
	type PiRuntimeAdapter,
	type PiRuntimeConfig,
} from "../runtime/pi/runtime.ts";
import {
	PiRuntimeSettingsController,
	type RuntimeSettingsSnapshot,
} from "../runtime/pi/settings.ts";
import type { PiConfirmationRequest } from "../runtime/pi/tools.ts";

type Models = PiRuntimeSettingsController["models"];
type AuthInteraction = Parameters<Models["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];
type AuthCheck = Awaited<ReturnType<Models["checkAuth"]>>;
type AuthType = Parameters<Models["login"]>[1];

const THINKING_LEVELS: RuntimeThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const plain = (text: string): string => text;

export const TUI_SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => `> ${text}`,
	selectedText: plain,
	description: plain,
	scrollInfo: plain,
	noMatch: plain,
};

const EDITOR_THEME: EditorTheme = {
	borderColor: plain,
	selectList: TUI_SELECT_THEME,
};

const SETTINGS_THEME: SettingsListTheme = {
	label: plain,
	value: plain,
	description: plain,
	cursor: "> ",
	hint: plain,
};

export interface RunHomeWealthTuiInput {
	wealth: WealthService;
	identities: SessionIdentityService;
	scope: IdentityScope;
	database: WealthDatabase;
	currentDate: string;
	config: ApplicationConfig;
	models: Models;
	settingsController: PiRuntimeSettingsController;
	terminal?: Terminal;
	runtimeFactory?: (config: PiRuntimeConfig) => Promise<PiRuntimeAdapter>;
}

export interface SafeAuthStatus {
	type: "api_key" | "oauth";
	source?: string;
}

interface AuthViewState {
	configured: boolean;
	label: string;
}

interface SettingsViewState {
	settings: SettingsList;
	panel: LockableSettingsPanel;
	activeProvider: SupportedPiProviderId;
	auth: AuthViewState;
	authGeneration: number;
}

/** Single-line input whose rendered output never contains its underlying value. */
export class SecretInput extends Input {
	override render(width: number): string[] {
		const secret = this.getValue();
		this.setValue("•".repeat(secret.length));
		try {
			return super.render(width);
		} finally {
			this.setValue(secret);
		}
	}
}

export function formatAuthStatus(auth: SafeAuthStatus | undefined): string {
	if (!auth) return "not configured";
	const source = auth.source ? safeDisplayText(auth.source, 80) : undefined;
	return source ? `${auth.type} via ${source}` : auth.type;
}

export function containsLikelyCredential(text: string): boolean {
	return /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/u.test(text);
}

export async function runHomeWealthTui(input: RunHomeWealthTuiInput): Promise<void> {
	const app = new HomeWealthTui(input);
	await app.run();
}

class HomeWealthTui {
	private readonly input: RunHomeWealthTuiInput;
	private readonly tui: TuiAltScreen;
	private readonly transcript = new Container();
	private readonly status = new Text();
	private readonly editor: Editor;
	private readonly application: FinanceApplication;
	private readonly runtimeFactory: (config: PiRuntimeConfig) => Promise<PiRuntimeAdapter>;
	private runtime: PiRuntimeAdapter | undefined;
	private settingsOverlay: OverlayHandle | undefined;
	private settingsView: SettingsViewState | undefined;
	private openingSettings = false;
	private pendingConfirmations: PiConfirmationRequest[] = [];
	private cancelActivePrompt: (() => void) | undefined;
	private activeAuthAbort: AbortController | undefined;
	private activeAuthOperation: Promise<unknown> | undefined;
	private activeInteractionAbort: AbortController | undefined;
	private activeInteraction: Promise<void> | undefined;
	private modelRequestActive = false;
	private lastAuthStatus = "checking";
	private statusGeneration = 0;
	private busy = false;
	private shuttingDown = false;
	private finish: (() => void) | undefined;

	constructor(input: RunHomeWealthTuiInput) {
		this.input = input;
		this.tui = new TuiAltScreen(input.terminal ?? new ProcessTerminal());
		this.editor = new Editor(this.tui, EDITOR_THEME, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.application = new FinanceApplication(input.wealth, new ConfirmationStore(input.database));
		this.runtimeFactory = input.runtimeFactory ?? createPiRuntime;

		const scroll = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
		});
		const root = new VStack(
			[
				{ component: new Text("Home Wealth Manager"), basis: "auto", shrink: 0 },
				{ component: this.status, basis: "auto", shrink: 0 },
				{ component: scroll, basis: 0, grow: 1, minSize: 3 },
				{
					component: new Text(
						"Ctrl+O settings · /login · /logout · /help · Ctrl+C abort/exit",
					),
					basis: "auto",
					shrink: 0,
				},
				{ component: this.editor, basis: "auto", minSize: 1 },
			],
			{ gap: 1 },
		);
		this.tui.setLayoutRoot(root);
	}

	async run(): Promise<void> {
		this.restoreVisibleHistory();
		this.appendReminders();
		this.append("System", "Type a finance request, or open settings with Ctrl+O.");
		this.editor.onSubmit = (text) => void this.handleSubmit(text);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => this.handleGlobalInput(data));

		const onSignal = (): void => void this.shutdown();
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		process.once("SIGHUP", onSignal);

		const completed = new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		this.tui.start();
		void this.refreshStatus();
		try {
			await completed;
		} finally {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			process.removeListener("SIGHUP", onSignal);
		}
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, Key.ctrl("o"))) {
			if (!this.busy) void this.openSettings();
			return { consume: true };
		}
		if (!matchesKey(data, Key.ctrl("c"))) return undefined;

		if (this.cancelActivePrompt) {
			this.cancelActivePrompt();
		} else if (this.activeAuthAbort) {
			this.activeAuthAbort.abort();
		} else if (this.activeInteractionAbort) {
			this.activeInteractionAbort.abort();
			if (this.modelRequestActive) this.runtime?.abort();
			this.append("System", "Current model operation aborted.");
		} else if (this.busy) {
			this.append("System", "The current local operation is finishing and cannot be cancelled.");
		} else {
			void this.shutdown();
		}
		return { consume: true };
	}

	private async handleSubmit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text) return;
		if (this.busy) {
			this.append("System", "Wait for the current operation to finish, or press Ctrl+C to cancel it.");
			return;
		}

		switch (text.toLowerCase()) {
			case "/exit":
			case "/quit":
				await this.shutdown();
				return;
			case "/settings":
			case "/model":
				await this.openSettings();
				return;
			case "/login":
				await this.loginCurrentProvider();
				return;
			case "/logout":
				await this.logoutCurrentProvider();
				return;
			case "/help":
				this.append(
					"System",
					"Commands: /settings, /login, /logout, /help, /exit. Provider, model, and thinking level can also be changed by asking the assistant. Credentials are local-only and must use /login.",
				);
				return;
		}

		if (containsLikelyCredential(text)) {
			this.append(
				"System",
				"This message looks like a provider credential and was not sent or stored. Use /login instead.",
			);
			return;
		}
		this.setBusy(true);
		const abort = new AbortController();
		this.activeInteractionAbort = abort;
		const interaction = this.promptModel(text, abort.signal);
		this.activeInteraction = interaction;
		try {
			await interaction;
		} finally {
			if (this.activeInteraction === interaction) this.activeInteraction = undefined;
			if (this.activeInteractionAbort === abort) this.activeInteractionAbort = undefined;
			this.setBusy(false);
			await this.refreshStatus();
		}
	}

	private async promptModel(text: string, signal: AbortSignal): Promise<void> {
		if (this.shuttingDown) return;
		const selected = this.input.settingsController.current();
		if (!selected.model) {
			this.append("System", "Select a model in /settings before sending a prompt.");
			return;
		}
		let auth: AuthCheck;
		try {
			auth = await this.input.models.checkAuth(selected.provider, { signal });
		} catch {
			if (!signal.aborted) {
				this.append(
					"System",
					`Could not check authentication for ${selected.provider}. Verify the local auth store and try again.`,
				);
			}
			return;
		}
		if (this.shuttingDown || signal.aborted) return;
		if (!auth) {
			this.append("System", `Provider ${selected.provider} is not configured. Run /login.`);
			return;
		}

		if (!this.runtime) {
			try {
				const runtime = await this.runtimeFactory({
					provider: selected.provider,
					modelId: selected.model,
					application: this.application,
					identityService: this.input.identities,
					scope: this.input.scope,
					currentDate: this.input.currentDate,
					thinkingLevel: selected.thinkingLevel,
					models: this.input.models,
					settingsController: this.input.settingsController,
					onConfirmationRequired: (request) => this.pendingConfirmations.push(request),
				});
				this.runtime = runtime;
				if (this.shuttingDown || signal.aborted) {
					runtime.abort();
					return;
				}
			} catch {
				if (!signal.aborted) {
					this.append("System", "Could not start the model runtime. Check provider and model settings.");
				}
				return;
			}
		}
		if (signal.aborted) return;

		const beforeSettings = this.input.settingsController.current();
		this.append("You", text);
		const response = new Text("Assistant: ");
		this.transcript.addChild(response);
		let answer = "";
		this.modelRequestActive = true;
		try {
			await this.runtime.prompt(text, (delta) => {
				answer += delta;
				response.setText(`Assistant: ${sanitizeTerminalText(answer, 200_000)}`);
				this.tui.requestRender();
			});
			const afterSettings = this.input.settingsController.current();
			if (!sameSettings(beforeSettings, afterSettings)) {
				this.append("System", `Runtime settings updated: ${formatSettings(afterSettings)}.`);
			} else if (!answer.trim()) {
				response.setText("Assistant: No text response was returned.");
			}
			await this.processConfirmations();
		} catch (error) {
			response.setText(
				signal.aborted || isAbortError(error)
					? "Assistant: Model request cancelled."
					: "Assistant: Model provider request failed. Check authentication and model settings, then retry.",
			);
		} finally {
			this.modelRequestActive = false;
		}
	}

	private async processConfirmations(): Promise<void> {
		while (this.pendingConfirmations.length > 0) {
			const request = this.pendingConfirmations.shift();
			if (!request || !this.runtime) continue;
			let confirmed = false;
			try {
				confirmed =
					(await this.choose(
						`${request.summary}\nRisk: ${request.risk}. Confirm this operation?`,
						[
							{ value: "confirm", label: "Confirm" },
							{ value: "reject", label: "Reject" },
						],
					)) === "confirm";
			} catch {
				confirmed = false;
			}
			if (confirmed) {
				const result = this.runtime.confirm(request.confirmationToken);
				this.append("System", `Confirmed ${request.summary} (${result.status}).`);
			} else {
				this.runtime.reject(request.pendingOperationId);
				this.append("System", `Rejected ${request.summary}.`);
			}
		}
	}

	private async openSettings(): Promise<void> {
		if (this.settingsOverlay || this.openingSettings || this.busy || this.shuttingDown) return;
		this.openingSettings = true;
		try {
			const snapshot = this.input.settingsController.current();
			const auth = await this.readAuthState(snapshot.provider);
			if (this.shuttingDown) return;
			let view!: SettingsViewState;
			const items = [
				{
					id: "provider",
					label: "Provider",
					description: "Model provider. Environment overrides cannot be changed here.",
					currentValue: snapshot.provider,
					values: [...SUPPORTED_PI_PROVIDERS],
				},
				{
					id: "model",
					label: "Model",
					description: "Installed Pi model ID for the selected provider.",
					currentValue: snapshot.model ?? "not selected",
					submenu: (currentValue: string, done: (selectedValue?: string) => void): Component => {
						const choices = this.input.settingsController
							.listModels(view.activeProvider)
							.map((model) => ({
								value: model.id,
								label: model.name || model.id,
								description: model.id,
							}));
						const list = new SelectList(choices, 12, TUI_SELECT_THEME);
						list.setSelectedIndex(
							Math.max(0, choices.findIndex((item) => item.value === currentValue)),
						);
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done();
						return list;
					},
				},
				{
					id: "thinkingLevel",
					label: "Thinking level",
					description: "Requested reasoning level. The selected model may clamp unsupported levels.",
					currentValue: snapshot.thinkingLevel,
					values: [...THINKING_LEVELS],
				},
				{
					id: "authentication",
					label: "Authentication",
					description: "Credentials stay local and are never exposed to the model.",
					currentValue: auth.label,
					submenu: (_currentValue: string, done: (selectedValue?: string) => void): Component => {
						const choices = this.authActions(view.activeProvider, view.auth.configured);
						const list = new SelectList(choices, 6, TUI_SELECT_THEME);
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done();
						return list;
					},
				},
			];

			const settings = new SettingsList(
				items,
				10,
				SETTINGS_THEME,
				(id, value) => {
					view.panel.setLocked(true);
					this.tui.requestRender();
					void this.applySettingFromView(view, id, value);
				},
				() => this.closeSettings(),
			);
			const panel = new LockableSettingsPanel(settings);
			view = {
				settings,
				panel,
				activeProvider: snapshot.provider,
				auth,
				authGeneration: 0,
			};
			const overlay = this.tui.showOverlay(panel, {
				width: "75%",
				minWidth: 44,
				maxHeight: "80%",
				anchor: "center",
				margin: 1,
			});
			this.settingsView = view;
			this.settingsOverlay = overlay;
		} finally {
			this.openingSettings = false;
		}
	}

	private closeSettings(): void {
		if (this.settingsView) this.settingsView.authGeneration += 1;
		this.settingsView = undefined;
		this.settingsOverlay?.hide();
		this.settingsOverlay = undefined;
	}

	private async applySettingFromView(
		view: SettingsViewState,
		id: string,
		value: string,
	): Promise<void> {
		const revealTranscript = id === "authentication";
		const overlay = this.settingsOverlay;
		if (revealTranscript && this.settingsView === view) overlay?.setHidden(true);
		try {
			await this.applySetting(id, value);
			await this.synchronizeSettingsView(view);
		} catch (error) {
			this.append("System", safeError(error));
		} finally {
			if (this.settingsView === view) {
				view.panel.setLocked(false);
				if (revealTranscript) overlay?.setHidden(false);
				this.tui.requestRender();
			}
		}
	}

	private async synchronizeSettingsView(view: SettingsViewState): Promise<void> {
		if (this.settingsView !== view) return;
		const settings = this.input.settingsController.current();
		view.activeProvider = settings.provider;
		view.settings.updateValue("provider", settings.provider);
		view.settings.updateValue("model", settings.model ?? "not selected");
		view.settings.updateValue("thinkingLevel", settings.thinkingLevel);

		const generation = ++view.authGeneration;
		const auth = await this.readAuthState(settings.provider);
		if (
			this.settingsView !== view ||
			generation !== view.authGeneration ||
			this.input.settingsController.current().provider !== settings.provider
		) {
			return;
		}
		view.auth = auth;
		view.settings.updateValue("authentication", auth.label);
		this.tui.requestRender();
	}

	private async applySetting(id: string, value: string): Promise<void> {
		this.setBusy(true);
		try {
			if (id === "authentication") {
				if (value === "logout") await this.logoutCurrentProvider();
				else if (value.startsWith("login:")) await this.login(value.slice(6) as AuthType);
				return;
			}
			const patch =
				id === "provider"
					? { provider: value as SupportedPiProviderId }
					: id === "model"
						? { model: value }
						: { thinkingLevel: value as RuntimeThinkingLevel };
			const next = await this.input.settingsController.update(patch);
			this.append("System", `Runtime settings updated: ${formatSettings(next)}.`);
		} catch (error) {
			this.append("System", safeError(error));
		} finally {
			this.setBusy(false);
			await this.refreshStatus();
		}
	}

	private authActions(providerId: SupportedPiProviderId, configured: boolean): SelectItem[] {
		const provider = this.input.models.getProvider(providerId);
		const actions: SelectItem[] = [];
		if (provider?.auth.apiKey?.login) {
			actions.push({
				value: "login:api_key",
				label: `Sign in: ${provider.auth.apiKey.name}`,
			});
		}
		if (provider?.auth.oauth?.login) {
			actions.push({
				value: "login:oauth",
				label: provider.auth.oauth.loginLabel ?? `Sign in: ${provider.auth.oauth.name}`,
			});
		}
		if (configured) actions.push({ value: "logout", label: "Remove stored credential" });
		return actions.length > 0
			? actions
			: [{ value: "none", label: "No interactive login method", description: "Use provider environment credentials." }];
	}

	private async loginCurrentProvider(): Promise<void> {
		const providerId = this.input.settingsController.current().provider;
		const actions = this.authActions(providerId, false).filter((action) => action.value.startsWith("login:"));
		if (actions.length === 0) {
			this.append("System", `Provider ${providerId} has no interactive login method.`);
			return;
		}
		let action = actions[0]?.value;
		if (actions.length > 1) {
			try {
				action = await this.choose(`Authenticate ${providerId}`, actions);
			} catch {
				return;
			}
		}
		if (action?.startsWith("login:")) await this.login(action.slice(6) as AuthType);
	}

	private async login(type: AuthType): Promise<void> {
		const providerId = this.input.settingsController.current().provider;
		this.setBusy(true);
		const abort = new AbortController();
		this.activeAuthAbort = abort;
		try {
			const operation = this.input.models.login(providerId, type, {
				signal: abort.signal,
				prompt: (prompt) => this.promptForAuth(prompt, abort.signal),
				notify: (event) => this.showAuthEvent(event),
			});
			this.activeAuthOperation = operation;
			await operation;
			this.append("System", `Authentication saved for ${providerId}.`);
		} catch (error) {
			if (!isAbortError(error)) {
				this.append("System", `Authentication failed for ${providerId}. Retry the local login flow.`);
			}
			else this.append("System", `Authentication cancelled for ${providerId}.`);
		} finally {
			this.activeAuthAbort = undefined;
			this.activeAuthOperation = undefined;
			this.setBusy(false);
			await this.refreshStatus();
		}
	}

	private async logoutCurrentProvider(): Promise<void> {
		const providerId = this.input.settingsController.current().provider;
		let choice: string;
		try {
			choice = await this.choose(`Remove the stored credential for ${providerId}?`, [
				{ value: "cancel", label: "Cancel" },
				{ value: "logout", label: "Remove credential" },
			]);
		} catch {
			return;
		}
		if (choice !== "logout") return;
		this.setBusy(true);
		try {
			await this.input.models.logout(providerId);
			const remaining = await this.input.models.checkAuth(providerId);
			this.append(
				"System",
				remaining
					? `Stored credential removed; ${providerId} remains configured via ${formatAuthStatus(remaining)}.`
					: `Stored credential removed for ${providerId}.`,
			);
		} catch (error) {
			this.append("System", safeError(error));
		} finally {
			this.setBusy(false);
			await this.refreshStatus();
		}
	}

	private promptForAuth(prompt: AuthPrompt, parentSignal: AbortSignal): Promise<string> {
		const signal = prompt.signal ?? parentSignal;
		if (prompt.type === "select") {
			return this.choose(
				prompt.message,
				prompt.options.map((option) => ({
					value: option.id,
					label: option.label,
					...(option.description ? { description: option.description } : {}),
				})),
				signal,
			);
		}
		return this.readInput(prompt.message, prompt.type === "secret", signal);
	}

	private showAuthEvent(event: AuthEvent): void {
		switch (event.type) {
			case "auth_url":
				this.append(
					"Authentication",
					`${event.instructions ? `${safeDisplayText(event.instructions, 500)} ` : ""}Open ${event.url}`,
				);
				break;
			case "device_code":
				this.append(
					"Authentication",
					`Open ${event.verificationUri} and enter code ${event.userCode}.`,
				);
				break;
			case "info": {
				const links = event.links?.map((link) => `${link.label ?? "Open"}: ${link.url}`).join(" · ");
				this.append("Authentication", `${safeDisplayText(event.message, 500)}${links ? ` ${links}` : ""}`);
				break;
			}
			case "progress":
				this.append("Authentication", safeDisplayText(event.message, 500));
				break;
		}
	}

	private readInput(message: string, secret: boolean, signal?: AbortSignal): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const input = secret ? new SecretInput() : new Input();
			const panel = new DelegatingPrompt(message, input);
			const overlay = this.tui.showOverlay(panel, {
				width: "70%",
				minWidth: 40,
				maxHeight: 8,
				anchor: "center",
				margin: 1,
			});
			let settled = false;
			const settle = (value?: string, error?: Error): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.cancelActivePrompt = undefined;
				overlay.hide();
				if (error) reject(error);
				else resolve(value ?? "");
			};
			const cancel = (): void => settle(undefined, abortError());
			const onAbort = (): void => cancel();
			this.cancelActivePrompt = cancel;
			input.onSubmit = (value) => {
				if (value.trim()) settle(value);
			};
			input.onEscape = cancel;
			if (signal?.aborted) cancel();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private choose(message: string, items: SelectItem[], signal?: AbortSignal): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const list = new SelectList(items, Math.min(12, Math.max(1, items.length)), TUI_SELECT_THEME);
			const panel = new DelegatingPrompt(message, list);
			const overlay = this.tui.showOverlay(panel, {
				width: "70%",
				minWidth: 40,
				maxHeight: "70%",
				anchor: "center",
				margin: 1,
			});
			let settled = false;
			const settle = (value?: string, error?: Error): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.cancelActivePrompt = undefined;
				overlay.hide();
				if (error) reject(error);
				else resolve(value ?? "");
			};
			const cancel = (): void => settle(undefined, abortError());
			const onAbort = (): void => cancel();
			this.cancelActivePrompt = cancel;
			list.onSelect = (item) => settle(item.value);
			list.onCancel = cancel;
			if (signal?.aborted) cancel();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private restoreVisibleHistory(): void {
		const history = this.input.identities.loadMessages(this.input.scope.sessionId).slice(-20);
		for (const stored of history) {
			if (stored.role !== "user" && stored.role !== "assistant") continue;
			const text = extractMessageText(stored.content);
			if (text) this.append(stored.role === "user" ? "You" : "Assistant", text);
		}
	}

	private appendReminders(): void {
		const reminders = this.input.wealth.listCardReminders({ asOf: this.input.currentDate });
		if (reminders.length === 0) return;
		for (const reminder of reminders) {
			this.append(
				"Reminder",
				`${reminder.cardAccountName}: ${reminder.currency} ${reminder.outstandingAmount}, due ${reminder.dueDate} (${reminder.status}).`,
			);
		}
	}

	private append(role: string, message: string): void {
		this.transcript.addChild(new Text(`${role}: ${sanitizeTerminalText(message, 200_000)}`));
		this.tui.requestRender();
	}

	private async readAuthState(provider: SupportedPiProviderId): Promise<AuthViewState> {
		try {
			const auth = await this.input.models.checkAuth(provider);
			return { configured: auth !== undefined, label: formatAuthStatus(auth) };
		} catch {
			return { configured: false, label: "configuration error" };
		}
	}

	private async refreshStatus(): Promise<void> {
		const generation = ++this.statusGeneration;
		const settings = this.input.settingsController.current();
		const auth = await this.readAuthState(settings.provider);
		if (
			this.shuttingDown ||
			generation !== this.statusGeneration ||
			this.input.settingsController.current().provider !== settings.provider
		) {
			return;
		}
		this.lastAuthStatus = auth.label;
		this.renderStatus();
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.editor.disableSubmit = busy;
		this.renderStatus();
	}

	private renderStatus(): void {
		const settings = this.input.settingsController.current();
		this.status.setText(
			`${formatSettings(settings)} · auth ${this.lastAuthStatus}${this.busy ? " · busy" : ""}`,
		);
		this.tui.requestRender();
	}

	private async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.runtime?.abort();
		this.activeAuthAbort?.abort();
		this.activeInteractionAbort?.abort();
		this.cancelActivePrompt?.();
		this.closeSettings();
		await Promise.allSettled(
			[this.activeInteraction, this.activeAuthOperation].filter(
				(operation): operation is Promise<unknown> => operation !== undefined,
			),
		);
		try {
			await this.tui.terminal.drainInput(1_000, 50);
		} catch {
			// Terminal cleanup still proceeds when input draining is unavailable.
		}
		this.tui.stop();
		this.finish?.();
	}
}

class LockableSettingsPanel implements Component {
	private readonly settings: SettingsList;
	private locked = false;

	constructor(settings: SettingsList) {
		this.settings = settings;
	}

	setLocked(locked: boolean): void {
		this.locked = locked;
	}

	render(width: number): string[] {
		const lines = this.settings.render(width);
		return this.locked ? [...lines, "", SETTINGS_THEME.hint("  Applying…")] : lines;
	}

	handleInput(data: string): void {
		if (!this.locked) this.settings.handleInput(data);
	}

	invalidate(): void {
		this.settings.invalidate();
	}
}

class DelegatingPrompt implements Component {
	focused = false;
	private readonly message: string;
	private readonly child: Component;

	constructor(message: string, child: Component) {
		this.message = message;
		this.child = child;
	}

	render(width: number): string[] {
		if ("focused" in this.child) {
			(this.child as Component & { focused: boolean }).focused = this.focused;
		}
		return [safeDisplayText(this.message, 1_000), "", ...this.child.render(width)];
	}

	handleInput(data: string): void {
		if ("focused" in this.child) {
			(this.child as Component & { focused: boolean }).focused = this.focused;
		}
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

function formatSettings(settings: RuntimeSettingsSnapshot): string {
	return `${settings.provider}/${settings.model ?? "no model"} · thinking ${settings.thinkingLevel}`;
}

function sameSettings(left: RuntimeSettingsSnapshot, right: RuntimeSettingsSnapshot): boolean {
	return (
		left.provider === right.provider &&
		left.model === right.model &&
		left.thinkingLevel === right.thinkingLevel
	);
}

function extractMessageText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("content" in value)) return undefined;
	const content = value.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((item) => {
			if (typeof item !== "object" || item === null || !("type" in item) || item.type !== "text") return [];
			return "text" in item && typeof item.text === "string" ? [item.text] : [];
		})
		.join("");
	return text.trim() || undefined;
}

function safeDisplayText(value: string, maxLength: number): string {
	return sanitizeTerminalText(value, maxLength);
}

export function sanitizeTerminalText(value: string, maxLength: number): string {
	const stripped = stripTerminalSequences(value);
	const redacted = stripped.replace(
		/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/gu,
		"[credential redacted]",
	);
	const sanitized = redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return safeDisplayText(message, 500);
}

function abortError(): Error {
	const error = new Error("Operation cancelled.");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
