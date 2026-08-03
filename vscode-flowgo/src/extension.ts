// Extension host entry point. Deliberately a near-no-op: all of the real
// work (finding ```flowgo fences in the rendered preview and hydrating
// them into live maps) happens in a plain DOM script — media/preview.js,
// built from src/previewEntry.ts / src/previewHydrate.ts — injected into
// VS Code's built-in Markdown preview webview via the
// `markdown.previewScripts` contribution point in package.json. That
// contribution point requires no activation-time wiring from this file;
// VS Code's Markdown extension loads the contributed script directly
// whenever a preview is shown.
//
// This file exists so the extension has a normal activate/deactivate
// lifecycle to hang future functionality off (e.g. a command, a status
// bar item) without needing to restructure anything.
import * as vscode from "vscode";

export function activate(_context: vscode.ExtensionContext): void {
  // No-op: see module comment above.
}

export function deactivate(): void {
  // No-op.
}
