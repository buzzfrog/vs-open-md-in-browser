import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
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

interface PublishedState {
  html: string;
  rootDir: string;
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
    this.state = { html, rootDir: path.resolve(rootDir) };
    await this.ensureStarted();
    this.rearmIdleTimer();
    const cacheBuster = Date.now().toString(36);
    return vscode.Uri.parse(`http://127.0.0.1:${this.port}/?v=${cacheBuster}`);
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

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.rearmIdleTimer();

    const state = this.state;
    if (!state) {
      res.statusCode = 503;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Preview not ready.');
      return;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?', 1)[0];

    if (pathname === '/' || pathname === '') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(state.html);
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Bad request.');
      return;
    }

    const relative = decoded.replace(/^\/+/, '');
    const resolved = path.resolve(state.rootDir, relative);
    const rootWithSep = state.rootDir.endsWith(path.sep)
      ? state.rootDir
      : state.rootDir + path.sep;
    if (resolved !== state.rootDir && !resolved.startsWith(rootWithSep)) {
      res.statusCode = 403;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Forbidden.');
      return;
    }

    fs.stat(resolved, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        res.statusCode = 404;
        res.setHeader('Cache-Control', 'no-store');
        res.end('Not found.');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      const stream = fs.createReadStream(resolved);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end();
      });
      stream.pipe(res);
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
