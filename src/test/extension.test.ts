import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { estimateReadingTime, extractFrontmatter, githubSlugify, renderFrontmatterTable, renderMarkdown, wrapHtmlDocument } from '../extension';

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

suite('heading ID generation', () => {
  test('h2 heading gets GitHub-compatible id', () => {
    const html = renderMarkdown('## Hello World\n');
    assert.match(html, /<h2 id="hello-world">/);
  });

  test('all heading levels receive id attributes', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n';
    const html = renderMarkdown(md);
    assert.match(html, /<h1 id="h1">/);
    assert.match(html, /<h2 id="h2">/);
    assert.match(html, /<h3 id="h3">/);
    assert.match(html, /<h4 id="h4">/);
    assert.match(html, /<h5 id="h5">/);
    assert.match(html, /<h6 id="h6">/);
  });

  test('duplicate headings get numeric suffixes', () => {
    const html = renderMarkdown('## Dupe\n## Dupe\n## Dupe\n');
    assert.match(html, /<h2 id="dupe">/);
    assert.match(html, /<h2 id="dupe-1">/);
    assert.match(html, /<h2 id="dupe-2">/);
  });

  test('punctuation is stripped from slugs', () => {
    const slug = githubSlugify('Hello, World! (2026)');
    assert.strictEqual(slug, 'hello-world-2026');
  });

  test('unicode characters are preserved in slugs', () => {
    const slug = githubSlugify('Ünïcödé Heading');
    assert.strictEqual(slug, 'ünïcödé-heading');
  });

  test('inline code in headings is included in slug text', () => {
    const html = renderMarkdown('## The `render` function\n');
    assert.match(html, /<h2 id="the-render-function">/);
  });
});

suite('estimateReadingTime', () => {
  test('returns 1 for very short text', () => {
    assert.strictEqual(estimateReadingTime('hello world'), 1);
  });

  test('calculates minutes at 200 wpm', () => {
    const words = Array(400).fill('word').join(' ');
    assert.strictEqual(estimateReadingTime(words), 2);
  });

  test('rounds up partial minutes', () => {
    const words = Array(201).fill('word').join(' ');
    assert.strictEqual(estimateReadingTime(words), 2);
  });

  test('handles empty string', () => {
    assert.strictEqual(estimateReadingTime(''), 1);
  });
});

suite('wrapHtmlDocument enhancements', () => {
  test('includes reading time div when readingTime provided', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>', '', 3);
    assert.ok(html.includes('<div class="reading-time">3 min read</div>'));
  });

  test('omits reading time div when not provided', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>');
    assert.ok(!html.includes('reading-time'));
  });

  test('includes document-enhancements.mjs script tag', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>');
    assert.ok(html.includes('_assets/document-enhancements.mjs'));
  });
});

