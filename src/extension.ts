import * as path from 'node:path';
import * as vscode from 'vscode';

export const configurationSection = 'extensionlessFileLanguageGuard';
export const extensionlessLanguageId = 'extensionless-plain-text';

const plaintextLanguageId = 'plaintext';
const defaultSchemes = ['file', 'vscode-remote'];

interface GuardConfiguration {
	readonly enabled: boolean;
	readonly schemes: ReadonlySet<string>;
	readonly ignoredBasenames: ReadonlySet<string>;
	readonly showStatusMessages: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
	const guard = new ExtensionlessFileLanguageGuard();

	context.subscriptions.push(guard);
	guard.start();
}

export function deactivate(): void {}

export function getUriBasename(uri: vscode.Uri): string {
	return path.posix.basename(uri.path);
}

export function isExtensionlessBasename(basename: string): boolean {
	return basename.length > 0 && path.posix.extname(basename) === '';
}

export function shouldGuardDocument(document: vscode.TextDocument, configuration = readConfiguration()): boolean {
	if (!configuration.enabled || document.isUntitled) {
		return false;
	}

	if (!configuration.schemes.has(document.uri.scheme)) {
		return false;
	}

	const basename = getUriBasename(document.uri);

	return isExtensionlessBasename(basename) && !configuration.ignoredBasenames.has(basename);
}

function readConfiguration(): GuardConfiguration {
	const configuration = vscode.workspace.getConfiguration(configurationSection);

	return {
		enabled: configuration.get<boolean>('enabled', true),
		schemes: new Set(readStringArray(configuration, 'schemes', defaultSchemes)),
		ignoredBasenames: new Set(readStringArray(configuration, 'ignoredBasenames', [])),
		showStatusMessages: configuration.get<boolean>('showStatusMessages', false),
	};
}

function readStringArray(configuration: vscode.WorkspaceConfiguration, key: string, fallback: readonly string[]): string[] {
	const value = configuration.get<unknown>(key);

	if (!Array.isArray(value)) {
		return [...fallback];
	}

	return value.filter((item): item is string => typeof item === 'string');
}

export class LanguageOverrideState {
	private readonly guardedDocuments = new Set<string>();
	private readonly inFlightDocuments = new Set<string>();
	private readonly manualLanguageOverrides = new Set<string>();
	private readonly pendingExternalLanguageChanges = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly guardedLanguageId: string,
		private readonly closeWindowMilliseconds = 0,
	) {}

	dispose(): void {
		this.guardedDocuments.clear();
		this.inFlightDocuments.clear();
		this.manualLanguageOverrides.clear();

		for (const timeout of this.pendingExternalLanguageChanges.values()) {
			clearTimeout(timeout);
		}

		this.pendingExternalLanguageChanges.clear();
	}

	isGuarded(key: string): boolean {
		return this.guardedDocuments.has(key);
	}

	markGuarded(key: string): void {
		this.guardedDocuments.add(key);
	}

	unmarkGuarded(key: string): void {
		this.guardedDocuments.delete(key);
	}

	isInFlight(key: string): boolean {
		return this.inFlightDocuments.has(key);
	}

	beginInFlight(key: string): void {
		this.inFlightDocuments.add(key);
	}

	endInFlight(key: string): void {
		this.inFlightDocuments.delete(key);
	}

	hasManualOverride(key: string): boolean {
		return this.manualLanguageOverrides.has(key);
	}

	shouldRespectManualOverride(key: string, languageId: string): boolean {
		if (!this.manualLanguageOverrides.has(key)) {
			return false;
		}

		if (languageId === this.guardedLanguageId) {
			this.manualLanguageOverrides.delete(key);
			return false;
		}

		return true;
	}

	handleOpen(key: string, languageId: string): boolean {
		const pendingLanguageChange = this.pendingExternalLanguageChanges.get(key);

		if (!pendingLanguageChange) {
			return true;
		}

		clearTimeout(pendingLanguageChange);
		this.pendingExternalLanguageChanges.delete(key);

		if (this.inFlightDocuments.has(key)) {
			return true;
		}

		if (languageId === this.guardedLanguageId) {
			this.manualLanguageOverrides.delete(key);
			return true;
		}

		this.manualLanguageOverrides.add(key);
		this.guardedDocuments.delete(key);

		return false;
	}

	handleClose(key: string): void {
		if (this.inFlightDocuments.has(key)) {
			return;
		}

		if (!this.guardedDocuments.has(key) && !this.manualLanguageOverrides.has(key)) {
			return;
		}

		const existingPendingLanguageChange = this.pendingExternalLanguageChanges.get(key);

		if (existingPendingLanguageChange) {
			clearTimeout(existingPendingLanguageChange);
		}

		const pendingLanguageChange = setTimeout(() => {
			this.pendingExternalLanguageChanges.delete(key);
			this.guardedDocuments.delete(key);
			this.manualLanguageOverrides.delete(key);
		}, this.closeWindowMilliseconds);

		this.pendingExternalLanguageChanges.set(key, pendingLanguageChange);
	}
}

class ExtensionlessFileLanguageGuard implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly documentState = new LanguageOverrideState(extensionlessLanguageId);
	private started = false;

	start(): void {
		if (this.started) {
			return;
		}

		this.started = true;

		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument(document => {
				this.onDidOpenTextDocument(document);
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				this.onDidCloseTextDocument(document);
			}),
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor) {
					void this.reconcileDocument(editor.document);
				}
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(configurationSection)) {
					void this.reconcileOpenDocuments();
				}
			}),
		);

		void this.reconcileOpenDocuments();
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}

		this.documentState.dispose();
	}

	private async reconcileOpenDocuments(): Promise<void> {
		const configuration = readConfiguration();

		await Promise.all(vscode.workspace.textDocuments.map(document => this.reconcileDocument(document, configuration)));
	}

	private async reconcileDocument(document: vscode.TextDocument, configuration = readConfiguration()): Promise<void> {
		const key = this.getDocumentKey(document);

		if (this.documentState.shouldRespectManualOverride(key, document.languageId)) {
			return;
		}

		if (shouldGuardDocument(document, configuration)) {
			await this.guardDocument(document, configuration);
		} else {
			await this.releaseDocument(document, configuration);
		}
	}

	private async guardDocument(document: vscode.TextDocument, configuration: GuardConfiguration): Promise<void> {
		const key = this.getDocumentKey(document);

		this.documentState.markGuarded(key);

		if (document.languageId === extensionlessLanguageId || this.documentState.isInFlight(key)) {
			return;
		}

		this.documentState.beginInFlight(key);

		try {
			await vscode.languages.setTextDocumentLanguage(document, extensionlessLanguageId);
			this.showStatusMessage(configuration, `Extensionless Plain Text: ${getUriBasename(document.uri)}`);
		} catch (error) {
			this.documentState.unmarkGuarded(key);
			console.error('Failed to set extensionless file language.', error);
		} finally {
			this.documentState.endInFlight(key);
		}
	}

	private async releaseDocument(document: vscode.TextDocument, configuration: GuardConfiguration): Promise<void> {
		const key = this.getDocumentKey(document);

		if (!this.documentState.isGuarded(key)) {
			return;
		}

		this.documentState.unmarkGuarded(key);

		if (document.languageId !== extensionlessLanguageId || this.documentState.isInFlight(key)) {
			return;
		}

		this.documentState.beginInFlight(key);

		try {
			await vscode.languages.setTextDocumentLanguage(document, plaintextLanguageId);
			this.showStatusMessage(configuration, `Plain Text: ${getUriBasename(document.uri)}`);
		} catch (error) {
			this.documentState.markGuarded(key);
			console.error('Failed to release extensionless file language.', error);
		} finally {
			this.documentState.endInFlight(key);
		}
	}

	private showStatusMessage(configuration: GuardConfiguration, message: string): void {
		if (configuration.showStatusMessages) {
			vscode.window.setStatusBarMessage(message, 2000);
		}
	}

	private getDocumentKey(document: vscode.TextDocument): string {
		return document.uri.toString();
	}

	private onDidOpenTextDocument(document: vscode.TextDocument): void {
		const key = this.getDocumentKey(document);

		if (!this.documentState.handleOpen(key, document.languageId)) {
			return;
		}

		void this.reconcileDocument(document);
	}

	private onDidCloseTextDocument(document: vscode.TextDocument): void {
		const key = this.getDocumentKey(document);

		this.documentState.handleClose(key);
	}
}
