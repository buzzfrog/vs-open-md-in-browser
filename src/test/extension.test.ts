import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractFrontmatter, renderFrontmatterTable } from '../extension';

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

