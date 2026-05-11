import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

const ASSET_EXT_ALLOWLIST = new Set(Object.keys(MIME_TYPES));

// Rejects any path whose segments include dotfiles, `.git`, or `node_modules`.
const DENY_SEGMENT_RE = /(^|[\\/])(\.[^\\/]+|\.git|node_modules)([\\/]|$)/;

const TOKEN_PREFIX_RE = /^\/([0-9a-f]{32})(\/.*)?$/;
const MERMAID_INIT_PATH = '/__open_md_in_browser__/mermaid-init.js';
const MERMAID_INIT_JS = [
  '(() => {',
  '  const mermaid = globalThis.mermaid;',
  "  if (!mermaid || typeof mermaid.initialize !== 'function') { return; }",
  "  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;",
  "  mermaid.initialize({ startOnLoad: true, theme: prefersDark ? 'dark' : 'default', securityLevel: 'strict' });",
  '})();'
].join('\n');

const CSP = [
  "default-src 'none'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ') + ';';

interface PublishedState {
  html: string;
  rootDir: string;
  rootReal: string;
  token: string;
}

export class PreviewServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port: number | undefined;
  private state: PublishedState | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleShutdownMs: number;

  /**
   * `idleShutdownMs` exists primarily for tests; defaults to 5 minutes.
   */
  constructor(options: { idleShutdownMs?: number } = {}) {
    const override = options.idleShutdownMs;
    this.idleShutdownMs = typeof override === 'number' && Number.isFinite(override) && override >= 0 ? override : IDLE_SHUTDOWN_MS;
  }

  async publish(html: string, rootDir: string): Promise<vscode.Uri> {
    const resolvedRoot = path.resolve(rootDir);
    const rootReal = await fs.promises.realpath(resolvedRoot);
    const token = randomBytes(16).toString('hex');
    this.state = { html, rootDir: resolvedRoot, rootReal, token };
    await this.ensureStarted();
    this.rearmIdleTimer();
    const cacheBuster = Date.now().toString(36);
    return vscode.Uri.parse(`http://127.0.0.1:${this.port}/${token}/?v=${cacheBuster}`);
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.port = undefined;
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.server && this.port !== undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.server = server;
          resolve();
        } else {
          reject(new Error('PreviewServer: failed to acquire listening port.'));
        }
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  }

  private isHostAllowed(host: string | undefined): boolean {
    if (!host || this.port === undefined) { return false; }
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private applySecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
  }

  private reject(res: http.ServerResponse, statusCode: number, message: string): void {
    this.applySecurityHeaders(res);
    res.statusCode = statusCode;
    res.setHeader('Cache-Control', 'no-store');
    res.end(message);
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.rearmIdleTimer();

    if (!this.isHostAllowed(req.headers.host)) {
      this.reject(res, 421, 'Misdirected request.');
      return;
    }

    const state = this.state;
    if (!state) {
      this.reject(res, 503, 'Preview not ready.');
      return;
    }

    const url = req.url ?? '/';
    const rawPath = url.split('?', 1)[0];

    const match = TOKEN_PREFIX_RE.exec(rawPath);
    if (!match || match[1] !== state.token) {
      this.reject(res, 404, 'Not found.');
      return;
    }
    const pathname = match[2] ?? '/';

    if (pathname === '/' || pathname === '') {
      this.applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(state.html);
      return;
    }

    if (pathname === MERMAID_INIT_PATH) {
      this.applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(MERMAID_INIT_JS);
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      this.reject(res, 400, 'Bad request.');
      return;
    }

    const relative = decoded.replace(/^\/+/, '');
    const resolved = path.resolve(state.rootDir, relative);
    const rootWithSep = state.rootDir.endsWith(path.sep)
      ? state.rootDir
      : state.rootDir + path.sep;
    if (resolved !== state.rootDir && !resolved.startsWith(rootWithSep)) {
      this.reject(res, 403, 'Forbidden.');
      return;
    }

    fs.promises.realpath(resolved).then(real => {
      const realRootWithSep = state.rootReal.endsWith(path.sep)
        ? state.rootReal
        : state.rootReal + path.sep;
      if (real !== state.rootReal && !real.startsWith(realRootWithSep)) {
        this.reject(res, 403, 'Forbidden.');
        return;
      }

      const relFromRoot = path.relative(state.rootReal, real);
      if (DENY_SEGMENT_RE.test(relFromRoot)) {
        this.reject(res, 403, 'Forbidden.');
        return;
      }

      const ext = path.extname(real).toLowerCase();
      if (!ASSET_EXT_ALLOWLIST.has(ext)) {
        this.reject(res, 403, 'Forbidden.');
        return;
      }

      fs.promises.stat(real).then(stats => {
        if (!stats.isFile()) {
          this.reject(res, 404, 'Not found.');
          return;
        }
        const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
        this.applySecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'no-store');
        const stream = fs.createReadStream(real);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 500;
          }
          res.end();
        });
        stream.pipe(res);
      }).catch(() => {
        this.reject(res, 404, 'Not found.');
      });
    }).catch((err: NodeJS.ErrnoException) => {
      if (err && err.code === 'ENOENT') {
        this.reject(res, 404, 'Not found.');
      } else {
        this.reject(res, 500, 'Server error.');
      }
    });
  }

  private rearmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.dispose();
    }, this.idleShutdownMs);
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }
}
