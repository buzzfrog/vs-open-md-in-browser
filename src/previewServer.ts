import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
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

// `style-src 'self' 'unsafe-inline'` is required because Mermaid v11 injects
// both inline `style="..."` attributes and `<style>` elements inside its
// rendered SVG output. Nonces/hashes are infeasible for dynamically generated
// SVG styles, so `'unsafe-inline'` is the only viable option.
//
// Two CSP strings are exported:
// - `CONTENT_SECURITY_POLICY` — used in the `<meta>` tag. Excludes
//   `frame-ancestors` because the spec mandates that directive is ignored
//   when delivered via `<meta>` (browsers log a console warning).
// - `CONTENT_SECURITY_POLICY_HEADER` — used in the HTTP response header.
//   Adds `frame-ancestors 'none'` which is only effective as a header.
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'";

export const CONTENT_SECURITY_POLICY_HEADER =
  CONTENT_SECURITY_POLICY + "; frame-ancestors 'none'";

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
  },
  '/_assets/preview.css': {
    fsRelative: 'media/preview.css',
    mime: 'text/css; charset=utf-8'
  },
  '/_assets/github-markdown.css': {
    fsRelative: 'node_modules/github-markdown-css/github-markdown.css',
    mime: 'text/css; charset=utf-8'
  }
};

interface AssetPrefixRoute {
  fsRelativeDir: string;
  mime: string;
  filenamePattern: RegExp;
}

// Prefix-based asset allow-list. Required because Mermaid v11 ships its ESM
// entry (`mermaid.esm.min.mjs`) as a thin shim that statically and
// dynamically imports per-diagram code from `./chunks/mermaid.esm.min/*.mjs`.
// Listing every chunk filename in `ASSET_ROUTES` would be brittle across
// upstream releases (chunk hashes change every version), so we whitelist the
// directory prefix and constrain filenames with a strict pattern. Filenames
// must match `[A-Za-z0-9_-]+\.mjs` so source maps (`*.mjs.map`) and any
// path-traversal attempts (`/`, `..`, encoded separators) are rejected before
// touching the filesystem; realpath containment in `serveAsset` provides
// defense-in-depth against symlink escapes.
const ASSET_PREFIX_ROUTES: Record<string, AssetPrefixRoute> = {
  '/_assets/chunks/mermaid.esm.min/': {
    fsRelativeDir: 'node_modules/mermaid/dist/chunks/mermaid.esm.min',
    mime: 'application/javascript; charset=utf-8',
    filenamePattern: /^[A-Za-z0-9_-]+\.mjs$/
  }
};

interface PublishedState {
  html: string;
  rootDir: string;
  realRootDir: string;
  token: string;
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
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY_HEADER);
}

// Centralised response terminator (WI-01). HEAD responses (RFC 9110 §9.3.2)
// MUST NOT include a message body on any status code, so this helper drops the
// body for HEAD on every branch (success and error alike).
function endResponse(res: http.ServerResponse, method: string, body?: string): void {
  if (method === 'HEAD' || body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

const PORT_PATTERN = /^\d+$/;

function resolveAssetPrefix(pathname: string): AssetRoute | undefined {
  for (const [prefix, route] of Object.entries(ASSET_PREFIX_ROUTES)) {
    if (!pathname.startsWith(prefix)) {
      continue;
    }
    const filename = pathname.slice(prefix.length);
    if (!route.filenamePattern.test(filename)) {
      // Strict pattern rejects path separators, parent-dir tokens, and any
      // extension other than the expected one (e.g. `*.mjs.map`). Returning
      // `undefined` here is converted to a 404 by the caller, matching the
      // fail-closed contract of the static allow-list.
      return undefined;
    }
    return {
      fsRelative: path.posix.join(route.fsRelativeDir, filename),
      mime: route.mime
    };
  }
  return undefined;
}

export class PreviewServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port: number | undefined;
  private state: PublishedState | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleShutdownMs: number;
  private readonly extensionPath: string | undefined;
  private realExtensionPath: string | undefined;
  private readonly extraAllowedHosts = new Set<string>();

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
    // Per-publish path-prefix token (WI-05). Defense-in-depth against
    // DNS-rebinding-style attackers: even if Host validation is bypassed, the
    // attacker cannot reach any preview content without guessing the token.
    // 128 bits of entropy, hex-encoded so it is URL-safe and survives all
    // path-segment escaping rules.
    const token = crypto.randomBytes(16).toString('hex');
    this.state = { html, rootDir: resolvedRoot, realRootDir: realRoot, token };
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
    this.extraAllowedHosts.clear();
  }

  /**
   * Register an additional authority (`host[:port]`) that should be accepted
   * by `isHostAllowed`. Matching is case-insensitive on the full authority.
   * Used to whitelist the tunnel authority returned by
   * `vscode.env.asExternalUri` in Remote / Codespaces.
   */
  addAllowedHost(authority: string): void {
    if (typeof authority !== 'string') {
      return;
    }
    const normalized = authority.trim().toLowerCase();
    if (normalized.length === 0) {
      return;
    }
    this.extraAllowedHosts.add(normalized);
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
      endResponse(res, method, 'Method not allowed.');
      return;
    }

    if (!this.isHostAllowed(req.headers.host)) {
      res.statusCode = 403;
      setCommonHeaders(res);
      endResponse(res, method, 'Forbidden.');
      return;
    }

    const state = this.state;
    if (!state) {
      res.statusCode = 503;
      setCommonHeaders(res);
      endResponse(res, method, 'Preview not ready.');
      return;
    }

    const url = req.url ?? '/';
    const rawPathname = url.split('?', 1)[0];

    // Validate and strip the per-publish path-prefix token (WI-05). Any
    // request without the exact prefix returns 404 so the token is not
    // leaked through differential responses (404 for both wrong-token and
    // unknown-route).
    const tokenPrefix = `/${state.token}/`;
    let pathname: string;
    if (rawPathname === `/${state.token}` || rawPathname === tokenPrefix) {
      pathname = '/';
    } else if (rawPathname.startsWith(tokenPrefix)) {
      pathname = '/' + rawPathname.slice(tokenPrefix.length);
    } else {
      res.statusCode = 404;
      setCommonHeaders(res);
      endResponse(res, method, 'Not found.');
      return;
    }

    if (pathname === '/' || pathname === '') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      setIndexHtmlHeaders(res);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(state.html);
      return;
    }

    const assetRoute = ASSET_ROUTES[pathname];
    if (assetRoute) {
      this.serveAsset(assetRoute, method, res);
      return;
    }

    const prefixAsset = resolveAssetPrefix(pathname);
    if (prefixAsset) {
      this.serveAsset(prefixAsset, method, res);
      return;
    }

    if (pathname.startsWith('/_assets/')) {
      // Any other `/_assets/` request is not in the allow-list. Fail closed
      // with 404 so we never fall through to the workspace file handler for
      // reserved asset paths.
      res.statusCode = 404;
      setCommonHeaders(res);
      endResponse(res, method, 'Not found.');
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      setCommonHeaders(res);
      endResponse(res, method, 'Bad request.');
      return;
    }

    const relative = decoded.replace(/^\/+/, '');
    const resolved = path.resolve(state.rootDir, relative);
    const rootWithSep = state.rootDir.endsWith(path.sep)
      ? state.rootDir
      : state.rootDir + path.sep;
    // Lexical containment check kept as defense-in-depth alongside the
    // realpath check below (WI-03). The realpath check is the authoritative
    // guard against symlink escapes; the lexical check fails closed cheaply
    // before any filesystem I/O for the common `..` traversal case and limits
    // the attack surface for any future bug in `fs.realpath` callback paths.
    if (resolved !== state.rootDir && !resolved.startsWith(rootWithSep)) {
      res.statusCode = 403;
      setCommonHeaders(res);
      endResponse(res, method, 'Forbidden.');
      return;
    }

    fs.realpath(resolved, (realErr, realResolved) => {
      if (realErr) {
        const code = (realErr as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          res.statusCode = 404;
          setCommonHeaders(res);
          endResponse(res, method, 'Not found.');
          return;
        }
        res.statusCode = 500;
        setCommonHeaders(res);
        endResponse(res, method, 'Server error.');
        return;
      }

      const realRoot = state.realRootDir;
      const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realResolved !== realRoot && !realResolved.startsWith(realRootWithSep)) {
        res.statusCode = 403;
        setCommonHeaders(res);
        endResponse(res, method, 'Forbidden.');
        return;
      }

      fs.stat(realResolved, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
          res.statusCode = 404;
          setCommonHeaders(res);
          endResponse(res, method, 'Not found.');
          return;
        }
        const ext = path.extname(realResolved).toLowerCase();
        const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(stats.size));
        setCommonHeaders(res);
        if (method === 'HEAD') {
          res.end();
          return;
        }
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
    const normalizedAuthority = hostHeader.toLowerCase();
    if (this.extraAllowedHosts.has(normalizedAuthority)) {
      return true;
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      return false;
    }
    if (portStr === undefined || portStr === '') {
      return false;
    }
    // Strict numeric match (WI-02). `Number.parseInt` would accept trailing
    // garbage like "8080abc", so anchor a digit-only pattern to the full
    // string before parsing.
    if (!PORT_PATTERN.test(portStr)) {
      return false;
    }
    const port = Number.parseInt(portStr, 10);
    return port === this.port;
  }

  private serveAsset(route: AssetRoute, method: string, res: http.ServerResponse): void {
    if (!this.extensionPath) {
      res.statusCode = 404;
      setCommonHeaders(res);
      endResponse(res, method, 'Not found.');
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
            endResponse(res, method, 'Not found.');
            return;
          }
          res.statusCode = 500;
          setCommonHeaders(res);
          endResponse(res, method, 'Server error.');
          return;
        }
        const realExtWithSep = realExtPath.endsWith(path.sep) ? realExtPath : realExtPath + path.sep;
        if (realCandidate !== realExtPath && !realCandidate.startsWith(realExtWithSep)) {
          res.statusCode = 403;
          setCommonHeaders(res);
          endResponse(res, method, 'Forbidden.');
          return;
        }
        fs.stat(realCandidate, (statErr, stats) => {
          if (statErr || !stats.isFile()) {
            res.statusCode = 404;
            setCommonHeaders(res);
            endResponse(res, method, 'Not found.');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', route.mime);
          res.setHeader('Content-Length', String(stats.size));
          setCommonHeaders(res);
          if (method === 'HEAD') {
            res.end();
            return;
          }
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
        endResponse(res, method, 'Server error.');
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
