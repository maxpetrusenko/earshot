import { spawn } from "node:child_process";
import { accessSync, constants, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSvg } from "./svg-sanitize.js";

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
  /** Base64 MP3 of the edited track. */
  edited: string;
  /** Base64 MP3 of the original; null when it was dropped to fit the budget. */
  original: string | null;
  /** The memo title, one line. Escaped. */
  title?: string;
  /** The memo sketch. Run through the SVG sanitizer here. */
  svg?: string;
  /** Initial status text, e.g. why the original is missing. Escaped. */
  note?: string;
}

export const b64 = (b: Buffer): string => b.toString("base64");

const PAGE_CSS = `body{margin:0;font-family:var(--font-sans,system-ui);background:var(--background,#fff);color:var(--foreground,#171717)}
.ti{padding:10px 12px 4px;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk{padding:4px 12px;text-align:center}
.sk svg{max-height:220px;max-width:100%;width:auto;height:auto}
.bar{padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px}
#sk{width:100%;margin:0;height:4px;accent-color:var(--primary,#1f6f5c);cursor:pointer}
.ctl{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid var(--border,#ddd);background:var(--secondary,#f4f4f4);color:var(--secondary-foreground,#171717);cursor:pointer}
button.sel{border-color:var(--primary,#1f6f5c)}
button.on{background:var(--primary,#1f6f5c);color:var(--primary-foreground,#fff);border-color:transparent}
#tm{margin-left:auto;font-size:13px;font-variant-numeric:tabular-nums;color:var(--muted-foreground,#666)}
#st{font-size:13px;color:var(--destructive,#b42318)}#st:empty{display:none}`;

/**
 * Player script. Web Audio only: Orca's CSP blocks media data: URLs, so an audio element cannot play the embedded MP3.
 * Position is offset + (context time - start time) * rate; every seek, skip or speed change stops the source and restarts it.
 */
const PAGE_JS = `const A=__AUDIO__;
const $=id=>document.getElementById(id);
const be=$('be'),bo=$('bo'),bs=$('sk'),tm=$('tm'),st=$('st'),bb=$('bk'),bf=$('fw'),sp=$('sp');
const names={e:'Play',o:'Original'},btn={e:be,o:bo},rates=[1,1.25,1.5,2];
let ctx,gain,src=null,cur='e',ri=0,t0=0,drag=false;const off={e:0,o:0},buf={};
const fmt=s=>{s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const dur=()=>buf[cur]?buf[cur].duration:0;
const pos=()=>src?Math.min(dur(),off[cur]+(ctx.currentTime-t0)*rates[ri]):off[cur];
function ui(){const p=pos(),d=dur();for(const k in btn){if(!btn[k])continue;const on=!!src&&cur===k;btn[k].textContent=on?'Pause':names[k];btn[k].className=on?'on':cur===k?'sel':''}
if(!drag)bs.value=d?Math.round(p/d*1000):0;tm.textContent=fmt(drag?bs.value/1000*d:p)+' / '+fmt(d);sp.textContent=rates[ri]+'x'}
function halt(){if(src){off[cur]=pos();src.onended=null;try{src.stop()}catch(_){}src.disconnect();src=null}}
function begin(){const s=ctx.createBufferSource();s.buffer=buf[cur];s.playbackRate.value=rates[ri];s.connect(gain);t0=ctx.currentTime;s.onended=()=>{if(src===s){src=null;off[cur]=0;ui()}};src=s;s.start(0,off[cur])}
function pause(){halt();ui()}
function play(k){if(src&&cur===k)return pause();halt();cur=k;if(off[k]>=buf[k].duration-0.05)off[k]=0;begin();ui()}
function seek(s){const was=!!src;halt();off[cur]=Math.max(0,Math.min(dur()-0.01,s));if(was)begin();ui()}
async function load(){const C=window.AudioContext||window.webkitAudioContext;ctx=new C();gain=ctx.createGain();gain.gain.value=typeof window.__earshotGain==='number'?window.__earshotGain:1;gain.connect(ctx.destination);
for(const k in A){const bin=atob(A[k]),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);buf[k]=await ctx.decodeAudioData(u.buffer)}ui()}
const fail=x=>{st.textContent='Audio error: '+(x&&x.name||'')+' '+(x&&x.message||'')};
const ready=load().catch(x=>{fail(x)});
const act=f=>()=>{try{if(ctx)ctx.resume().catch(fail);if(buf.e)f();else ready.then(()=>{if(buf.e)f()}).catch(fail)}catch(x){fail(x)}};
be.onclick=act(()=>play('e'));if(bo)bo.onclick=act(()=>play('o'));
bb.onclick=act(()=>seek(pos()-10));bf.onclick=act(()=>seek(pos()+10));
sp.onclick=act(()=>{const p=pos(),was=!!src;halt();off[cur]=p;ri=(ri+1)%rates.length;if(was)begin();ui()});
bs.oninput=()=>{drag=true;ui()};
bs.onchange=act(()=>{drag=false;seek(bs.value/1000*dur())});
document.addEventListener('keydown',e=>{if(e.code!=='Space'||e.target.tagName==='BUTTON')return;e.preventDefault();act(()=>play(cur))()});
setInterval(()=>{if(buf.e&&src)ui()},100);`;

/**
 * One self-contained page for Orca's inline visual: the memo's sketch and title on top, a compact control bar at the bottom.
 * Theme tokens are read with fallbacks and never redefined; there is no network access and no 100vh.
 */
export function renderOrcaHtml(p: PageInput): string {
  const orig = p.original !== null;
  const audio = `{e:"${p.edited}"${orig ? `,o:"${p.original}"` : ""}}`;
  const svg = p.svg ? sanitizeSvg(p.svg) : "";
  const title = p.title ? `<div class="ti">${escapeHtml(p.title)}</div>` : "";
  const sketch = svg.includes("<svg") ? `<div class="sk">${svg}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${PAGE_CSS}
</style></head><body tabindex="0">
${title}${sketch}
<div class="bar"><input id="sk" type="range" min="0" max="1000" value="0" aria-label="Seek">
<div class="ctl"><button class="sel" id="be">Play</button>${orig ? '<button id="bo">Original</button>' : ""}<button id="bk" aria-label="Back 10 seconds">-10</button><button id="fw" aria-label="Forward 10 seconds">+10</button><button id="sp" aria-label="Speed">1x</button><span id="tm">0:00 / 0:00</span></div>
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

/** Page bytes for audio of this length at this bitrate: CBR size, base64 growth, the markup and the sketch. */
export const predictPageBytes = (seconds: number, kbps: number, extra = 0): number => Math.ceil((seconds * kbps * 125 * 4) / 3) + 7000 + extra;

export interface FitOptions {
  budget?: number;
  reencode?: Reencode;
  editedSeconds?: number;
  originalSeconds?: number;
  title?: string;
  svg?: string;
}

/**
 * Pick the highest bitrate whose whole page should fit, encode once, and step down only if the real page is over.
 * Both tracks together go first; if even 16k is too big, the original is dropped and the page says so.
 */
export async function fitOrcaPage(edited: Buffer, original: Buffer | null, opts: FitOptions = {}): Promise<Fitted> {
  const budget = opts.budget ?? ORCA_BUDGET_BYTES;
  const enc = opts.reencode ?? ffmpegReencode;
  const size = (html: string) => Buffer.byteLength(html);
  const meta = { ...(opts.title ? { title: opts.title } : {}), ...(opts.svg ? { svg: opts.svg } : {}) };
  const total = (opts.editedSeconds ?? 0) + (original ? (opts.originalSeconds ?? 0) : 0);
  const start = total > 0 ? Math.max(0, ORCA_BITRATES.findIndex((k) => predictPageBytes(total, k, Buffer.byteLength(opts.svg ?? "")) <= budget)) : 0;
  let last: { kbps: number; e: Buffer } | null = null;
  for (const kbps of ORCA_BITRATES.slice(start)) {
    const [e, o] = await Promise.all([enc(edited, kbps), original ? enc(original, kbps) : Promise.resolve(null)]);
    last = { kbps, e };
    const html = renderOrcaHtml({ ...meta, edited: b64(e), original: o ? b64(o) : null, ...(original ? {} : { note: "The original track is not available." }) });
    if (size(html) <= budget) return { html, bytes: size(html), kbps, droppedOriginal: original === null };
  }
  const { kbps, e } = last!;
  const html = renderOrcaHtml({ ...meta, edited: b64(e), original: null, note: "The original track did not fit in this player." });
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

/** The chat line Orca turns into an inline page (Mac). The markdown Listen line goes after it, for the phone. */
export const orcaLine = (file: string, title = "Listen"): string => `::orca-visual{file="${file}" title="${title}"}`;

/** An earshot Orca line in a reply: the skill already ran. */
const ORCA_LINE = /^::orca-visual\{file="earshot-[A-Za-z0-9]+\.html"/m;
export const hasOrcaLine = (text: string): boolean => ORCA_LINE.test(text);

export function writeOrcaPage(dir: string, id: string, html: string): string {
  const file = orcaFileName(id);
  writeFileSync(join(dir, file), html, { mode: 0o600 });
  return file;
}
