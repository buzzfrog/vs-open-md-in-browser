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

const ALLOWED_METHODS = 'GET, HEAD';
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

interface AssetRoute {
  fsRelative: string;
  mime: string;
}

const ASSET_ROUTES: Record<string, AssetRoute> = {
  '/_assets/mermaid.esm.min.mjs': {
    fsRelative: 'node_modules/mermaid/dist/mermaid.esm.min.mjs',
    mime: 'application/javascript; charset=utf-8'
  },
  '/_assets/mermaid-init.mjs': {
    fsRelative: 'media/mermaid-init.mjs',
    mime: 'application/javascript; charset=utf-8'
  }
};

interface PublishedState {
  html: string;
  rootDir: string;
  realRootDir: string;
}

export interface PreviewServerOptions {
  idleShutdownMs?: number;
  extensionPath?: string;
}

function setCommonHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function setIndexHtmlHeaders(res: http.ServerResponse): void {
  setCommonHeaders(res);
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

export class PreviewServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port: number | undefined;
  private state: PublishedState | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleShutdownMs: number;
  private readonly extensionPath: string | undefined;
  private realExtensionPath: string | undefined;

  /**
   * `idleShutdownMs` exists primarily for tests; defaults to 5 minutes.
   * `extensionPath` enables serving vendored assets under `/_assets/`.
   */
  constructor(options: PreviewServerOptions = {}) {
    const override = options.idleShutdownMs;
    this.idleShutdownMs = typeof override === 'number' && Number.isFinite(override) && override >= 0 ? override : IDLE_SHUTDOWN_MS;
    this.extensionPath = options.extensionPath;
  }

  async publish(html: string, rootDir: string): Promise<vscode.Uri> {
    const resolvedRoot = path.resolve(rootDir);
    const realRoot = await fs.promises.realpath(resolvedRoot);
    this.state = { html, rootDir: resolvedRoot, realRootDir: realRoot };
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

    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', ALLOWED_METHODS);
      setCommonHeaders(res);
      res.end('Method not allowed.');
      return;
    }

    if (!this.isHostAllowed(req.headers.host)) {
      res.statusCode = 403;
      setCommonHeaders(res);
      res.end('Forbidden.');
      return;
    }

    const state = this.state;
    if (!state) {
      res.statusCode = 503;
      setCommonHeaders(res);
      res.end('Preview not ready.');
      return;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?', 1)[0];

    if (pathname === '/' || pathname === '') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setIndexHtmlHeaders(res);
      res.end(state.html);
      return;
    }

    const assetRoute = ASSET_ROUTES[pathname];
    if (assetRoute) {
      this.serveAsset(assetRoute, res);
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      setCommonHeaders(res);
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
      setCommonHeaders(res);
      res.end('Forbidden.');
      return;
    }

    fs.realpath(resolved, (realErr, realResolved) => {
      if (realErr) {
        const code = (realErr as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          res.statusCode = 404;
          setCommonHeaders(res);
          res.end('Not found.');
          return;
        }
        res.statusCode = 500;
        setCommonHeaders(res);
        res.end('Server error.');
        return;
      }

      const realRoot = state.realRootDir;
      const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realResolved !== realRoot && !realResolved.startsWith(realRootWithSep)) {
        res.statusCode = 403;
        setCommonHeaders(res);
        res.end('Forbidden.');
        return;
      }

      fs.stat(realResolved, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
          res.statusCode = 404;
          setCommonHeaders(res);
          res.end('Not found.');
          return;
        }
        const ext = path.extname(realResolved).toLowerCase();
        const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        setCommonHeaders(res);
        const stream = fs.createReadStream(realResolved);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 500;
          }
          res.end();
        });
        stream.pipe(res);
      });
    });
  }

  private isHostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader || this.port === undefined) {
      return false;
    }
    // Strip optional `:port`. The server binds 127.0.0.1, so IPv6 hosts are not expected.
    const lastColon = hostHeader.lastIndexOf(':');
    let hostname: string;
    let portStr: string | undefined;
    if (lastColon >= 0) {
      hostname = hostHeader.slice(0, lastColon);
      portStr = hostHeader.slice(lastColon + 1);
    } else {
      hostname = hostHeader;
      portStr = undefined;
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      return false;
    }
    if (portStr === undefined || portStr === '') {
      return false;
    }
    const port = Number.parseInt(portStr, 10);
    return port === this.port;
  }

  private serveAsset(route: AssetRoute, res: http.ServerResponse): void {
    if (!this.extensionPath) {
      res.statusCode = 404;
      setCommonHeaders(res);
      res.end('Not found.');
      return;
    }

    const extensionPath = this.extensionPath;
    const candidate = path.join(extensionPath, route.fsRelative);

    const finish = (realExtPath: string): void => {
      fs.realpath(candidate, (realErr, realCandidate) => {
        if (realErr) {
          const code = (realErr as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            res.statusCode = 404;
            setCommonHeaders(res);
            res.end('Not found.');
            return;
          }
          res.statusCode = 500;
          setCommonHeaders(res);
          res.end('Server error.');
          return;
        }
        const realExtWithSep = realExtPath.endsWith(path.sep) ? realExtPath : realExtPath + path.sep;
        if (realCandidate !== realExtPath && !realCandidate.startsWith(realExtWithSep)) {
          res.statusCode = 403;
          setCommonHeaders(res);
          res.end('Forbidden.');
          return;
        }
        fs.stat(realCandidate, (statErr, stats) => {
          if (statErr || !stats.isFile()) {
            res.statusCode = 404;
            setCommonHeaders(res);
            res.end('Not found.');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', route.mime);
          setCommonHeaders(res);
          const stream = fs.createReadStream(realCandidate);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.statusCode = 500;
            }
            res.end();
          });
          stream.pipe(res);
        });
      });
    };

    if (this.realExtensionPath) {
      finish(this.realExtensionPath);
      return;
    }
    fs.realpath(extensionPath, (realErr, realExtPath) => {
      if (realErr) {
        res.statusCode = 500;
        setCommonHeaders(res);
        res.end('Server error.');
        return;
      }
      this.realExtensionPath = realExtPath;
      finish(realExtPath);
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
