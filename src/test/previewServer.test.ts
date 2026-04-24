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

interface RequestOptions {
  pathOverride?: string;
  host?: string;
  skipTokenPrefix?: boolean;
}

function joinTokenPath(basePath: string, subPath: string | undefined): string {
  if (subPath === undefined) {
    return basePath || '/';
  }
  const base = basePath.replace(/\/+$/, '');
  const sub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  return `${base}${sub}`;
}

function httpRequest(uri: vscode.Uri, options: RequestOptions = {}): Promise<HttpResult> {
  const [defaultHost, portStr] = uri.authority.split(':');
  const port = Number.parseInt(portStr, 10);
  const basePath = uri.path || '/';
  const requestPath = options.skipTokenPrefix
    ? (options.pathOverride ?? '/')
    : joinTokenPath(basePath, options.pathOverride);
  const requestHost = options.host ?? `${defaultHost}:${port}`;
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      {
        host: defaultHost,
        port,
        path: requestPath,
        method: 'GET',
        headers: { Host: requestHost }
      },
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
    req.setTimeout(2000, () => req.destroy(new Error('httpGet timeout')));
    req.end();
  });
}

function httpGet(uri: vscode.Uri, pathOverride?: string): Promise<HttpResult> {
  return httpRequest(uri, { pathOverride });
}

function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
  assert.strictEqual(headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(headers['referrer-policy'], 'no-referrer');
  const csp = headers['content-security-policy'];
  assert.ok(typeof csp === 'string', 'content-security-policy header should be present');
  assert.ok((csp as string).includes("default-src 'none'"), 'CSP should include default-src \'none\'');
}

suite('PreviewServer', () => {
  let tmpDir: string;
  let symlinkTarget: string | undefined;
  let symlinkCreated = false;
  let server: PreviewServer;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-preview-'));
    fs.writeFileSync(path.join(tmpDir, 'asset.png'), PNG_SIGNATURE);
    fs.mkdirSync(path.join(tmpDir, 'nested'));
    fs.writeFileSync(path.join(tmpDir, 'nested', 'asset.css'), CSS_CONTENT, 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=shh', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'secret.pem'), '-----BEGIN KEY-----', 'utf8');

    // Create a symlink inside tmpDir pointing to a file outside it.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-outside-'));
    symlinkTarget = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(symlinkTarget, PNG_SIGNATURE);
    try {
      fs.symlinkSync(symlinkTarget, path.join(tmpDir, 'leak.png'));
      symlinkCreated = true;
    } catch {
      // Windows without developer mode / non-admin: symlink creation fails. Tests skip.
      symlinkCreated = false;
    }
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (symlinkTarget) {
      fs.rmSync(path.dirname(symlinkTarget), { recursive: true, force: true });
    }
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

  test('request without token returns 404 and does not leak published HTML', async () => {
    const html = '<h1>SECRET-HTML-MARKER</h1>';
    const uri = await server.publish(html, tmpDir);
    const res = await httpRequest(uri, { pathOverride: '/', skipTokenPrefix: true });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!res.body.toString('utf8').includes('SECRET-HTML-MARKER'));
  });

  test('request with wrong token returns 404', async () => {
    const html = '<h1>SECRET-HTML-MARKER</h1>';
    const uri = await server.publish(html, tmpDir);
    const res = await httpRequest(uri, {
      pathOverride: `/${'0'.repeat(32)}/`,
      skipTokenPrefix: true
    });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!res.body.toString('utf8').includes('SECRET-HTML-MARKER'));
  });

  test('foreign Host header returns 421', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpRequest(uri, { pathOverride: '/', host: 'attacker.example' });
    assert.strictEqual(res.statusCode, 421);
  });

  test('symlink escaping rootDir returns 403', async function () {
    if (!symlinkCreated) {
      this.skip();
      return;
    }
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/leak.png');
    assert.strictEqual(res.statusCode, 403);
    assert.ok(!res.body.equals(PNG_SIGNATURE), 'response body must not contain linked file bytes');
  });

  test('.env dotfile returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/.env');
    assert.strictEqual(res.statusCode, 403);
    assert.ok(!res.body.toString('utf8').includes('SECRET=shh'));
  });

  test('disallowed extension (.pem) returns 403', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const res = await httpGet(uri, '/secret.pem');
    assert.strictEqual(res.statusCode, 403);
  });

  test('security headers present on / and on asset responses', async () => {
    const uri = await server.publish('<p>x</p>', tmpDir);
    const rootRes = await httpGet(uri, '/');
    assert.strictEqual(rootRes.statusCode, 200);
    assertSecurityHeaders(rootRes.headers);

    const assetRes = await httpGet(uri, '/asset.png');
    assert.strictEqual(assetRes.statusCode, 200);
    assertSecurityHeaders(assetRes.headers);
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
});
