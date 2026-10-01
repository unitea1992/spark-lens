import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { Snapshot } from "./types.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * The dashboard is reached as localhost, by IP, or through a Tailscale name.
 * Refusing any other Host keeps a web page on some other origin from reading
 * it through DNS rebinding.
 */
export function hostAllowed(header: string | undefined, extra: string[]): boolean {
  if (!header) return false;
  let name = header.trim().toLowerCase();
  if (name.startsWith("[")) {
    name = name.slice(1, name.indexOf("]"));
  } else if (name.includes(":")) {
    name = name.slice(0, name.lastIndexOf(":"));
  }
  if (name === "localhost" || isIP(name) !== 0) return true;
  if (name === hostname().toLowerCase()) return true;
  if (name.endsWith(".ts.net")) return true;
  return extra.some((h) => h.toLowerCase() === name);
}

export interface RecipeActions {
  start(id: string): Promise<{ ok: boolean; message: string }>;
  stop(id: string): Promise<{ ok: boolean; message: string }>;
  logs(id: string, source: "launcher" | "server"): Promise<{ ok: boolean; text: string }>;
  check(id: string): Promise<{ ok: boolean; message: string }>;
  update(id: string): Promise<{ ok: boolean; message: string }>;
  switchTo(id: string): Promise<{ ok: boolean; message: string }>;
}

export interface HttpOptions {
  host: string;
  port: number;
  staticDir: string;
  allowedHosts: string[];
  snapshot: () => Snapshot;
  recipes?: RecipeActions;
  /** Start a benchmark of one local model. */
  bench?: (llmId: string) => Promise<{ ok: boolean; message: string }>;
  /** Minute averages for one series over the last day. */
  history?: (key: string) => { t: number; v: number }[];
  /** Called after a state-changing request so viewers see it at once. */
  changed?: () => void;
}

const RECIPE_ROUTE = /^\/api\/recipes\/([a-z0-9][a-z0-9-]*)\/(start|stop|logs|check|update|switch)$/;

/**
 * Requests that change something must carry this header. A browser only sends
 * a custom header cross-origin after a CORS preflight, which this server never
 * approves, so another site cannot make a viewer's browser press the buttons.
 */
export const ACTION_HEADER = "x-spark-lens";

type RecipeOp = "start" | "stop" | "logs" | "check" | "update" | "switch";

export class HttpServer {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly opts: HttpOptions;
  /** Compressed copies of static text files, keyed by path and mtime. */
  private readonly gzipCache = new Map<string, { mtimeMs: number; body: Buffer }>();

  constructor(opts: HttpOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  close(): void {
    for (const c of this.clients) c.end();
    this.server.close();
  }

  /** Push the current snapshot to every open stream. */
  broadcast(): void {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(this.opts.snapshot())}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req.headers.host, this.opts.allowedHosts)) {
      res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" }).end("Unrecognised Host header\n");
      return;
    }
    const path = decodePath(req.url ?? "/");
    if (path === null) {
      res.writeHead(400).end();
      return;
    }
    const recipe = RECIPE_ROUTE.exec(path);
    if (recipe) {
      void this.recipe(req, res, recipe[1]!, recipe[2] as RecipeOp);
      return;
    }
    const bench = /^\/api\/llms\/([a-z0-9][a-z0-9-]*)\/bench$/.exec(path);
    if (bench) {
      const json = (status: number, body: unknown) =>
        void res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
      if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
      if (req.headers[ACTION_HEADER] !== "1") return json(403, { ok: false, message: "この操作はダッシュボードの画面から行ってください" });
      if (!this.opts.bench) return json(404, { ok: false, message: "ベンチマークは使えません" });
      const run = this.opts.bench;
      void run(bench[1]!).then(
        (result) => json(result.ok ? 202 : 409, result),
        () => json(500, { ok: false, message: "開始できませんでした" }),
      );
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("ok\n");
      return;
    }
    if (path === "/api/state") {
      res
        .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        .end(req.method === "HEAD" ? undefined : JSON.stringify(this.opts.snapshot()));
      return;
    }
    if (path === "/api/history") {
      const key = new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "";
      res
        .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        .end(JSON.stringify(this.opts.history && /^[\w:.-]{1,80}$/.test(key) ? this.opts.history(key) : []));
      return;
    }
    if (path === "/api/stream") {
      this.stream(req, res);
      return;
    }
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end('{"error":"not found"}');
      return;
    }
    this.serveStatic(path, req, res);
  }

  private async recipe(req: IncomingMessage, res: ServerResponse, id: string, op: RecipeOp): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    const actions = this.opts.recipes;
    if (!actions) return json(404, { ok: false, message: "レシピは設定されていません" });
    const wantMethod = op === "logs" ? "GET" : "POST";
    if (req.method !== wantMethod) {
      res.writeHead(405, { Allow: wantMethod }).end();
      return;
    }
    if (op !== "logs" && req.headers[ACTION_HEADER] !== "1") {
      return json(403, { ok: false, message: "この操作はダッシュボードの画面から行ってください" });
    }
    try {
      if (op === "logs") {
        const source = new URL(req.url ?? "/", "http://x").searchParams.get("source") === "server" ? "server" : "launcher";
        return json(200, await actions.logs(id, source));
      }
      // Answer as soon as the action is accepted; progress arrives over the stream.
      const result =
        op === "start"
          ? actions.start(id)
          : op === "stop"
            ? actions.stop(id)
            : op === "check"
              ? actions.check(id)
              : op === "switch"
                ? actions.switchTo(id)
                : actions.update(id);
      this.opts.changed?.();
      const done = await Promise.race([result, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      void result.finally(() => this.opts.changed?.());
      const pending: Record<Exclude<RecipeOp, "logs">, string> = {
        start: "起動を開始しました",
        stop: "停止しています",
        check: "確認しています",
        update: "更新しています",
        switch: "切り替えています",
      };
      return json(done && !done.ok ? 409 : 202, done ?? { ok: true, message: pending[op] });
    } catch {
      return json(500, { ok: false, message: "操作中にエラーが発生しました" });
    }
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\ndata: ${JSON.stringify(this.opts.snapshot())}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private serveStatic(path: string, req: IncomingMessage, res: ServerResponse): void {
    const root = this.opts.staticDir;
    const wanted = normalize(join(root, path));
    const inside = wanted === root || wanted.startsWith(root + sep);
    let file = inside ? wanted : null;
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file || !existsSync(file)) {
      // Unknown paths without an extension are client-side routes.
      const index = join(root, "index.html");
      if (extname(path) !== "" || !existsSync(index)) {
        const hint = existsSync(index) ? "Not found\n" : "The web client has not been built yet. Run: pnpm build\n";
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(hint);
        return;
      }
      file = index;
    }
    const ext = extname(file);
    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // Vite fingerprints everything under /assets.
      "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      const mtimeMs = statSync(file).mtimeMs;
      let cached = this.gzipCache.get(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = { mtimeMs, body: gzipSync(readFileSync(file)) };
        this.gzipCache.set(file, cached);
      }
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      res.end(req.method === "HEAD" ? undefined : cached.body);
      return;
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }
}

function decodePath(url: string): string | null {
  try {
    const path = decodeURIComponent(url.split("?")[0]!);
    return path.includes("\0") ? null : path;
  } catch {
    return null;
  }
}
