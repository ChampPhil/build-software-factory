import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";

/**
 * `bsf dashboard` — serve the built dashboard from this machine.
 *
 * The dashboard is a static export that talks to GitHub from the browser, so
 * self-hosting is only a matter of serving files. It exists because the
 * alternative is asking people to trust a hosted copy with a token that can
 * write to their repository.
 *
 * Bound to the loopback interface on purpose. The page holds a GitHub token
 * in browser storage, and a dashboard reachable from the network would hand
 * anyone on it a page that acts as the person running this.
 */

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Where the built dashboard is, in a checkout or in the published package. */
export function findDashboard(from: string): string | null {
  for (const rel of ["dashboard/out", "../dashboard/out", "../../dashboard/out", "dashboard"]) {
    const dir = resolve(from, rel);
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * The file a request maps to, or null when it escapes the root.
 *
 * Next's static export writes `/live/index.html`, and a link to `/live`
 * should find it; a request for `..%2f..%2fetc%2fpasswd` should not find
 * anything. Both are decided here rather than in the handler, so both can be
 * tested without a socket.
 */
export async function resolveFile(root: string, url: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    return null;
  }
  // A NUL byte truncates a path in some filesystem calls.
  if (pathname.includes("\0")) return null;

  const candidate = resolve(root, `.${pathname}`);
  // resolve() has already collapsed any `..`, so this is the whole check.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  for (const path of [candidate, join(candidate, "index.html"), `${candidate}.html`]) {
    try {
      const info = await stat(path);
      if (info.isFile()) return path;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

export function dashboardHandler(root: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }

    const file = await resolveFile(root, req.url ?? "/");
    if (file === null) {
      // Next's export writes 404.html; fall back to it so a mistyped path
      // looks like the dashboard rather than like a broken server.
      const notFound = join(root, "404.html");
      const body = existsSync(notFound) ? await readFile(notFound) : Buffer.from("not found\n");
      res.writeHead(404, { "content-type": existsSync(notFound) ? TYPES[".html"]! : TYPES[".txt"]! });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(body.length),
      // The page holds a GitHub token. These cost nothing and close the
      // obvious ways a local page gets turned against the person running it.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // Served fresh: a cached build after an upgrade is a confusing bug.
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

export async function serveDashboard(opts: {
  readonly root: string;
  readonly port: number;
  readonly host?: string;
}): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void dashboardHandler(opts.root)(req, res).catch(() => {
      res.writeHead(500);
      res.end("error\n");
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, host, ok);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}
