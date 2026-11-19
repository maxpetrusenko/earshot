import type { Card, CardsPanel, FlowPanel, GridPanel, Layer, LayerItem, LayersPanel, RangePanel, RangeRow, RankedPanel } from "./explain-cards-schema.js";
import { CARDS_CSS } from "./explain-cards-css.js";
import { icon } from "./explain-icons.js";
import { FLOW_CSS, flowBody, gridBody, rankedBody } from "./explain-flow-render.js";
import type { ExplainSpec } from "./explain-schema.js";
import { EN_DASH } from "./explain-util.js";
import { escapeHtml as e } from "./orca.js";

/**
 * Reference-style page: eyebrow, headline, subhead, one to two labeled cards, optional footer line.
 * Light only, phone-first (about 390 px). Every value is escaped; icons are fixed strings.
 */

const DOWN = `<svg class="dn" viewBox="0 0 16 18" width="16" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v13M3 10l5 5 5-5"/></svg>`;

const WAVE = [22, 50, 34, 70, 28, 90, 40, 62, 26, 84, 46, 66, 30, 76, 38, 58, 24, 80, 44, 64, 28, 72, 36, 56];
const waveBars = (n: number): string => Array.from({ length: n }, (_, i) => `<i style="height:${WAVE[i % WAVE.length]}%"></i>`).join("");
const dashes = (n: number): string => "<i></i>".repeat(n);

/** The player bar: the same slot in every state, so the eye compares the contents, not the frames. */
function slot(c: Card): string {
  const play = c.mark === "wave" ? `<svg class="pl" viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M9.5 7.5v9l7-4.5z" fill="#fff"/></svg>` : `<svg class="pl" viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/></svg>`;
  const inner = c.mark === "wave" ? `<div class="mk wave">${waveBars(26)}</div>` : `<div class="mk dash">${dashes(13)}</div>`;
  return `<section class="sl t-${c.tone}"><p class="ct">${e(c.tag)}${c.sub ? ` <span>/</span> ${e(c.sub)}` : ""}</p><div class="bar">${play}<div class="trk2">${inner}</div></div><p class="st">${e(c.title)}</p></section>`;
}

/** Split a log line into tokens and pad both lines to the same columns, marking the characters only one line has. */
export function alignLines(a: string, b: string): [string, string] {
  const ta = a.split(" ");
  const tb = b.split(" ");
  // The longer token carries the added precision digits (0.55 against 0.549): those are highlighted, and the shorter one keeps a dotted gap of the same width.
  const mark = (x: string, y: string): string => {
    if (x.length === y.length) {
      let k = 0;
      while (k < x.length && x[k] === y[k]) k++;
      return `${e(x.slice(0, k))}<mark class="df">${e(x.slice(k))}</mark>`;
    }
    if (x.length > y.length) return `${e(x.slice(0, y.length))}<mark class="df">${e(x.slice(y.length))}</mark>`;
    return `${e(x)}<span class="gp">${"&nbsp;".repeat(y.length - x.length)}</span>`;
  };
  if (ta.length !== tb.length) return [e(a), e(b)];
  return [ta.map((t, i) => (t === tb[i] ? e(t) : mark(t, tb[i]!))).join(" "), tb.map((t, i) => (t === ta[i] ? e(t) : mark(t, ta[i]!))).join(" ")];
}

/** The evidence is two lines in one close-up, numbers aligned, only the digits that differ highlighted. */
function logBlock(p: CardsPanel): string {
  const [x, y] = p.cards;
  const [lx, ly] = alignLines(x!.mono, y!.mono);
  const row = (c: Card, html: string): string => `<div class="lg t-${c.tone}"><span class="lt">${e(c.tag)}${c.sub ? ` <em>${e(c.sub)}</em>` : ""}</span><code>${html}</code></div>`;
  return `<section class="log">${row(x!, lx)}${row(y!, ly)}</section>`;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

function rowText(r: RangeRow, unit: string): string {
  if (r.text) return r.text;
  return r.to > r.from ? `${fmt(r.from)}${EN_DASH}${fmt(r.to)} ${unit}` : `${fmt(r.from)} ${unit}`;
}

const WAVE_MIN = 15;
/** Most query ticks one strip can hold and still read as a count. */
const TICK_CAP = 240;

/** The leading whole number of a row note ("201 queries" is 201), or null. */
export const noteCount = (note: string): number | null => {
  const m = /^(\d+)\b/.exec(note);
  return m ? Number(m[1]) : null;
};

/** One hairline per counted thing, drawn on a grid as wide as the largest count: 201 lines against 1 shows the cause, no scale beyond the numbers the reply gives. A count of 1 is drawn wide by the stylesheet (`.qs i:only-child`) so it never vanishes next to 201. */
function tickStrips(rows: RangeRow[]): (string | "")[] {
  const counts = rows.map((r) => noteCount(r.note));
  const max = Math.max(0, ...counts.map((c) => c ?? 0));
  if (counts.some((c) => c === null) || max < 2 || max > TICK_CAP) return rows.map(() => "");
  return counts.map((c) => `<div class="qs" style="grid-template-columns:repeat(${max},1fr)" aria-hidden="true">${"<i></i>".repeat(c!)}</div>`);
}

/** The cause (201 queries against 1) on its own strip under the timing chart, in the same image: a label, one hairline per counted thing, and the reply's own words for the count. */
function causeStrip(rows: RangeRow[]): string {
  if (rows.every((r) => !r.note)) return "";
  const strips = tickStrips(rows);
  const body = rows
    .map((r, i) => {
      const tone = r.tone === "neutral" && i > 0 ? "good" : r.tone;
      return `<div class="cr t-${tone}"><p><span>${e(r.label)}</span><strong>${e(r.note)}</strong></p>${strips[i]}</div>`;
    })
    .join("");
  return `<section class="cd cs">${body}</section>`;
}

/** The player waveform of a row: only inside a closed range, from its start to its end, so it never implies playback past the data. */
export function waveSpan(r: RangeRow, left: number, right: number): string {
  const width = Math.round((right - left) * 10) / 10;
  // A bracket under about 15% of the axis is too narrow for a waveform to read as anything but noise.
  if (r.open || r.to <= r.from || width < WAVE_MIN) return "";
  return `<span class="pw" style="left:${left}%;width:${width}%"><s>${waveBars(Math.max(3, Math.round(width * 1.5)))}</s></span>`;
}

/**
 * One shared axis. Draws only when the rows carry numbers; the gate guarantees at least two. A value is a dot, a range
 * is a bracket. With player on, the track is the player bar: dashed while waiting, a waveform once Original is available,
 * and the value sits at the moment it becomes available, printed once.
 */
function range(p: RangePanel): string {
  const pct = (v: number): number => Math.round((v / p.axisMax) * 1000) / 10;
  const grid = p.ticks.map((t) => `<i class="gl" style="left:${pct(t)}%"></i>`).join("");
  const rows = p.rows
    .map((r, i) => {
      const left = pct(r.from);
      const right = pct(r.to);
      const tone = r.tone === "neutral" && i > 0 ? "good" : r.tone;
      const mk = r.open ? `<b class="rb open" style="left:${left}%;width:${100 - left}%"></b>` : r.to > r.from ? `<b class="rb" style="left:${left}%;width:${Math.max(1.5, right - left)}%"></b>` : `<b class="pt" style="left:${left}%"></b>`;
      const fill = p.player ? `<span class="wt" style="width:${left}%"><s>${dashes(70)}</s></span>${waveSpan(r, left, right)}` : "";
      const anchor = r.open ? (left + 100) / 2 : r.to > r.from ? (left + right) / 2 : left;
      const flip = anchor > 70 ? " flip" : anchor < 14 ? " lo" : "";
      const lab = `<span class="vl${flip}" style="left:${anchor}%">${e(rowText(r, p.unit))}</span>`;
      return `<div class="rw t-${tone}"><p class="rh"><span>${e(r.label)}</span></p><div class="rt${p.player ? " pbar" : ""}"><u></u>${fill}${mk}${lab}</div></div>`;
    })
    .join("");
  const longUnit = p.unit.length > 3;
  const ticks = p.ticks.map((t) => `<span style="left:${pct(t)}%">${fmt(t)}${t === p.axisMax && !longUnit ? ` ${e(p.unit)}` : ""}</span>`).join("");
  const unit = longUnit ? `<p class="au">${e(p.unit)}</p>` : "";
  return `<section class="cd rg"><div class="plot">${grid}${rows}</div><div class="axis" aria-hidden="true">${ticks}</div>${unit}</section>${causeStrip(p.rows)}`;
}

function node(n: LayerItem): string {
  return `<div class="nd">${icon(n.icon)}<p class="nn">${e(n.name)}</p>${n.detail ? `<p class="nx">${n.detail.split(" / ").map(e).join("<br>")}</p>` : ""}</div>`;
}

function layer(l: Layer): string {
  if (l.items.length) {
    const head = `<p class="ln">${e(l.name)}</p>${l.detail ? `<p class="nx">${e(l.detail)}</p>` : ""}`;
    return `<div class="ly${l.core ? " core" : ""}">${head}<div class="ni n${l.items.length}">${l.items.map(node).join("")}</div></div>`;
  }
  return `<div class="ly${l.core ? " core" : ""}"><p class="ln">${icon(l.icon)}<span>${e(l.name)}</span></p>${l.detail ? `<p class="nx">${e(l.detail)}</p>` : ""}</div>`;
}

/** Layers top to bottom, one flow direction, the link label on the arrow between two layers. */
function layers(p: LayersPanel): string {
  const parts = p.layers.map((l, i) => layer(l) + (i < p.layers.length - 1 ? `<div class="ar">${DOWN}${l.link ? `<span>${e(l.link)}</span>` : ""}</div>` : ""));
  return `<section class="cd arch">${parts.join("")}</section>`;
}

function body(p: CardsPanel | RangePanel | LayersPanel | FlowPanel | RankedPanel | GridPanel, type: string): string {
  if (p.kind === "flow") return flowBody(p);
  if (p.kind === "ranked") return rankedBody(p);
  if (p.kind === "grid") return gridBody(p);
  if (p.kind === "cards") return type === "state_key" ? `<div class="slots">${p.cards.map(slot).join(`<div class="sw"></div>`)}</div>` : logBlock(p);
  if (p.kind === "range") return range(p);
  return layers(p);
}

/** The reference-style page for a spec whose first panel is cards, range or layers. */
export function renderCardsHtml(spec: ExplainSpec, p: CardsPanel | RangePanel | LayersPanel | FlowPanel | RankedPanel | GridPanel): string {
  const eyebrow = spec.eyebrow.split("/").map((s) => e(s.trim())).join(' <span>/</span> ');
  const footer = spec.footer ? `<p class="ft"><i></i>${e(spec.footer)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${CARDS_CSS}
${FLOW_CSS}
</style></head><body class="k-${spec.type}"><main class="pg">
<p class="ey">${eyebrow}</p><h1>${e(spec.title)}</h1><p class="sb">${e(spec.takeaway)}</p>
${body(p, spec.type)}
${footer}
</main></body></html>
`;
}
