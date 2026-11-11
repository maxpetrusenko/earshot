import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { briefDir } from "./bundle.js";
import { isValidId } from "./lib/id.js";
import { sweepBrief } from "./sweep.js";

const ASSET_ROOT = new URL("../assets/", import.meta.url);

/** The only files a brief exposes. input.txt and script.md are deliberately absent. */
export const SERVED_FILES: Record<string, string> = {
  "memo.mp3": "audio/mpeg",
  "sketch.svg": "image/svg+xml",
  "sketch.png": "image/png",
  "meta.json": "application/json; charset=utf-8",
};

const CARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SVG_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox";

interface Asset {
  body: Buffer;
  type: string;
}

async function loadAssets(): Promise<Map<string, Asset>> {
  const map = new Map<string, Asset>();
  const add = async (rel: string, type: string) =>
    map.set(`/assets/${rel}`, { body: await readFile(new URL(rel, ASSET_ROOT)), type });
  await add("card.css", "text/css; charset=utf-8");
  await add("card.js", "text/javascript; charset=utf-8");
  for (const f of await readdir(new URL("fonts/", ASSET_ROOT))) {
    if (f.endsWith(".woff2")) await add(`fonts/${f}`, "font/woff2");
  }
  return map;
}

function baseHeaders(type: string, csp?: string): Record<string, string> {
  return {
    "Content-Type": type,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...(csp ? { "Content-Security-Policy": csp } : {}),
  };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, csp?: string, head = false) {
  res.writeHead(status, { ...baseHeaders(type, csp), "Content-Length": Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

const notFound = (res: ServerResponse, head = false) =>
  send(res, 404, "text/plain; charset=utf-8", "Not found\n", "default-src 'none'", head);

export function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header ? "invalid" : null;
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] === "") return "invalid";
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, csp?: string) {
  const head = req.method === "HEAD";
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile()) return notFound(res, head);
  const h = baseHeaders(type, csp);
  h["Accept-Ranges"] = "bytes";
  const range = parseRange(req.headers.range ?? "", st.size);
  if (range === "invalid") {
    res.writeHead(416, { ...h, "Content-Range": `bytes */${st.size}` });
    return res.end();
  }
  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : st.size;
  const headers = range
    ? { ...h, "Content-Length": length, "Content-Range": `bytes ${range.start}-${range.end}/${st.size}` }
    : { ...h, "Content-Length": length };
  if (head) {
    res.writeHead(status, headers);
    return res.end();
  }
  pipeFile(res, createReadStream(path, range ?? undefined), status, headers);
}

/**
 * Send headers only after the file has opened, so an unreadable file is a clean 404 instead of a
 * half-written 200. A later read error or a closed client tears the stream down without crashing.
 */
function pipeFile(res: ServerResponse, stream: ReturnType<typeof createReadStream>, status: number, headers: Record<string, string | number>) {
  stream.once("error", () => notFound(res));
  stream.once("open", () => {
    stream.removeAllListeners("error");
    stream.on("error", () => res.destroy());
    res.writeHead(status, headers);
    stream.pipe(res);
  });
  res.on("close", () => stream.destroy());
}

export async function createEarshotServer(): Promise<Server> {
  const assets = await loadAssets();
  return createServer((req, res) => {
    handle(req, res, assets).catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Error\n");
      else res.destroy();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, assets: Map<string, Asset>) {
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) {
    res.writeHead(405, { ...baseHeaders("text/plain; charset=utf-8"), Allow: "GET, HEAD" });
    return res.end();
  }
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";

  if (pathname === "/healthz") return send(res, 200, "application/json", '{"ok":true}\n', undefined, head);

  const asset = assets.get(pathname);
  if (asset) return send(res, 200, asset.type, asset.body, undefined, head);

  const parts = pathname.split("/");
  if (parts[1] !== "b" || parts.length < 3 || parts.length > 4) return notFound(res, head);
  let id: string;
  let file: string | undefined;
  try {
    id = decodeURIComponent(parts[2] ?? "");
    file = parts[3] === undefined ? undefined : decodeURIComponent(parts[3]);
  } catch {
    return notFound(res, head);
  }
  if (!isValidId(id)) return notFound(res, head);

  // The card polls meta.json, so this is where a dead worker's brief stops showing "pending".
  if (file === undefined || file === "meta.json") sweepBrief(id);
  if (file === undefined) {
    const cardPath = join(briefDir(id), "card.html");
    const st = await lstat(cardPath).catch(() => null);
    const html = st?.isFile() ? await readFile(cardPath).catch(() => null) : null;
    return html ? send(res, 200, "text/html; charset=utf-8", html, CARD_CSP, head) : notFound(res, head);
  }
  const type = Object.hasOwn(SERVED_FILES, file) ? SERVED_FILES[file] : undefined;
  if (!type) return notFound(res, head);
  // `file` is now one of the four allowlisted constants, so the join cannot leave the brief directory.
  return serveFile(req, res, join(briefDir(id), file), type, file.endsWith(".svg") ? SVG_CSP : undefined);
}
