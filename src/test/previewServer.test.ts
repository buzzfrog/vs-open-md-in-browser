import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewServer } from '../previewServer';

interface HttpResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CSS_CONTENT = 'body { color: red; }';

function httpGet(uri: vscode.Uri, pathOverride?: string): Promise<HttpResult> {
  const [host, portStr] = uri.authority.split(':');
  const port = Number.parseInt(portStr, 10);
  const requestPath = pathOverride ?? (uri.path || '/');
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
  options: { method?: string; path?: string; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const [host, portStr] = uri.authority.split(':');
  const port = Number.parseInt(portStr, 10);
  const requestPath = options.path ?? (uri.path || '/');
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

    test('GET /_assets/something-else returns 404 (allow-list only)', async () => {
      const uri = await assetServer.publish('<p>x</p>', tmpDir);
      const res = await httpGet(uri, '/_assets/something-else.mjs');
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
  });
});
