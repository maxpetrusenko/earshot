import type { FlowLane, Icon, FlowPanel, FlowStep, GridCell, GridPanel, RankedPanel } from "./explain-cards-schema.js";
import { icon } from "./explain-icons.js";
import { escapeHtml as e } from "./orca.js";

/**
 * Flow, ranked and grid bodies for the reference-style page. A flow is a strict step chain in one direction:
 * an icon tile and a real step name per step, the changed step outlined in the accent color, the broken step
 * red with its cause under it. With two lanes the rows are shared: the same row is the same place in the logic,
 * so the eye compares across instead of reading two lists. Light only, phone first, values escaped.
 */

const MONO = `"SF Mono","Menlo","Consolas","Liberation Mono",monospace`;
const DOWN = `<svg viewBox="0 0 20 28" width="20" height="28" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2v20M3.5 16l6.5 7.5 6.5-7.5"/></svg>`;
const RIGHT = `<svg viewBox="0 0 24 20" width="24" height="20" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 10h18M13 3.5l7.5 6.5-7.5 6.5"/></svg>`;
const small = (name: "alert" | "check"): string => icon(name).replace('width="26" height="26"', 'width="16" height="16"');

const TAG: Record<FlowStep["state"], string> = { ok: "", cause: "ROOT CAUSE", masked: "LOOKS FINE", changed: "CHANGED", fixed: "FIXED" };

/**
 * The icon a step is drawn with. The icon follows the state, never the other way round: the cause is the one step that
 * may wear the warning triangle and it never wears a check; a step that is not the cause never shows a warning. The gate
 * rejects the same contradictions so the model rewrites them; this is the guarantee for anything that slips past it.
 */
export function stepIcon(s: Pick<FlowStep, "icon" | "state">): Icon | "" {
  if (s.state === "fixed" && (!s.icon || s.icon === "alert")) return "check";
  if (s.state === "cause") return !s.icon || s.icon === "check" ? "alert" : s.icon;
  if (s.icon === "alert") return s.state === "masked" ? "check" : "gear";
  return s.icon;
}

function stepCard(s: FlowStep, wide: boolean, lane: "before" | "after" | "" = ""): string {
  const word = lane === "before" && s.state === "changed" ? "REPLACED" : TAG[s.state];
  const tag = word ? `<p class="fs-tag">${word}</p>` : "";
  const note = s.note && s.state !== "ok" ? `<p class="fs-note">${s.state === "cause" ? small("alert") : ""}<span>${e(s.note)}</span></p>` : "";
  const fix = s.fix ? `<p class="fs-fix"><b>FIX</b><span>${e(s.fix)}</span></p>` : "";
  const text = `<div class="fs-tx">${tag}<p class="fs-nm">${e(s.name)}</p>${s.detail ? `<p class="fs-dt">${e(s.detail)}</p>` : ""}${note}</div>`;
  return `<div class="fc s-${s.state}${wide ? " wide" : ""}"><div class="sr"><span class="fs-tile">${icon(stepIcon(s))}</span>${text}</div>${fix}</div>`;
}

/** The arrow between two steps, centered under the icon column. The label is the reply's own and only drawn when it gave one. */
const cn = (link = ""): string => `<div class="cn"><span class="cn-a">${DOWN}</span>${link ? `<span class="cn-l">${e(link)}</span>` : ""}</div>`;

/** One lane, top to bottom, a connector arrow between steps. */
function oneLane(l: FlowLane): string {
  return `<div class="fl one">${l.steps.map((s, i) => stepCard(s, true) + (i < l.steps.length - 1 ? cn(s.link) : "")).join("")}</div>`;
}

/** A run of steps that are the same in both lanes: one compact row with the count and the names, not a repeat of each card. */
function unchangedRow(names: string[]): string {
  return `<div class="un"><p class="un-n">${names.length} unchanged ${names.length === 1 ? "step" : "steps"}</p><p class="un-l">${e(names.join(", "))}</p></div>`;
}

/** Two lanes in one grid: BEFORE column, a narrow arrow column, AFTER column. Only the rows that differ are drawn side by side; runs of identical steps collapse into one row. */
function twoLanes(a: FlowLane, b: FlowLane): string {
  const n = Math.min(a.steps.length, b.steps.length);
  const head = `<p class="fl-h">${e(a.label)}</p><span></span><p class="fl-h">${e(b.label)}</p>`;
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length) blocks.push(unchangedRow(run));
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const x = a.steps[i]!;
    const y = b.steps[i]!;
    if (x.state === "ok" && y.state === "ok" && x.name === y.name) {
      run.push(x.name);
      continue;
    }
    flush();
    blocks.push(`${stepCard(x, false, "before")}<span class="fl-mid on">${RIGHT}</span>${stepCard(y, false, "after")}`);
  }
  flush();
  return `<div class="fl two">${head}${blocks.join(`${cn()}<span></span>${cn()}`)}</div>`;
}

export function flowBody(p: FlowPanel): string {
  const [a, b] = p.lanes;
  return `<section class="cd flw">${b ? twoLanes(a!, b) : oneLane(a!)}</section>`;
}

export function rankedBody(p: RankedPanel): string {
  const rows = p.items
    .map((it, i) => `<li class="rk${it.recommended ? " rec" : ""}"><span class="rk-n">${i + 1}</span><div class="rk-tx">${it.recommended ? `<p class="rk-tag">${small("check")}<span>RECOMMENDED</span></p>` : ""}<p class="rk-nm">${e(it.name)}</p>${it.detail ? `<p class="rk-dt">${e(it.detail)}</p>` : ""}</div></li>`)
    .join("");
  return `<section class="cd rkl"><ol>${rows}</ol></section>`;
}

const STATE_WORD: Record<GridCell["state"], string> = { ok: "OK", warn: "WATCH", bad: "DOWN", idle: "IDLE" };

export function gridBody(p: GridPanel): string {
  const cells = p.cells
    .map((c) => `<div class="gc g-${c.state}"><span class="gc-tile">${icon(c.icon)}</span><p class="gc-nm">${e(c.name)}</p><p class="gc-st">${STATE_WORD[c.state]}</p><p class="gc-ln">${e(c.line)}</p></div>`)
    .join("");
  return `<section class="cd gcs"><div class="gcg">${cells}</div></section>`;
}

export const FLOW_CSS = `body.k-flow,body.k-ranked,body.k-grid{--acc:#1b4f9f;--accbg:#eaf1fc;--tile:#e9eef6;--tileink:#2c5fae;--warn:#8a5205;--warnbg:#fdf1dc;--warnline:#b7791f;--rail:#66758f;--bg:#f4f6f1;--eye:#35574a}
body.k-ranked{--bg:#f3f5ef}
body.k-grid{--bg:#f1f4f6;--eye:#3b4a5e}
.flw{padding:16px}
@media(max-width:440px){.pg{padding:24px 16px 32px}.flw{padding:8px}}
.fl{--bd:2px;--pd:16px;--tl:48px}
.fl.one{display:flex;flex-direction:column;align-items:stretch}
.fl .fc{padding:var(--pd);border:var(--bd) solid transparent;border-radius:16px;background:transparent}
.fl .sr{display:flex;gap:16px;align-items:center}
.fl .fs-tile{flex:none;display:grid;place-items:center;width:var(--tl);height:var(--tl);border-radius:16px;background:var(--tile);color:var(--tileink)}
.fl .fs-tile .ic{width:24px;height:24px}
.fs-tx{min-width:0}
.fs-tag{margin:0 0 4px;font-family:${MONO};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.1em}
.fs-nm{margin:0;font-size:20px;line-height:24px;font-weight:700;letter-spacing:-.005em;overflow-wrap:anywhere;text-wrap:pretty}
.fs-dt{margin:4px 0 0;font-size:15px;line-height:20px;color:var(--mute);text-wrap:pretty}
.fs-note{display:flex;gap:8px;align-items:flex-start;margin:8px 0 0;font-size:15px;line-height:20px;font-weight:600;text-wrap:pretty}
.fs-note .ic{flex:none;margin-top:2px}
.fc.s-changed{border-color:var(--acc);background:var(--accbg)}
.fc.s-changed .fs-tile{background:#fff;color:var(--acc);box-shadow:0 0 0 2px var(--acc)}
.fc.s-changed .fs-tag,.fc.s-changed .fs-note{color:var(--acc)}
.fc.s-cause{border-color:var(--bad);background:var(--badbg)}
.fc.s-cause .fs-tile{background:#fff;color:var(--bad);box-shadow:0 0 0 2px var(--bad)}
.fc.s-cause .fs-tag,.fc.s-cause .fs-note{color:var(--bad)}
.fc.s-masked{border-color:var(--warnline);background:var(--warnbg)}
.fc.s-masked .fs-tile{background:#fff;color:var(--warn);box-shadow:0 0 0 2px var(--warnline)}
.fc.s-masked .fs-tag,.fc.s-masked .fs-note{color:var(--warn)}
.fc.s-fixed{border-color:var(--good);background:var(--goodbg)}
.fc.s-fixed .fs-tile{background:#fff;color:var(--good);box-shadow:0 0 0 2px var(--good)}
.fc.s-fixed .fs-tag,.fc.s-fixed .fs-note{color:var(--good)}
.fs-fix{display:flex;gap:8px;align-items:flex-start;margin:16px calc(-1*var(--pd)) calc(-1*var(--pd));padding:8px 16px 8px;border-top:var(--bd) solid var(--good);border-radius:0 0 14px 14px;background:#d3ecde;font-size:15px;line-height:24px;font-weight:700;color:#0b523a;text-wrap:pretty}
.fs-fix b{flex:none;padding:0 8px;border-radius:8px;background:var(--good);color:#fff;font-family:${MONO};font-size:12px;line-height:24px;letter-spacing:.1em}
.un{grid-column:1/-1;margin:0;padding:8px 16px;border:2px dashed var(--line);border-radius:16px;text-align:center}
.un-n{margin:0;font-size:14px;font-weight:700;letter-spacing:.06em;color:var(--mute);text-transform:uppercase}
.un-l{margin:2px 0 0;font-size:14px;line-height:1.25;color:var(--mute)}
.cn{display:flex;align-items:center;justify-content:center;height:32px;color:var(--rail)}
.cn-a{display:flex;justify-content:center;width:var(--tl)}
.cn-l{margin-left:16px;font-family:${MONO};font-size:13px;line-height:16px;font-weight:600;color:var(--mute)}
.fl.one .cn{justify-content:flex-start;padding-left:calc(var(--pd) + var(--bd))}
.fl.two{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);align-items:stretch}
.fl-h{margin:0 0 8px;text-align:center;font-size:13.5px;font-weight:800;letter-spacing:.09em;color:var(--mute)}
.fl.two .sr{flex-direction:column;justify-content:flex-start;text-align:center;gap:8px}
.fl.two .fc{--pd:8px;padding:16px 8px}
.fl.two .fs-nm{font-size:17px;line-height:20px}
.fl.two .fs-dt{font-size:14px;line-height:20px}
.fl.two .fs-note{justify-content:center;text-align:center;font-size:14px;line-height:20px}
.fl-mid{display:flex;align-items:center;justify-content:center;color:var(--acc)}
.rkl{padding:8px 14px}
.rkl ol{list-style:none;margin:0;padding:0}
.rk{display:flex;gap:14px;align-items:center;margin:8px 0;padding:12px 14px;border:2.5px solid transparent;border-radius:18px}
.rk-n{flex:none;width:34px;text-align:center;font-size:36px;line-height:1;font-weight:800;color:#5f6d63}
.rk-nm{margin:0;font-size:20px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.rk-dt{margin:4px 0 0;font-size:15.5px;line-height:1.3;color:var(--mute)}
.rk.rec{border-color:var(--good);background:var(--goodbg)}
.rk.rec .rk-n{color:var(--good)}
.rk-tag{display:flex;gap:6px;align-items:center;margin:0 0 3px;font-size:12.5px;font-weight:800;letter-spacing:.08em;color:var(--good)}
.gcs{padding:12px}
.gc:last-child:nth-child(odd){grid-column:1/-1}
.gcg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gc{position:relative;padding:12px 12px 13px 16px;border-radius:15px;background:#f6f8fa;border:1.5px solid var(--line)}
.gc:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:5px;border-radius:0 4px 4px 0;background:var(--good)}
.gc.g-warn:before{background:#c67a12}.gc.g-bad:before{background:var(--bad)}.gc.g-idle:before{background:#8d998f}
.gc-tile{display:inline-grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--tile);color:var(--tileink)}
.gc-tile .ic{width:22px;height:22px}
.gc-nm{margin:8px 0 0;font-size:18px;line-height:1.15;font-weight:800}
.gc-st{margin:3px 0 0;font-size:12.5px;font-weight:800;letter-spacing:.08em;color:var(--good)}
.gc.g-warn .gc-st{color:var(--warn)}.gc.g-bad .gc-st{color:var(--bad)}.gc.g-idle .gc-st{color:var(--mute)}
.gc.g-bad{background:var(--badbg)}.gc.g-warn{background:var(--warnbg)}
.gc-ln{margin:5px 0 0;font-size:14.5px;line-height:1.28;color:var(--ink)}`;
