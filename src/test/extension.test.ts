import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { configurationSection, extensionlessLanguageId, LanguageOverrideState } from '../extension';

suite('Extension Test Suite', function () {
	this.timeout(10000);

	let temporaryDirectory: string;
	let temporaryFileCounter = 0;

	suiteSetup(async () => {
		await activateExtension();
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensionless-language-guard-'));
	});

	suiteTeardown(async () => {
		await resetConfiguration();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	});

	setup(async () => {
		await resetConfiguration();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	teardown(async () => {
		await resetConfiguration();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('guards a saved file with no extension', async () => {
		const uri = await writeTemporaryFile('scriptlike', 'function run() {\n\treturn 1;\n}\n');

		await vscode.workspace.openTextDocument(uri);

		const document = await waitForLanguage(uri, extensionlessLanguageId);

		assert.strictEqual(document.languageId, extensionlessLanguageId);
	});

	test('does not guard a saved file with an extension', async () => {
		const uri = await writeTemporaryFile('sample.js', 'function run() {\n\treturn 1;\n}\n');
		const document = await vscode.workspace.openTextDocument(uri);

		await assertLanguageDoesNotBecome(uri, extensionlessLanguageId);

		assert.notStrictEqual(getOpenDocument(uri)?.languageId ?? document.languageId, extensionlessLanguageId);
	});

	test('does not guard an untitled document', async () => {
		const document = await vscode.workspace.openTextDocument({
			content: 'function run() {\n\treturn 1;\n}\n',
		});

		await assertLanguageDoesNotBecome(document.uri, extensionlessLanguageId);

		assert.notStrictEqual(getOpenDocument(document.uri)?.languageId ?? document.languageId, extensionlessLanguageId);
	});

	test('respects ignored basenames', async () => {
		await updateConfiguration('ignoredBasenames', ['Makefile', 'Dockerfile']);

		for (const basename of ['Makefile', 'Dockerfile']) {
			const uri = await writeTemporaryFile(basename, 'function run() {\n\treturn 1;\n}\n');
			const document = await vscode.workspace.openTextDocument(uri);

			await assertLanguageDoesNotBecome(uri, extensionlessLanguageId);

			assert.notStrictEqual(getOpenDocument(uri)?.languageId ?? document.languageId, extensionlessLanguageId);
		}
	});

	test('respects disabled configuration', async () => {
		await updateConfiguration('enabled', false);

		const uri = await writeTemporaryFile('disabled', 'function run() {\n\treturn 1;\n}\n');
		const document = await vscode.workspace.openTextDocument(uri);

		await assertLanguageDoesNotBecome(uri, extensionlessLanguageId);

		assert.notStrictEqual(getOpenDocument(uri)?.languageId ?? document.languageId, extensionlessLanguageId);
	});

	test('releases a guarded document after configuration changes', async () => {
		const uri = await writeTemporaryFile('release-me', 'function run() {\n\treturn 1;\n}\n');

		await vscode.workspace.openTextDocument(uri);
		await waitForLanguage(uri, extensionlessLanguageId);

		await updateConfiguration('ignoredBasenames', ['release-me']);
		const document = await waitForLanguageToNotBe(uri, extensionlessLanguageId);

		assert.notStrictEqual(document.languageId, extensionlessLanguageId);
	});

	test('keeps a manually selected language for the current open session', async () => {
		const uri = await writeTemporaryFile('manual-language', 'function run() {\n\treturn 1;\n}\n');

		await vscode.workspace.openTextDocument(uri);
		const guardedDocument = await waitForLanguage(uri, extensionlessLanguageId);

		await vscode.languages.setTextDocumentLanguage(guardedDocument, 'javascript');
		await waitForLanguage(uri, 'javascript');

		await updateConfiguration('showStatusMessages', true);
		await assertLanguageRemains(uri, 'javascript');
	});

	test('clears a manual language override after the document close window', async () => {
		const documentState = new LanguageOverrideState(extensionlessLanguageId);
		const key = 'file:///manual-close';

		try {
			documentState.markGuarded(key);
			documentState.handleClose(key);

			assert.strictEqual(documentState.handleOpen(key, 'javascript'), false);
			assert.strictEqual(documentState.hasManualOverride(key), true);

			documentState.handleClose(key);
			await delay(25);

			assert.strictEqual(documentState.hasManualOverride(key), false);
			assert.strictEqual(documentState.handleOpen(key, 'plaintext'), true);
		} finally {
			documentState.dispose();
		}
	});

	async function writeTemporaryFile(basename: string, content: string): Promise<vscode.Uri> {
		const directoryPath = path.join(temporaryDirectory, `${Date.now()}-${++temporaryFileCounter}`);
		const filePath = path.join(directoryPath, basename);

		await fs.mkdir(directoryPath);
		await fs.writeFile(filePath, content, 'utf8');

		return vscode.Uri.file(filePath);
	}
});

async function activateExtension(): Promise<void> {
	const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'extensionless-file-language-guard');

	assert.ok(extension, 'Expected the extension under test to be available.');

	await extension.activate();
}

async function resetConfiguration(): Promise<void> {
	await updateConfiguration('enabled', true);
	await updateConfiguration('schemes', ['file']);
	await updateConfiguration('ignoredBasenames', []);
	await updateConfiguration('showStatusMessages', false);
}

async function updateConfiguration(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration(configurationSection).update(key, value, vscode.ConfigurationTarget.Global);
}

async function waitForLanguage(uri: vscode.Uri, languageId: string): Promise<vscode.TextDocument> {
	const deadline = Date.now() + 5000;

	while (Date.now() < deadline) {
		const document = getOpenDocument(uri);

		if (document?.languageId === languageId) {
			return document;
		}

		await delay(50);
	}

	const actualLanguageId = getOpenDocument(uri)?.languageId ?? '<not open>';

	assert.fail(`Expected ${uri.toString()} to become ${languageId}, but it is ${actualLanguageId}.`);
}

async function waitForLanguageToNotBe(uri: vscode.Uri, languageId: string): Promise<vscode.TextDocument> {
	const deadline = Date.now() + 5000;

	while (Date.now() < deadline) {
		const document = getOpenDocument(uri);

		if (document && document.languageId !== languageId) {
			return document;
		}

		await delay(50);
	}

	assert.fail(`Expected ${uri.toString()} to stop being ${languageId}.`);
}

async function assertLanguageRemains(uri: vscode.Uri, languageId: string): Promise<void> {
	const deadline = Date.now() + 750;

	while (Date.now() < deadline) {
		assert.strictEqual(getOpenDocument(uri)?.languageId, languageId);
		await delay(50);
	}
}

async function assertLanguageDoesNotBecome(uri: vscode.Uri, languageId: string): Promise<void> {
	const deadline = Date.now() + 750;

	while (Date.now() < deadline) {
		assert.notStrictEqual(getOpenDocument(uri)?.languageId, languageId);
		await delay(50);
	}
}

function getOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
