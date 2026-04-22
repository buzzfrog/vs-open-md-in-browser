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
});
