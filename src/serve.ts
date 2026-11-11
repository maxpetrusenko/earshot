import { createReadStream, readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { briefDir, readFileInBundle, readMeta, withLegacyTracks, type TrackName } from "./bundle.js";
import { renderCard } from "./card.js";
import { isValidId } from "./lib/id.js";
import { sweepBrief } from "./sweep.js";

const ASSET_ROOT = new URL("../assets/", import.meta.url);

/** The only files a brief exposes. input.txt, script.md and the internal chunk files (edited-000.mp3 ...) are deliberately absent. */
export const SERVED_FILES: Record<string, string> = {
  "memo.mp3": "audio/mpeg", // briefs made before tracks existed; also the fallback for edited.mp3 there
  "edited.mp3": "audio/mpeg",
  "original.mp3": "audio/mpeg",
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

const STREAM_POLL_MS = 60;
const STREAM_MAX_MS = 15 * 60_000;
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One growing MP3 over chunked transfer: send the chunk files already written, then keep appending as new ones
 * land, and end when the track is ready or failed. A listener that opens the link while the memo is still being
 * made starts hearing audio at the first chunk. Range requests are answered with the stream from the start.
 */
async function streamTrack(req: IncomingMessage, res: ServerResponse, id: string, track: TrackName) {
  res.writeHead(200, { ...baseHeaders("audio/mpeg"), "Accept-Ranges": "none", "X-Accel-Buffering": "no" });
  res.socket?.setNoDelay(true);
  res.flushHeaders(); // the player sees a live stream at once and waits for the first chunk
  if (req.method === "HEAD") return res.end();
  let open = true;
  res.on("close", () => (open = false));
  const deadline = Date.now() + STREAM_MAX_MS;
  let sent = 0;
  let sweptAt = Date.now();
  while (open && Date.now() < deadline) {
    const meta = readMeta(id);
    const t = meta?.tracks?.[track];
    if (!t) break;
    for (; sent < t.chunks.length && open; sent++) {
      const buf = readFileInBundle(id, t.chunks[sent]!.file);
      if (!buf) return res.destroy();
      if (!res.write(buf)) await new Promise<void>((r) => (res.once("drain", r), res.once("close", r)));
    }
    if (t.status !== "pending") break;
    if (meta!.status !== "pending") break; // the worker finished or died without finishing this track
    if (Date.now() - sweptAt > 5000) {
      sweptAt = Date.now();
      sweepBrief(id);
    }
    await nap(STREAM_POLL_MS);
  }
  if (open) res.end();
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
    const old = readMeta(id);
    if (old && old.tracks === undefined) {
      // An old-format brief: render its card from the current template so the player works.
      const meta = withLegacyTracks(old);
      let script: string | null = null;
      try {
        script = readFileSync(join(briefDir(id), "script.md"), "utf8").split("\n\n").slice(1).join("\n\n").trim() || null;
      } catch {
        /* no transcript */
      }
      return send(res, 200, "text/html; charset=utf-8", renderCard(meta, script), CARD_CSP, head);
    }
    const cardPath = join(briefDir(id), "card.html");
    const st = await lstat(cardPath).catch(() => null);
    const html = st?.isFile() ? await readFile(cardPath).catch(() => null) : null;
    return html ? send(res, 200, "text/html; charset=utf-8", html, CARD_CSP, head) : notFound(res, head);
  }
  const type = Object.hasOwn(SERVED_FILES, file) ? SERVED_FILES[file] : undefined;
  if (!type) return notFound(res, head);
  if (file === "meta.json") {
    const old = readMeta(id);
    if (old && old.tracks === undefined) return send(res, 200, type, `${JSON.stringify(withLegacyTracks(old))}\n`, undefined, head);
  }
  if (file === "edited.mp3" || file === "original.mp3") {
    const track = file === "edited.mp3" ? "edited" : "original";
    const meta = readMeta(id);
    const t = meta && withLegacyTracks(meta).tracks?.[track];
    if (t && t.status === "pending") return streamTrack(req, res, id, track);
    if (!t || t.status !== "ready") return notFound(res, head);
    if (file === "edited.mp3" && meta!.tracks === undefined) file = "memo.mp3"; // old-format brief
  }
  // `file` is now one of the allowlisted constants, so the join cannot leave the brief directory.
  return serveFile(req, res, join(briefDir(id), file), type, file.endsWith(".svg") ? SVG_CSP : undefined);
}
