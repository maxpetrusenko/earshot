import { spawn } from "node:child_process";
import { accessSync, constants, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Orca reads the page from $ORCA_CHAT_SCRATCH_DIR; the file must stay under 512 KB, we aim lower. */
export const ORCA_BUDGET_BYTES = 480_000;
/** Bitrates tried in order: the first whole page that fits wins. */
export const ORCA_BITRATES = [24, 20, 16] as const;

export type Reencode = (mp3: Buffer, kbps: number) => Promise<Buffer>;

/** Mono, 22.05 kHz, small CBR MP3: enough for speech, small enough to inline. */
export const ffmpegReencode: Reencode = (mp3, kbps) =>
  new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "22050", "-b:a", `${kbps}k`, "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => reject(new Error(`ffmpeg is needed for --format orca: ${e.message}`)));
    child.on("close", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 160)}`))));
    child.stdin.end(mp3);
  });

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PageInput {
  /** Audio source for the edited track: a data URL (inline) or the served MP3 URL (stream). */
  edited: string;
  /** null when the original track was dropped to fit the budget. */
  original: string | null;
  /** Shown under the buttons, e.g. why the original is missing. Escaped. */
  note?: string;
}

export const dataUrl = (b: Buffer): string => `data:audio/mpeg;base64,${b.toString("base64")}`;

/**
 * One self-contained page for Orca's inline visual: two buttons, one audio element each, only one plays at a time.
 * Theme tokens are read with fallbacks and never redefined; there is no network access and no 100vh.
 */
export function renderOrcaHtml(p: PageInput): string {
  const orig = p.original !== null;
  const buttons = `<button class="main" id="be">Play</button>${orig ? '<button id="bo">Original</button>' : ""}`;
  const audios = `<audio id="ae" preload="auto" src="${escapeHtml(p.edited)}"></audio>${orig ? `<audio id="ao" preload="auto" src="${escapeHtml(p.original!)}"></audio>` : ""}`;
  const note = p.note ? `<div class="t">${escapeHtml(p.note)}</div>` : "";
  const pairs = orig ? "[[be,ae,'Play'],[bo,ao,'Original']]" : "[[be,ae,'Play']]";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;font-family:var(--font-sans,system-ui);background:var(--background,#fff);color:var(--foreground,#171717)}
.row{display:flex;gap:10px;padding:10px;align-items:center}
button{flex:1;font:inherit;font-size:17px;padding:14px 10px;border-radius:var(--radius,12px);border:1px solid var(--border,#ddd);background:var(--secondary,#f4f4f4);color:var(--secondary-foreground,#171717)}
button.main{background:var(--primary,#1f6f5c);color:var(--primary-foreground,#fff);border-color:transparent}
.t{font-size:13px;color:var(--muted-foreground,#666);padding:0 12px 10px}
</style></head><body>
<div class="row">${buttons}</div>
<div class="t" id="tm">0:00</div>${note}
${audios}
<script>
const p=${pairs};
function f(s){s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
p.forEach(([b,a,l])=>{b.onclick=()=>{p.forEach(([b2,a2,l2])=>{if(a2!==a){a2.pause();b2.textContent=l2}});if(a.paused){a.play();b.textContent='Pause'}else{a.pause();b.textContent=l}};
a.ontimeupdate=()=>{tm.textContent=f(a.currentTime)+' / '+f(a.duration)};a.onended=()=>{b.textContent=l}});
</script></body></html>
`;
}

export interface Fitted {
  html: string;
  bytes: number;
  kbps: number;
  droppedOriginal: boolean;
}

/** Page bytes for audio of this length at this bitrate: CBR size, base64 growth, a little markup. */
export const predictPageBytes = (seconds: number, kbps: number): number => Math.ceil((seconds * kbps * 125 * 4) / 3) + 3000;

/**
 * Pick the highest bitrate whose whole page should fit, encode once, and step down only if the real page is over.
 * Both tracks together go first; if even 16k is too big, the original is dropped and the page says so.
 */
export async function fitOrcaPage(edited: Buffer, original: Buffer | null, opts: { budget?: number; reencode?: Reencode; editedSeconds?: number; originalSeconds?: number } = {}): Promise<Fitted> {
  const budget = opts.budget ?? ORCA_BUDGET_BYTES;
  const enc = opts.reencode ?? ffmpegReencode;
  const size = (html: string) => Buffer.byteLength(html);
  const total = (opts.editedSeconds ?? 0) + (original ? (opts.originalSeconds ?? 0) : 0);
  const start = total > 0 ? Math.max(0, ORCA_BITRATES.findIndex((k) => predictPageBytes(total, k) <= budget)) : 0;
  let last: { kbps: number; e: Buffer } | null = null;
  for (const kbps of ORCA_BITRATES.slice(start)) {
    const [e, o] = await Promise.all([enc(edited, kbps), original ? enc(original, kbps) : Promise.resolve(null)]);
    last = { kbps, e };
    const html = renderOrcaHtml({ edited: dataUrl(e), original: o ? dataUrl(o) : null, ...(original ? {} : { note: "The original track is not available." }) });
    if (size(html) <= budget) return { html, bytes: size(html), kbps, droppedOriginal: original === null };
  }
  const { kbps, e } = last!;
  const html = renderOrcaHtml({ edited: dataUrl(e), original: null, note: "The original track did not fit in this player." });
  if (size(html) > budget) throw new Error(`the edited track alone is ${size(html)} bytes at ${kbps}k, over the ${budget} byte budget`);
  return { html, bytes: size(html), kbps, droppedOriginal: true };
}

/** The scratch dir if it is set to a writable directory, else null. */
export function orcaDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = flag || env.ORCA_CHAT_SCRATCH_DIR;
  if (!dir) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

export const orcaFileName = (id: string): string => `earshot-${id}.html`;

/** The one chat line Orca turns into an inline page. */
export const orcaLine = (file: string, title = "Listen"): string => `::orca-visual{file="${file}" title="${title}"}`;

/** An earshot Orca line in a reply: the skill already ran. */
const ORCA_LINE = /^::orca-visual\{file="earshot-[A-Za-z0-9]+\.html"/m;
export const hasOrcaLine = (text: string): boolean => ORCA_LINE.test(text);

export function writeOrcaPage(dir: string, id: string, html: string): string {
  const file = orcaFileName(id);
  writeFileSync(join(dir, file), html, { mode: 0o600 });
  return file;
}
