import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { PreviewServer } from './previewServer';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
  if (info === 'mermaid') {
    // Escape HTML so the diagram source is preserved as text. Mermaid reads
    // the element's textContent, which decodes entities back to the original
    // characters (including literal `<br/>` in flowchart labels).
    const safe = escapeHtml(token.content);
    return `<pre class="mermaid">${safe}</pre>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

export function renderMarkdown(body: string): string {
  return md.render(body);
}

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

        const { body, data } = extractFrontmatter(sourceContent);
        const bodyHtml = renderFrontmatterTable(data) + md.render(body);
        const titleText = typeof data.title === 'string' && data.title.trim()
          ? data.title
          : path.basename(sourcePath);
        const title = escapeHtml(titleText);
        const css = loadGithubMarkdownCss(context);
        const includeMermaid = /<pre class="mermaid">/.test(bodyHtml);
        const html = wrapHtmlDocument(title, css, bodyHtml, { includeMermaid });

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

const MERMAID_VERSION = '11.14.0';
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
const MERMAID_SRI = 'sha384-1CMXl090wj8Dd6YfnzSQUOgWbE6suWCaenYG7pox5AX7apTpY3PmJMeS2oPql4Gk';
const MERMAID_INIT_PATH = './__open_md_in_browser__/mermaid-init.js';

function buildCspMeta(includeMermaid: boolean): string {
  const scriptSrc = includeMermaid ? "'self' https://cdn.jsdelivr.net" : "'self'";
  const policy = [
    "default-src 'none'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSrc}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ') + ';';
  return `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
}

function buildMermaidScript(): string {
  return `<script src="${MERMAID_URL}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>
<script src="${MERMAID_INIT_PATH}"></script>`;
}

function wrapHtmlDocument(
  title: string,
  css: string,
  body: string,
  options: { includeMermaid: boolean }
): string {
  const { includeMermaid } = options;
  const cspMeta = buildCspMeta(includeMermaid);
  const mermaidScript = includeMermaid ? `\n${buildMermaidScript()}` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  ${cspMeta}
  <title>${title}</title>
  <style>
    body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 32px; }
    .frontmatter-table { margin: 0 0 24px; font-size: 90%; }
    .frontmatter-table th { text-align: left; white-space: nowrap; width: 1%; }
    .frontmatter-table code { font-size: 90%; }
    pre.mermaid { background: transparent; padding: 0; text-align: center; }
    ${css}
  </style>
</head>
<body class="markdown-body">
${body}${mermaidScript}
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

export function extractFrontmatter(source: string): { body: string; data: Record<string, unknown> } {
  const parsed = matter(source);
  return { body: parsed.content, data: (parsed.data ?? {}) as Record<string, unknown> };
}

export function renderFrontmatterTable(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return '';
  }
  const rows = keys
    .map(k => `<tr><th scope="row">${escapeHtml(k)}</th><td>${renderValue(data[k])}</td></tr>`)
    .join('');
  return `<table class="frontmatter-table"><tbody>${rows}</tbody></table>\n`;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) { return ''; }
  if (v instanceof Date) { return escapeHtml(v.toISOString().slice(0, 10)); }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return escapeHtml(String(v));
  }
  try {
    return `<code>${escapeHtml(JSON.stringify(v))}</code>`;
  } catch {
    return escapeHtml(String(v));
  }
}
