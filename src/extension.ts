import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import MarkdownIt from 'markdown-it';
import { PreviewServer } from './previewServer';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false
});

export function activate(context: vscode.ExtensionContext): void {
  const previewServer = new PreviewServer();
  context.subscriptions.push(previewServer);

  const cmd = vscode.commands.registerCommand(
    'openMdInBrowser.open',
    async (uri?: vscode.Uri) => {
      try {
        const target = await resolveTarget(uri);
        if (!target) {
          vscode.window.showErrorMessage('Open in Browser: no Markdown file selected.');
          return;
        }
        const sourcePath = target.fsPath;
        const sourceDir = path.resolve(path.dirname(sourcePath));
        const sourceContent = await fs.promises.readFile(sourcePath, 'utf8');

        const bodyHtml = md.render(sourceContent);
        const title = escapeHtml(path.basename(sourcePath));
        const css = loadGithubMarkdownCss(context);
        const html = wrapHtmlDocument(title, css, bodyHtml);

        const localUri = await previewServer.publish(html, sourceDir);
        const externalUri = await vscode.env.asExternalUri(localUri);
        const ok = await vscode.env.openExternal(externalUri);
        if (!ok) {
          vscode.window.showErrorMessage(
            `Open in Browser: failed to launch the default browser. Open this URL manually: ${externalUri.toString()}`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Open in Browser: ${msg}`);
      }
    }
  );
  context.subscriptions.push(cmd);
}

export function deactivate(): void { /* server disposed via context.subscriptions */ }

async function resolveTarget(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri && uri.scheme === 'file') {
    return uri;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }
  return undefined;
}

function wrapHtmlDocument(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 32px; }
    ${css}
  </style>
</head>
<body class="markdown-body">
${body}
</body>
</html>`;
}

function loadGithubMarkdownCss(context: vscode.ExtensionContext): string {
  const cssPath = path.join(
    context.extensionPath,
    'node_modules',
    'github-markdown-css',
    'github-markdown.css'
  );
  try {
    return fs.readFileSync(cssPath, 'utf8');
  } catch {
    return '/* github-markdown-css not found; falling back to no styles */';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}
