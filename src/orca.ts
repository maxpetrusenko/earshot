import { spawn } from "node:child_process";
import { accessSync, constants, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Orca reads the page from $ORCA_CHAT_SCRATCH_DIR; the file must stay under 512 KB, we aim lower. */
export const ORCA_BUDGET_BYTES = 480_000;
/** Bitrates tried in order: the first whole page that fits wins. */
export const ORCA_BITRATES = [24, 20, 16] as const;
/**
 * Orca's visual shell (native-chat-visual-shell) sizes the frame from `documentElement.getBoundingClientRect().height`
 * (plus any body overflow), ignores a height of 0 (the frame then keeps its 160 px default) and clamps what it gets
 * to at least 80 px. So the page height is the content height, never below 80, and nothing may add to it.
 */
export const ORCA_MIN_FRAME_PX = 80;

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
  /** Base64 MP3 of the edited track. */
  edited: string;
  /** Base64 MP3 of the original; null when it was dropped to fit the budget. */
  original: string | null;
  /** Initial status text, e.g. why the original is missing. Escaped. */
  note?: string;
}

export const b64 = (b: Buffer): string => b.toString("base64");

const PAGE_CSS = `html,body{margin:0;padding:0;height:auto;min-height:0}
body{font-family:var(--font-sans,system-ui);background:var(--background,#fff);color:var(--foreground,#171717)}
html.ios,html.ios body{margin:0;padding:0;overflow:hidden}
html.ios body{height:1px;visibility:hidden}
html.ios .bar{display:none}
.bar{box-sizing:border-box;min-height:${ORCA_MIN_FRAME_PX}px;padding:0 12px;display:flex;flex-direction:column;justify-content:center;gap:6px}
.ctl{display:flex;flex-wrap:nowrap;gap:10px;align-items:center}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid var(--border,#ddd);background:var(--secondary,#f4f4f4);color:var(--secondary-foreground,#171717);cursor:pointer}
#pp{min-width:68px}
button.on{background:var(--primary,#1f6f5c);color:var(--primary-foreground,#fff);border-color:transparent}
.tg{display:inline-flex;border:1px solid var(--border,#ddd);border-radius:999px;overflow:hidden}
.tg button{border:0;border-radius:0;background:transparent}
.tg button.sel{background:var(--primary,#1f6f5c);color:var(--primary-foreground,#fff)}
#tm{margin-left:auto;font-size:13px;font-variant-numeric:tabular-nums;color:var(--muted-foreground,#666);white-space:nowrap}
#st{font-size:13px;color:var(--destructive,#b42318)}#st:empty{display:none}`;

/**
 * iOS and iPadOS cannot tap an Orca visual, so the player renders nothing there and collapses to zero height.
 * iPadOS reports a Mac user agent, so a Mac with touch points counts as an iPad. Runs before the body is parsed.
 */
export const IOS_DETECT = `(function(){var n=navigator,u=n.userAgent||'';if(/iPhone|iPad|iPod/.test(u)||(/Macintosh|MacIntel/.test(u+(n.platform||''))&&n.maxTouchPoints>1))document.documentElement.className='ios'})();`;

/**
 * Player script. Web Audio only: Orca's CSP blocks media data: URLs, so an audio element cannot play the embedded MP3.
 * One row: play or pause, a Listen / Original toggle, elapsed and total time. Position is offset + (context time -
 * start time); switching track stops the source and starts the other one at its own saved position.
 */
const PAGE_JS = `if(document.documentElement.className!=='ios'){const A=__AUDIO__;
const $=id=>document.getElementById(id);
const pp=$('pp'),be=$('be'),bo=$('bo'),tm=$('tm'),st=$('st');
const btn={e:be,o:bo};
let ctx,gain,src=null,cur='e',t0=0;const off={e:0,o:0},buf={};
const fmt=s=>{s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const dur=()=>buf[cur]?buf[cur].duration:0;
const pos=()=>src?Math.min(dur(),off[cur]+(ctx.currentTime-t0)):off[cur];
function ui(){pp.textContent=src?'Pause':'Play';pp.className=src?'on':'';
for(const k in btn){if(!btn[k])continue;const on=cur===k;btn[k].className=on?'sel':'';btn[k].setAttribute('aria-pressed',on)}
tm.textContent=fmt(pos())+' / '+fmt(dur())}
function halt(){if(src){off[cur]=pos();src.onended=null;try{src.stop()}catch(_){}src.disconnect();src=null}}
function begin(){const s=ctx.createBufferSource();s.buffer=buf[cur];s.connect(gain);t0=ctx.currentTime;s.onended=()=>{if(src===s){src=null;off[cur]=0;ui()}};src=s;s.start(0,off[cur])}
function toggle(){if(src){halt();ui();return}if(off[cur]>=buf[cur].duration-0.05)off[cur]=0;begin();ui()}
function pick(k){const was=!!src;halt();cur=k;if(off[k]>=buf[k].duration-0.05)off[k]=0;if(was)begin();ui()}
async function load(){const C=window.AudioContext||window.webkitAudioContext;ctx=new C();gain=ctx.createGain();gain.gain.value=typeof window.__earshotGain==='number'?window.__earshotGain:1;gain.connect(ctx.destination);
for(const k in A){const bin=atob(A[k]),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);buf[k]=await ctx.decodeAudioData(u.buffer)}ui()}
const fail=x=>{st.textContent='Audio error: '+(x&&x.name||'')+' '+(x&&x.message||'')};
const ready=load().catch(x=>{fail(x)});
const act=f=>()=>{try{if(ctx)ctx.resume().catch(fail);if(buf.e)f();else ready.then(()=>{if(buf.e)f()}).catch(fail)}catch(x){fail(x)}};
pp.onclick=act(toggle);be.onclick=act(()=>pick('e'));if(bo)bo.onclick=act(()=>pick('o'));
document.addEventListener('keydown',e=>{if(e.code!=='Space'||e.target.tagName==='BUTTON')return;e.preventDefault();act(toggle)()});
setInterval(()=>{if(buf.e&&src)ui()},100)}`;

/**
 * The player page: one compact row and nothing else, no title and no image. On iOS it collapses to zero height.
 * Theme tokens are read with fallbacks and never redefined; there is no network access and no 100vh.
 */
export function renderPlayerHtml(p: PageInput): string {
  const orig = p.original !== null;
  const audio = `{e:"${p.edited}"${orig ? `,o:"${p.original}"` : ""}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>${IOS_DETECT}</script>
<style>
${PAGE_CSS}
</style></head><body tabindex="0">
<div class="bar"><div class="ctl"><button id="pp" aria-label="Play or pause">Play</button><div class="tg" role="group" aria-label="Track">${orig ? '<button class="sel" id="be" aria-pressed="true">Listen</button><button id="bo" aria-pressed="false">Original</button>' : '<button class="sel" id="be" aria-pressed="true">Listen</button>'}</div><span id="tm">0:00 / 0:00</span></div>
<div id="st">${p.note ? escapeHtml(p.note) : ""}</div></div>
<script>
${PAGE_JS.replace("__AUDIO__", () => audio)}
</script></body></html>
`;
}

export interface Fitted {
  html: string;
  bytes: number;
  kbps: number;
  droppedOriginal: boolean;
}

/** Page bytes for audio of this length at this bitrate: CBR size, base64 growth and the markup. */
export const predictPageBytes = (seconds: number, kbps: number, extra = 0): number => Math.ceil((seconds * kbps * 125 * 4) / 3) + 7000 + extra;

export interface FitOptions {
  budget?: number;
  reencode?: Reencode;
  editedSeconds?: number;
  originalSeconds?: number;
}

/**
 * Pick the highest bitrate whose whole page should fit, encode once, and step down only if the real page is over.
 * Both tracks together go first; if even 16k is too big, the original is dropped and the page says so.
 */
export async function fitOrcaPage(edited: Buffer, original: Buffer | null, opts: FitOptions = {}): Promise<Fitted> {
  const budget = opts.budget ?? ORCA_BUDGET_BYTES;
  const enc = opts.reencode ?? ffmpegReencode;
  const size = (html: string) => Buffer.byteLength(html);
  const total = (opts.editedSeconds ?? 0) + (original ? (opts.originalSeconds ?? 0) : 0);
  const start = total > 0 ? Math.max(0, ORCA_BITRATES.findIndex((k) => predictPageBytes(total, k) <= budget)) : 0;
  let last: { kbps: number; e: Buffer } | null = null;
  for (const kbps of ORCA_BITRATES.slice(start)) {
    const [e, o] = await Promise.all([enc(edited, kbps), original ? enc(original, kbps) : Promise.resolve(null)]);
    last = { kbps, e };
    const html = renderPlayerHtml({ edited: b64(e), original: o ? b64(o) : null, ...(original ? {} : { note: "The original track is not available." }) });
    if (size(html) <= budget) return { html, bytes: size(html), kbps, droppedOriginal: original === null };
  }
  const { kbps, e } = last!;
  const html = renderPlayerHtml({ edited: b64(e), original: null, note: "The original track did not fit in this player." });
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

export type OrcaKind = "player" | "explain" | "explain2" | "explain3";

export const orcaFileName = (id: string, kind: OrcaKind = "player"): string => `earshot-${id}-${kind}.html`;

/** The chat line Orca turns into an inline page (Mac). */
export const orcaLine = (file: string, title = "Listen"): string => `::orca-visual{file="${file}" title="${title}"}`;

/** An earshot Orca line in a reply: the skill already ran. */
/** -flow is the retired diagram page; replies that still carry its line count as narrated. */
const ORCA_LINE = /^::orca-visual\{file="earshot-[A-Za-z0-9]+(?:-player|-explain[23]?|-flow)?\.html"/m;
export const hasOrcaLine = (text: string): boolean => ORCA_LINE.test(text);

/** Written to a temp name and renamed, so Orca never reads half a page while the worker rewrites it. */
export function writeOrcaPage(dir: string, id: string, html: string, kind: OrcaKind = "player"): string {
  const file = orcaFileName(id, kind);
  const tmp = join(dir, `.${file}.tmp`);
  writeFileSync(tmp, html, { mode: 0o600 });
  renameSync(tmp, join(dir, file));
  return file;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#8217": "\u2019" };

/** The page's own headline, for the `title` on an Orca line. Null when the page has no h1. */
export function pageTitle(html: string): string | null {
  const raw = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** Opt-in only (`reload: true`). Orca renders a page from the text it read into an iframe srcdoc, so a reload re-renders the same text and never re-reads the file; see docs/orca.md. A pending page keeps asking for itself for this long, then gives up (the worker died or Orca does not re-read files). */
export const PENDING_RELOAD_MS = 120_000;

/**
 * The page that stands in until the audio is ready: the worker rewrites the same file when it is. Orca pages have no
 * network, so the page cannot fetch anything; it only reloads itself while the file may still change.
 * The explain placeholder is collapsed to nothing, like the player on iOS, so an unused one shows no empty frame.
 */
export function renderPendingHtml(kind: OrcaKind, o: { note?: string; reload?: boolean; madeAt?: number; visible?: boolean } = {}): string {
  const madeAt = o.madeAt ?? Date.now();
  const reload = o.reload === true ? `<script>(function(){if(Date.now()-${madeAt}<${PENDING_RELOAD_MS})setTimeout(function(){location.reload()},1500)})();</script>` : "";
  // `--visual` prints the Explain line before any picture exists, so its stand-in is a visible note, not a collapsed frame.
  if (kind !== "player" && o.visible) {
    const note = o.note ?? "Drawing the picture.";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${PAGE_CSS}
#st{color:var(--muted-foreground,#666);display:block}
</style></head><body><div class="bar"><div id="st">${escapeHtml(note)}</div></div>${reload}</body></html>
`;
  }
  if (kind === "explain") return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{display:none;height:0;margin:0;padding:0;overflow:hidden}</style></head><body>${reload}</body></html>\n`;
  const note = o.note ?? "Preparing audio. The Listen link works now.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>${IOS_DETECT}</script>
<style>
${PAGE_CSS}
#st{color:var(--muted-foreground,#666);display:block}
</style></head><body><div class="bar"><div id="st">${escapeHtml(note)}</div></div>${reload}</body></html>
`;
}
