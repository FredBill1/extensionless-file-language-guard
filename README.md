# Extensionless File Language Guard

Prevents VS Code's automatic language detection from reclassifying saved files that have no filename extension.

## Features

When enabled, saved extensionless documents are assigned the dedicated language `Extensionless Plain Text`. Because this is not VS Code's built-in `plaintext` language id, `workbench.editor.languageDetection` will not continue to infer another language for those files.

If you manually choose another language for an open extensionless file, the extension keeps that choice for the current open editor session. Close and reopen the file to apply the default guard again.

Untitled/new unsaved files keep VS Code's normal language detection behavior.

## Extension Settings

This extension contributes these settings:

- `extensionlessFileLanguageGuard.enabled`: Enable or disable the guard. Defaults to `true`.
- `extensionlessFileLanguageGuard.schemes`: URI schemes to guard. Defaults to `["file", "vscode-remote"]`.
- `extensionlessFileLanguageGuard.ignoredBasenames`: Exact case-sensitive basenames that keep normal VS Code behavior. Defaults to `[]`.
- `extensionlessFileLanguageGuard.showStatusMessages`: Show short status bar messages when documents are guarded or released. Defaults to `false`.

For common extensionless filenames that should keep their normal language support:

```json
{
  "extensionlessFileLanguageGuard.ignoredBasenames": ["Makefile", "Dockerfile"]
}
```

## Development

```sh
npm run compile
npm run lint
npm test
```
