import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { estimateReadingTime, extractFrontmatter, extractToc, githubSlugify, parseHeadings, renderFrontmatterTable, renderMarkdown, wrapHtmlDocument } from '../extension';

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

  test('includes TOC sidebar when tocHtml provided', () => {
    const body = '## A\n## B\n## C\n## D';
    const toc = extractToc(body);
    assert.ok(toc.length > 0, 'extractToc should produce HTML for 4+ headings');
    const html = wrapHtmlDocument('Test', '<p>Content</p>', '', 2, toc);
    assert.ok(html.includes('<nav class="toc-sidebar"'), 'TOC nav should appear in final document');
    assert.ok(html.includes('href="#a"'), 'TOC link for heading A should be present');
    assert.ok(html.includes('<div class="reading-time">2 min read</div>'), 'reading time should coexist with TOC');
    assert.ok(html.includes('<p>Content</p>'), 'body content should be present');
  });
});

suite('extractToc', () => {
  test('returns empty string for fewer than 4 headings', () => {
    assert.strictEqual(extractToc('# One\n## Two\n## Three'), '');
  });

  test('generates TOC for 4+ headings', () => {
    const body = '## A\n## B\n## C\n## D';
    const toc = extractToc(body);
    assert.ok(toc.includes('<nav class="toc-sidebar"'));
    assert.ok(toc.includes('href="#a"'));
    assert.ok(toc.includes('href="#d"'));
  });

  test('handles duplicate headings with suffix', () => {
    const body = '## Foo\n## Foo\n## Foo\n## Bar';
    const toc = extractToc(body);
    assert.ok(toc.includes('href="#foo"'));
    assert.ok(toc.includes('href="#foo-1"'));
    assert.ok(toc.includes('href="#foo-2"'));
  });

  test('escapes HTML in heading text', () => {
    const body = '## <script>\n## Normal\n## Also\n## More';
    const toc = extractToc(body);
    assert.ok(toc.includes('&lt;script&gt;'));
    assert.ok(!toc.includes('<script>'));
  });

  test('excludes h5 and h6 headings', () => {
    const body = '## A\n## B\n## C\n##### Deep\n###### Deeper\n## D';
    const toc = extractToc(body);
    assert.ok(!toc.includes('deep'));
    assert.ok(!toc.includes('deeper'));
  });

  test('slug counter accounts for skipped h5/h6 headings with duplicate text', () => {
    // addHeadingIds assigns: h2 Foo -> "foo", h5 Foo -> "foo-1", h2 Foo -> "foo-2"
    // extractToc must produce the same slugs for the two h2 headings
    const body = '## Foo\n##### Foo\n## Foo\n## Bar';
    const toc = extractToc(body);
    assert.ok(toc.includes('href="#foo"'), 'first h2 Foo should be #foo');
    assert.ok(toc.includes('href="#foo-2"'), 'second h2 Foo should be #foo-2 (h5 consumed #foo-1)');
    assert.ok(!toc.includes('href="#foo-1"'), '#foo-1 belongs to the h5 and must not appear in TOC');
  });

  test('includes toc-level classes for indentation', () => {
    const body = '# Title\n## Sub\n### Deep\n#### Deeper';
    const toc = extractToc(body);
    assert.ok(toc.includes('toc-level-1'));
    assert.ok(toc.includes('toc-level-2'));
    assert.ok(toc.includes('toc-level-3'));
    assert.ok(toc.includes('toc-level-4'));
  });
});

suite('parseHeadings', () => {
  test('returns one entry per heading with correct level, text, and slug', () => {
    const MarkdownIt = require('markdown-it');
    const mi = new MarkdownIt();
    const tokens = mi.parse('# Hello\n## World', {});
    const headings = parseHeadings(tokens);
    assert.strictEqual(headings.length, 2);
    assert.deepStrictEqual(headings[0], { level: 1, text: 'Hello', slug: 'hello' });
    assert.deepStrictEqual(headings[1], { level: 2, text: 'World', slug: 'world' });
  });

  test('includes all heading levels including h5 and h6', () => {
    const MarkdownIt = require('markdown-it');
    const mi = new MarkdownIt();
    const tokens = mi.parse('## A\n##### B\n###### C', {});
    const headings = parseHeadings(tokens);
    assert.strictEqual(headings.length, 3);
    assert.strictEqual(headings[0].level, 2);
    assert.strictEqual(headings[1].level, 5);
    assert.strictEqual(headings[2].level, 6);
  });

  test('deduplicates slugs across all levels', () => {
    const MarkdownIt = require('markdown-it');
    const mi = new MarkdownIt();
    const tokens = mi.parse('## Foo\n##### Foo\n## Foo', {});
    const headings = parseHeadings(tokens);
    assert.strictEqual(headings[0].slug, 'foo');
    assert.strictEqual(headings[1].slug, 'foo-1');
    assert.strictEqual(headings[2].slug, 'foo-2');
  });

  test('returns empty array for body with no headings', () => {
    const MarkdownIt = require('markdown-it');
    const mi = new MarkdownIt();
    const tokens = mi.parse('Just a paragraph.', {});
    assert.deepStrictEqual(parseHeadings(tokens), []);
  });
});

suite('collapsible sections integration', () => {
  test('includes collapsible-sections.mjs script tag', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>');
    assert.ok(html.includes('_assets/collapsible-sections.mjs'));
  });

  test('uses correct assetBase for collapsible-sections.mjs', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>', '../');
    assert.ok(html.includes('../_assets/collapsible-sections.mjs'));
  });
});

suite('heading search integration', () => {
  test('includes heading-search.mjs script tag', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>');
    assert.ok(html.includes('_assets/heading-search.mjs'));
  });

  test('uses correct assetBase for heading-search.mjs', () => {
    const html = wrapHtmlDocument('Test', '<p>Hello</p>', '../');
    assert.ok(html.includes('../_assets/heading-search.mjs'));
  });
});

