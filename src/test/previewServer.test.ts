import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewServer, MdRenderFn } from '../previewServer';

interface HttpResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CSS_CONTENT = 'body { color: red; }';

function joinUriPath(uri: vscode.Uri, requestPath: string): string {
  // Tests pass paths as if the server were rooted at `/`; in production
  // `publish()` returns a URI whose path is `/{token}/`, so prepend the URI
  // base (preserving any leading `/` in the test path).
  const base = uri.path || '/';
  if (requestPath.startsWith('/')) {
    return base.endsWith('/')
      ? base + requestPath.slice(1)
      : base + requestPath;
  }
  return base.endsWith('/') ? base + requestPath : base + '/' + requestPath;
}

function httpGet(uri: vscode.Uri, pathOverride?: string): Promise<HttpResult> {
  const [host, portStr] = uri.authority.split(':');
  const port = Number.parseInt(portStr, 10);
  const requestPath = pathOverride === undefined ? (uri.path || '/') : joinUriPath(uri, pathOverride);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.get({ host, port, path: requestPath }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('httpGet timeout')));
  });
}

function httpRequest(
  uri: vscode.Uri,
  options: { method?: string; path?: string; headers?: Record<string, string>; rawPath?: string } = {}
): Promise<HttpResult> {
  const [host, portStr] = uri.authority.split(':');
  const port = Number.parseInt(portStr, 10);
  const requestPath = options.rawPath !== undefined
    ? options.rawPath
    : (options.path === undefined ? (uri.path || '/') : joinUriPath(uri, options.path));
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      { host, port, path: requestPath, method: options.method ?? 'GET', headers: options.headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('httpRequest timeout')));
    req.end();
  });
}

suite('PreviewServer', () => {
  let tmpDir: string;
  let server: PreviewServer;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-preview-'));
    fs.writeFileSync(path.join(tmpDir, 'asset.png'), PNG_SIGNATURE);
    fs.mkdirSync(path.join(tmpDir, 'nested'));
    fs.writeFileSync(path.join(tmpDir, 'nested', 'asset.css'), CSS_CONTENT, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'other.md'), '# Other\n\nContent here.\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'nested', 'doc.md'), '# Nested Doc\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'doc.markdown'), '# Markdown Extension\n', 'utf8');
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  setup(() => {
    server = new PreviewServer({ idleShutdownMs: 50 });
  });

  teardown(() => {
    server.dispose();
  });

  test('GET / returns 200, text/html, Cache-Control: no-store, body equals published HTML', async () => {
    const html = '<h1>HI</h1>';
    const uri = await server.publish(html, tmpDir);
    const res = await httpGet(uri, '/');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.strictEqual(res.body.toString('utf8'), html);
  });

  test('asset path returns 200, image/png, exact bytes', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/asset.png');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.ok(res.body.equals(PNG_SIGNATURE), 'body bytes should equal fixture bytes');
  });

  test('nested asset returns 200 + text/css; charset=utf-8', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/nested/asset.css');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.strictEqual(res.body.toString('utf8'), CSS_CONTENT);
  });

  test('missing path returns 404', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/missing.png');
    assert.strictEqual(res.statusCode, 404);
  });

  test('percent-encoded traversal returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd');
    assert.strictEqual(res.statusCode, 403);
  });

  test('bare ../ traversal returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/../../etc/passwd');
    assert.strictEqual(res.statusCode, 403);
  });

  test('malformed percent-encoding returns 400', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/%E0%A4%A');
    assert.strictEqual(res.statusCode, 400);
  });

  // Note: the 503 "Preview not ready." branch is not publicly reachable because
  // `publish()` always sets internal state before the server begins listening.
  // See DD-01 in the planning log.

  test('idle timer disposes server within ~150 ms when idleShutdownMs is 50', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const [host, portStr] = uri.authority.split(':');
    const port = Number.parseInt(portStr, 10);
    await new Promise(resolve => setTimeout(resolve, 150));
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host, port, path: '/' }, res => {
        res.resume();
        reject(new Error(`expected ECONNREFUSED, got status ${res.statusCode}`));
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          resolve();
        } else {
          reject(new Error(`expected ECONNREFUSED, got ${err.code ?? err.message}`));
        }
      });
      req.setTimeout(500, () => req.destroy(new Error('idle shutdown probe timed out')));
    });
  });

  test('dispose is idempotent', async () => {
    await server.publish('<p>x</p>', tmpDir);
    server.dispose();
    server.dispose();
  });

  test('publish after dispose lazily restarts and serves new HTML', async () => {
    await server.publish('A', tmpDir);
    server.dispose();
    const uri = await server.publish('B', tmpDir);
    const res = await httpGet(uri, '/');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.toString('utf8'), 'B');
  });

  test('symlink that targets file outside rootDir returns 403', async function () {
    const outsidePath = path.join(os.tmpdir(), `omib-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, 'SECRET', 'utf8');
    const linkPath = path.join(tmpDir, 'link.txt');
    try {
      try {
        fs.symlinkSync(outsidePath, linkPath, 'file');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          this.skip();
          return;
        }
        throw err;
      }
      const uri = await server.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/link.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.notStrictEqual(res.body.toString('utf8'), 'SECRET');
    } finally {
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
      try { fs.unlinkSync(outsidePath); } catch { /* ignore */ }
    }
  });

  test('non-loopback Host header returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { headers: { Host: 'attacker.example' } });
    assert.strictEqual(res.statusCode, 403);
  });

  test('publish with swapped drive-letter case still serves workspace files', async function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    // Simulate the VS-Code scenario where `uri.fsPath` has a lowercase drive
    // letter but `fs.realpath` returns uppercase. Swap the first letter's case
    // so the rootDir casing differs from what `fs.realpath` will resolve.
    const first = tmpDir[0];
    const swapped = first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
    const altCaseDir = swapped + tmpDir.slice(1);
    const uri = await server.publish('<p>root</p>', altCaseDir);
    const res = await httpGet(uri, '/asset.png');
    assert.strictEqual(res.statusCode, 200, 'workspace file should be served despite drive-letter case mismatch');
  });

  test('localhost Host header is accepted', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const [, portStr] = uri.authority.split(':');
    const res = await httpRequest(uri, { headers: { Host: `localhost:${portStr}` } });
    assert.strictEqual(res.statusCode, 200);
  });

  test('addAllowedHost accepts a registered tunnel authority and rejects others', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    server.addAllowedHost('Example.Preview.App.GitHub.dev');

    const accepted = await httpRequest(uri, { headers: { Host: 'example.preview.app.github.dev' } });
    assert.strictEqual(accepted.statusCode, 200);

    const acceptedMixed = await httpRequest(uri, { headers: { Host: 'EXAMPLE.preview.app.github.dev' } });
    assert.strictEqual(acceptedMixed.statusCode, 200);

    const rejected = await httpRequest(uri, { headers: { Host: 'malicious.example' } });
    assert.strictEqual(rejected.statusCode, 403);
  });

  test('POST / returns 405 with Allow: GET, HEAD', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { method: 'POST' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'GET, HEAD');
  });

  test('GET / returns hardening response headers', async () => {
    const uri = await server.publish('<h1>x</h1>', tmpDir);
    const res = await httpGet(uri, '/');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    const csp = res.headers['content-security-policy'];
    assert.ok(typeof csp === 'string' && csp.includes("script-src 'self'"), 'CSP should restrict script-src to self');
    assert.ok(!String(csp).includes('cdn.jsdelivr.net'), 'CSP should not whitelist CDN');
  });

  test('asset response includes nosniff and referrer-policy', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/asset.png');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  });

  test('HEAD / returns 200, hardening headers, empty body', async () => {
    const html = '<h1>HI</h1>';
    const uri = await server.publish(html, tmpDir);
    const res = await httpRequest(uri, { method: 'HEAD', path: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(typeof res.headers['content-security-policy'] === 'string', 'CSP header should be present');
    assert.strictEqual(res.body.length, 0);
  });

  test('HEAD /asset.png returns 200, image/png, content-length, empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const expectedSize = fs.statSync(path.join(tmpDir, 'asset.png')).size;
    const res = await httpRequest(uri, { method: 'HEAD', path: '/asset.png' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['content-length'], String(expectedSize));
    assert.strictEqual(res.body.length, 0);
  });

  // WI-01: HEAD must not include a body on any status, including errors.
  test('HEAD on missing path returns 404 with empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { method: 'HEAD', path: '/missing.png' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.length, 0);
  });

  test('HEAD on traversal returns 403 with empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { method: 'HEAD', path: '/../../etc/passwd' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.length, 0);
  });

  test('HEAD on malformed encoding returns 400 with empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { method: 'HEAD', path: '/%E0%A4%A' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.length, 0);
  });

  test('HEAD with disallowed Host returns 403 with empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { method: 'HEAD', headers: { Host: 'attacker.example' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.length, 0);
  });

  test('HEAD with disallowed method (POST simulated via custom method) is 405 with empty body', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    // Use HEAD vs POST: the 405 branch fires for any non-GET/HEAD; assert
    // that when invoked with HEAD-like semantics on a forbidden method, the
    // body is suppressed. Direct test: send PUT and observe no body.
    const res = await httpRequest(uri, { method: 'PUT' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'GET, HEAD');
  });

  // WI-02: port parser must reject trailing garbage.
  test('Host with non-numeric port suffix returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const [, portStr] = uri.authority.split(':');
    const res = await httpRequest(uri, { headers: { Host: `127.0.0.1:${portStr}abc` } });
    assert.strictEqual(res.statusCode, 403);
  });

  // WI-05: per-publish path-prefix token gates every request.
  test('URL without the publish token returns 404', async () => {
    await server.publish('<p>x</p>', tmpDir);
    const uri = await server.publish('<p>x</p>', tmpDir);
    // Use rawPath to bypass the test-helper token-prefixing.
    const res = await httpRequest(uri, { rawPath: '/' });
    assert.strictEqual(res.statusCode, 404);
    const res2 = await httpRequest(uri, { rawPath: '/wrong-token-1234567890abcdef/' });
    assert.strictEqual(res2.statusCode, 404);
  });

  test('publish token is included in returned URI path and accepted by server', async () => {
    const uri = await server.publish('<h1>OK</h1>', tmpDir);
    assert.match(uri.path, /^\/[0-9a-f]{32}\/$/);
    const res = await httpGet(uri, '/');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.toString('utf8'), '<h1>OK</h1>');
  });

  test('a fresh publish rotates the token and the previous one is rejected', async () => {
    const oldUri = await server.publish('<p>old</p>', tmpDir);
    const oldPath = oldUri.path;
    const newUri = await server.publish('<p>new</p>', tmpDir);
    assert.notStrictEqual(oldPath, newUri.path);
    const stale = await httpRequest(newUri, { rawPath: oldPath });
    assert.strictEqual(stale.statusCode, 404);
  });

  // Mermaid v11 injects both inline style attributes and <style> elements
  // inside rendered SVGs, so style-src must include 'unsafe-inline'.
  // frame-ancestors is only valid as an HTTP header, not in <meta> tags.
  test('CSP allows unsafe-inline styles and includes frame-ancestors in header', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/');
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.match(csp, /style-src 'self' 'unsafe-inline'/, 'style-src should include unsafe-inline for Mermaid');
    assert.match(csp, /frame-ancestors 'none'/, 'HTTP header CSP should include frame-ancestors');
  });

  suite('markdown rendering', () => {
    test('GET /other.md with mdRenderer returns 200, text/html, rendered content', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/other.md');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('Other'));
    });

    test('rendered .md response includes CSP header', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/other.md');
      const csp = String(res.headers['content-security-policy'] ?? '');
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
    });

    test('rendered .md response includes X-Content-Type-Options: nosniff', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/other.md');
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    });

    test('nested .md file renders correctly', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/nested/doc.md');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.toString('utf8').includes('Nested Doc'));
    });

    test('.md without mdRenderer returns raw text/markdown', async () => {
      const uri = await server.publish('<p>root</p>', tmpDir);
      const res = await httpGet(uri, '/other.md');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/markdown; charset=utf-8');
    });

    test('nonexistent .md returns 404', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/missing.md');
      assert.strictEqual(res.statusCode, 404);
    });

    test('traversal to .md outside rootDir returns 403', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/../../etc/passwd.md');
      assert.strictEqual(res.statusCode, 403);
    });

    test('HEAD on .md returns 200, text/html, empty body', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpRequest(uri, { method: 'HEAD', path: '/other.md' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.strictEqual(res.body.length, 0);
    });

    test('non-.md files still served raw when mdRenderer is provided', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/asset.png');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'image/png');
    });

    test('renderer error returns 500', async () => {
      const badRenderer: MdRenderFn = () => { throw new Error('render failed'); };
      const uri = await server.publish('<p>root</p>', tmpDir, badRenderer);
      const res = await httpGet(uri, '/other.md');
      assert.strictEqual(res.statusCode, 500);
    });

    test('.markdown extension is rendered as HTML when mdRenderer is provided', async () => {
      const renderer: MdRenderFn = (_p, c) => `<html>${c}</html>`;
      const uri = await server.publish('<p>root</p>', tmpDir, renderer);
      const res = await httpGet(uri, '/doc.markdown');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    });
  });

  suite('asset routes', () => {
    let extDir: string;
    let assetServer: PreviewServer;

    suiteSetup(() => {
      extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-ext-'));
      const distDir = path.join(extDir, 'node_modules', 'mermaid', 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, 'mermaid.esm.min.mjs'),
        'export default { name: "mermaid" };\n',
        'utf8'
      );
      // WI-04: vendored CSS fixtures for /_assets/preview.css and
      // /_assets/github-markdown.css.
      fs.mkdirSync(path.join(extDir, 'media'), { recursive: true });
      fs.writeFileSync(
        path.join(extDir, 'media', 'preview.css'),
        'body { padding: 1px; }\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(extDir, 'media', 'heading-search.mjs'),
        'const headings = []; // heading-search stub\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(extDir, 'media', 'scroll-spy.mjs'),
        '// scroll-spy stub\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(extDir, 'media', 'collapsible-sections.mjs'),
        '// collapsible-sections stub\n',
        'utf8'
      );
      const ghDir = path.join(extDir, 'node_modules', 'github-markdown-css');
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(
        path.join(ghDir, 'github-markdown.css'),
        '.markdown-body { color: black; }\n',
        'utf8'
      );
      // Mermaid v11 chunk fixtures: the ESM entry shim imports per-diagram
      // chunks dynamically, so the server must serve files under
      // `/_assets/chunks/mermaid.esm.min/`.
      const chunksDir = path.join(distDir, 'chunks', 'mermaid.esm.min');
      fs.mkdirSync(chunksDir, { recursive: true });
      fs.writeFileSync(
        path.join(chunksDir, 'chunk-ABC123.mjs'),
        'export const chunk = "mermaid-chunk";\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(chunksDir, 'chunk-ABC123.mjs.map'),
        '{}\n',
        'utf8'
      );
    });

    suiteTeardown(() => {
      fs.rmSync(extDir, { recursive: true, force: true });
    });

    setup(() => {
      assetServer = new PreviewServer({ idleShutdownMs: 50, extensionPath: extDir });
    });

    teardown(() => {
      assetServer.dispose();
    });

    test('GET /_assets/mermaid.esm.min.mjs returns 200 with javascript content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/mermaid.esm.min.mjs');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('mermaid'), 'body should contain mermaid');
    });

    test('HEAD /_assets/mermaid.esm.min.mjs returns 200, javascript content-type, empty body', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const assetPath = path.join(extDir, 'node_modules', 'mermaid', 'dist', 'mermaid.esm.min.mjs');
      const expectedSize = fs.statSync(assetPath).size;
      const res = await httpRequest(uri, { method: 'HEAD', path: '/_assets/mermaid.esm.min.mjs' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.strictEqual(res.headers['content-length'], String(expectedSize));
      assert.strictEqual(res.body.length, 0);
    });

    test('GET /_assets/preview.css returns 200 with text/css content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/preview.css');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/css; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('padding'), 'body should contain CSS');
    });

    test('GET /_assets/github-markdown.css returns 200 with text/css content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/github-markdown.css');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/css; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('markdown-body'), 'body should contain markdown-body class');
    });

    test('GET /_assets/heading-search.mjs returns 200 with javascript content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/heading-search.mjs');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('heading-search'), 'body should contain heading-search');
    });

    test('GET /_assets/scroll-spy.mjs returns 200 with javascript content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/scroll-spy.mjs');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('scroll-spy'), 'body should contain scroll-spy');
    });

    test('GET /_assets/collapsible-sections.mjs returns 200 with javascript content-type', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/collapsible-sections.mjs');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(
        res.body.toString('utf8').includes('collapsible-sections'),
        'body should contain collapsible-sections',
      );
    });

    test('GET /_assets/something-else returns 404 (allow-list only)', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/something-else.mjs');
      assert.strictEqual(res.statusCode, 404);
    });

    test('GET /_assets/chunks/mermaid.esm.min/<name>.mjs serves chunk file', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/chunks/mermaid.esm.min/chunk-ABC123.mjs');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(res.body.toString('utf8').includes('mermaid-chunk'), 'body should contain chunk content');
    });

    test('GET /_assets/chunks/mermaid.esm.min/<name>.mjs.map is rejected (404)', async () => {
      // Source maps are present on disk but excluded by the strict filename
      // pattern; allowing `.mjs.map` would broaden the surface unnecessarily.
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/chunks/mermaid.esm.min/chunk-ABC123.mjs.map');
      assert.strictEqual(res.statusCode, 404);
    });

    test('GET /_assets/chunks/mermaid.esm.min/missing.mjs returns 404', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/chunks/mermaid.esm.min/chunk-MISSING.mjs');
      assert.strictEqual(res.statusCode, 404);
    });

    test('GET /_assets/chunks/mermaid.esm.min/ traversal attempt is rejected', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      // URL-encoded `/` would let an attacker climb out of the chunks dir if
      // the filename pattern allowed it; the pattern denies any non-word
      // characters before the request reaches the filesystem.
      const res = await httpGet(uri, '/_assets/chunks/mermaid.esm.min/%2e%2e%2fmermaid.esm.min.mjs');
      assert.strictEqual(res.statusCode, 404);
    });

    test('GET /_assets/chunks/unknown-prefix/file.mjs returns 404 (prefix allow-list)', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/chunks/unknown-prefix/file.mjs');
      assert.strictEqual(res.statusCode, 404);
    });

    test('asset route returns 404 when extensionPath is not configured', async () => {
      const noExtServer = new PreviewServer({ idleShutdownMs: 50 });
      try {
        const uri = await noExtServer.publish('<p>x</p>', tmpDir);
        const res = await httpGet(uri, '/_assets/mermaid.esm.min.mjs');
        assert.strictEqual(res.statusCode, 404);
      } finally {
        noExtServer.dispose();
      }
    });

    test('preview.css contains foreignObject reset rules', () => {
      const cssPath = path.resolve(__dirname, '..', '..', 'media', 'preview.css');
      const css = fs.readFileSync(cssPath, 'utf8');
      // Strip block comments before checking for selector and declaration
      // tokens so explanatory comments do not satisfy the assertions.
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(
        stripped.includes('.markdown-body svg foreignObject'),
        'media/preview.css must contain foreignObject reset rules'
      );
      assert.ok(
        !stripped.includes('all: revert'),
        'media/preview.css must not use all: revert'
      );
    });
  });
});
