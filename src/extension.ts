import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { PreviewServer, CONTENT_SECURITY_POLICY } from './previewServer';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false
});

addHeadingIds(md);

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

export function githubSlugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u0080-\uFFFF-]/g, '');
}

function addHeadingIds(md: MarkdownIt): void {
  md.core.ruler.push('heading_ids', (state) => {
    const slugCounts: Record<string, number> = {};
    for (let idx = 0; idx < state.tokens.length; idx++) {
      const token = state.tokens[idx];
      if (token.type !== 'heading_open') { continue; }
      const inlineToken = state.tokens[idx + 1];
      const text = inlineToken?.children
        ?.filter(t => t.type === 'text' || t.type === 'code_inline')
        .map(t => t.content)
        .join('') ?? '';
      let slug = githubSlugify(text);
      if (slug in slugCounts) {
        slugCounts[slug]++;
        slug = `${slug}-${slugCounts[slug]}`;
      } else {
        slugCounts[slug] = 0;
      }
      token.attrSet('id', slug);
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const previewServer = new PreviewServer({ extensionPath: context.extensionPath });
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
        const html = wrapHtmlDocument(title, bodyHtml);

        const mdRenderer = (fsPath: string, rawContent: string): string => {
          const { body: linkedBody, data: linkedData } = extractFrontmatter(rawContent);
          const linkedBodyHtml = renderFrontmatterTable(linkedData) + md.render(linkedBody);
          const linkedTitleText = typeof linkedData.title === 'string' && linkedData.title.trim()
            ? linkedData.title
            : path.basename(fsPath);
          const linkedTitle = escapeHtml(linkedTitleText);
          const fileDir = path.dirname(fsPath);
          const relToRoot = path.relative(fileDir, sourceDir);
          const assetBase = relToRoot
            ? relToRoot.split(path.sep).join('/') + '/'
            : '';
          return wrapHtmlDocument(linkedTitle, linkedBodyHtml, assetBase);
        };

        const localUri = await previewServer.publish(html, sourceDir, mdRenderer);
        const externalUri = await vscode.env.asExternalUri(localUri);
        previewServer.addAllowedHost(externalUri.authority);
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

export function wrapHtmlDocument(title: string, body: string, assetBase: string = ''): string {
  if (assetBase && !/^(\.\.\/)+$/.test(assetBase)) {
    assetBase = '';
  }
  // Stylesheets and scripts use document-relative paths so they inherit the
  // per-publish path-prefix token assigned by `PreviewServer.publish` and the
  // CSP `style-src 'self' / script-src 'self'` directives are satisfied
  // without inline blocks.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />
  <title>${title}</title>
  <link rel="stylesheet" href="${assetBase}_assets/github-markdown.css" />
  <link rel="stylesheet" href="${assetBase}_assets/preview.css" />
</head>
<body class="markdown-body">
${body}
<script type="module" src="${assetBase}_assets/mermaid-init.mjs"></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!
  );
}

export function extractFrontmatter(source: string): { body: string; data: Record<string, unknown> } {
  // Guard against thematic breaks (--- without a closing ---/... delimiter):
  // only invoke gray-matter when the source has a valid frontmatter block.
  // Strip BOM (Byte Order Mark) that some editors prepend to UTF-8 files before
  // checking the first line, so `---` is still recognised as the opening delimiter.
  const stripped = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const lines = stripped.replace(/\r\n/g, '\n').split('\n');
  const hasClosingDelimiter = lines[0] === '---' && lines.slice(1).some(l => l === '---' || l === '...');
  if (!hasClosingDelimiter) {
    return { body: source, data: {} };
  }
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
