import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractFrontmatter, renderFrontmatterTable, renderMarkdown } from '../extension';

suite('openMdInBrowser', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'open-md-in-browser');
    await ext?.activate();
  });

  test('command is registered', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('openMdInBrowser.open'));
  });

  test('renders a Markdown document without throwing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-test-'));
    const tmpFile = path.join(tmpDir, 'sample.md');
    fs.writeFileSync(tmpFile, '# Hello\n\nWorld\n', 'utf8');
    const uri = vscode.Uri.file(tmpFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('openMdInBrowser.open', uri);
  });
});

suite('frontmatter helpers', () => {
  test('extracts YAML frontmatter and body', () => {
    const src = '---\ntitle: Hello\nms.date: 2026-04-23\n---\n\n# Heading\n';
    const { body, data } = extractFrontmatter(src);
    assert.strictEqual(body.trim(), '# Heading');
    assert.strictEqual(data.title, 'Hello');
  });

  test('renders a table with escaped keys and values', () => {
    const html = renderFrontmatterTable({ title: '<x>', tags: ['a', 'b'] });
    assert.match(html, /<table class="frontmatter-table">/);
    assert.match(html, /&lt;x&gt;/);
    assert.match(html, /\["a","b"\]/);
  });

  test('returns empty string when no frontmatter', () => {
    assert.strictEqual(renderFrontmatterTable({}), '');
  });

  test('leaves thematic break content intact', () => {
    const src = '---\n\nBody\n';
    const { body, data } = extractFrontmatter(src);
    assert.strictEqual(body, src);
    assert.deepStrictEqual(data, {});
  });

  test('tolerates BOM and CRLF', () => {
    const src = '\uFEFF---\r\ntitle: A\r\n---\r\nBody\r\n';
    const { body, data } = extractFrontmatter(src);
    assert.strictEqual(data.title, 'A');
    assert.match(body, /Body/);
  });
});

suite('mermaid fence rendering', () => {
  test('escapes angle brackets in diagram source', () => {
    const html = renderMarkdown('```mermaid\nE->>B: <port>\n```\n');
    assert.match(html, /<pre class="mermaid">/);
    assert.match(html, /&lt;port&gt;/);
    assert.ok(!/<port>/.test(html), 'raw <port> should not appear in output');
  });

  test('escapes <br/> so mermaid receives it as text', () => {
    const html = renderMarkdown('```mermaid\nflowchart LR\nA[x<br/>y]\n```\n');
    assert.match(html, /&lt;br\/&gt;/);
  });

  test('neutralizes </pre so the block cannot be broken out of', () => {
    const html = renderMarkdown('```mermaid\nfoo </pre bar\n```\n');
    assert.ok(!/<\/pre>\s*bar/.test(html), '</pre should be escaped');
    assert.match(html, /&lt;\/pre/);
  });

  test('escapes ampersands in diagram source', () => {
    const html = renderMarkdown('```mermaid\nA & B\n```\n');
    assert.match(html, /A &amp; B/);
  });
});

