import { escapeHtml } from "./orca.js";
import type { ArchPanel, SequencePanel, State, TimelinePanel } from "./explain-schema.js";
import { sanitizeSvg } from "./svg-sanitize.js";

/** Every panel SVG is 360 units wide, so one unit is about one pixel on a phone and the type stays large. */
export const W = 360;
const PAD = 8;
const CH = 7.4; // estimated width of one character at 13px
const e = escapeHtml;

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** Greedy word wrap to at most `lines` lines of `max` characters; the last line is cut with an ellipsis. */
export function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (cur && (cur + " " + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  const kept = out.slice(0, lines);
  if (out.length > lines || kept.some((l) => l.length > max)) return kept.map((l, i) => (l.length > max || (i === lines - 1 && out.length > lines) ? `${l.slice(0, Math.max(1, max - 1))}…` : l));
  return kept;
}

const svg = (w: number, h: number, id: string, body: string): string =>
  sanitizeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${fmt(h)}" width="100%" class="dg"><defs><marker id="${id}" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L9 4.5L0 9z" class="ah"/></marker></defs>${body}</svg>`,
  );

const segClass = (s: State): string => `sg s-${s}`;

/** Time axis end shared by every timeline panel in a spec, so before and after are drawn on one scale. */
export function timelineMax(panels: TimelinePanel[]): number {
  let m = 0;
  for (const p of panels) for (const l of p.lanes) for (const s of l.segments) m = Math.max(m, s.start + s.duration);
  return m || 1;
}

export function timelineSvg(p: TimelinePanel, max: number, uid: string): string {
  const track = W - PAD * 2;
  const scale = track / max;
  let y = 4;
  let body = "";
  for (const lane of p.lanes) {
    const end = lane.segments.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    body += `<text x="${PAD}" y="${y + 15}" class="lb" font-size="14">${e(lane.label)}</text>`;
    if (end > 0) body += `<text x="${W - PAD}" y="${y + 15}" class="lm" font-size="14" text-anchor="end">${e(fmt(end))} ${e(p.unit)}</text>`;
    body += `<rect x="${PAD}" y="${y + 22}" width="${track}" height="34" rx="6" class="tr"/>`;
    for (const s of lane.segments) {
      const x = PAD + s.start * scale;
      const w = Math.max(2, s.duration * scale);
      body += `<rect x="${fmt(x)}" y="${y + 22}" width="${fmt(w)}" height="34" rx="6" class="${segClass(s.state)}"/>`;
      const fit = Math.floor((w - 10) / CH);
      if (s.label && fit >= 3) {
        const t = s.label.length <= fit ? s.label : `${s.label.slice(0, fit - 1)}…`;
        body += `<text x="${fmt(x + w / 2)}" y="${y + 44}" class="sl s-${s.state}" font-size="13" font-weight="600" text-anchor="middle">${e(t)}</text>`;
      }
    }
    if (lane.marker >= 0) {
      const mx = PAD + lane.marker * scale;
      body += `<line x1="${fmt(mx)}" y1="${y + 18}" x2="${fmt(mx)}" y2="${y + 62}" class="mk"/><path d="M${fmt(mx - 6)} ${y + 18}h12l-6 9z" class="mkh"/>`;
      if (lane.markerLabel) {
        const t = lane.markerLabel;
        const tw = t.length * 6.8;
        const anchorEnd = mx + tw + 10 > W - PAD;
        body += `<text x="${fmt(anchorEnd ? mx - 8 : mx + 8)}" y="${y + 74}" class="lb" font-size="13" font-weight="700" text-anchor="${anchorEnd ? "end" : "start"}">${e(t)}</text>`;
      }
      y += 12;
    }
    y += 68;
  }
  body += `<line x1="${PAD}" y1="${y + 2}" x2="${W - PAD}" y2="${y + 2}" class="ax"/><text x="${PAD}" y="${y + 20}" class="lm" font-size="12">0</text><text x="${W - PAD}" y="${y + 20}" class="lm" font-size="12" text-anchor="end">${e(fmt(max))} ${e(p.unit)}</text>`;
  return svg(W, y + 28, `a${uid}`, body);
}

export function sequenceSvg(p: SequencePanel, uid: string): string {
  const n = p.actors.length;
  const colW = (W - PAD * 2) / n;
  const cx = (i: number) => PAD + colW * i + colW / 2;
  const maxChars = Math.max(5, Math.floor((colW - 6) / CH));
  let body = "";
  for (const [i, a] of p.actors.entries()) {
    const lines = wrap(a, maxChars, 2);
    body += `<rect x="${fmt(cx(i) - colW / 2 + 3)}" y="4" width="${fmt(colW - 6)}" height="44" rx="8" class="nd"/>`;
    lines.forEach((l, k) => (body += `<text x="${fmt(cx(i))}" y="${lines.length === 1 ? 31 : 22 + k * 16}" class="lb" font-size="13" font-weight="600" text-anchor="middle">${e(l)}</text>`));
  }
  const top = 52;
  const rowH = 46;
  const bottom = top + p.messages.length * rowH + 8;
  for (let i = 0; i < n; i++) body += `<line x1="${fmt(cx(i))}" y1="${top}" x2="${fmt(cx(i))}" y2="${bottom}" class="ll"/>`;
  for (const [k, m] of p.messages.entries()) {
    const y = top + k * rowH + 36;
    const x1 = cx(m.from);
    const x2 = cx(m.to);
    const cls = `ln${m.dashed ? " ds" : ""}`;
    if (m.from === m.to) body += `<path d="M${fmt(x1)} ${y - 10}h26v12h-26" class="${cls} nf" marker-end="url(#a${uid})"/>`;
    else body += `<line x1="${fmt(x1)}" y1="${y}" x2="${fmt(x2 + (x2 > x1 ? -1 : 1))}" y2="${y}" class="${cls}" marker-end="url(#a${uid})"/>`;
    const room = Math.floor((W - PAD * 2) / CH);
    const t = wrap(m.text, room, 1)[0]!;
    const tw = t.length * CH;
    const tx = Math.min(Math.max(PAD, Math.min(x1, x2) + 4), W - PAD - tw);
    body += `<text x="${fmt(tx)}" y="${y - 8}" class="lb mt" font-size="13">${e(t)}</text>`;
  }
  return svg(W, bottom + 6, `a${uid}`, body);
}

/** Layer per component: longest path from a source, with a cap so a cycle cannot run away. */
function layers(p: ArchPanel): Map<string, number> {
  const layer = new Map(p.components.map((c) => [c.id, 0]));
  for (let pass = 0; pass < p.components.length; pass++) {
    let changed = false;
    for (const ed of p.edges) {
      const next = Math.min(layer.get(ed.from)! + 1, p.components.length - 1);
      if (next > layer.get(ed.to)! && layer.get(ed.to)! < p.components.length - 1) {
        layer.set(ed.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

export function architectureSvg(p: ArchPanel, uid: string): string {
  const layer = layers(p);
  const rows: string[][] = [];
  for (const c of p.components) (rows[layer.get(c.id)!] ??= []).push(c.id);
  const dense = rows.filter(Boolean);
  const nodeH = 48;
  const gap = 66;
  const pos = new Map<string, { x: number; y: number; w: number }>();
  dense.forEach((ids, r) => {
    const w = Math.min(160, (W - PAD * 2 - (ids.length - 1) * 12) / ids.length);
    const total = ids.length * w + (ids.length - 1) * 12;
    ids.forEach((id, i) => pos.set(id, { x: (W - total) / 2 + i * (w + 12), y: 6 + r * (nodeH + gap), w }));
  });
  const height = 6 + dense.length * nodeH + (dense.length - 1) * gap + 6;
  let lines = "";
  let labels = "";
  for (const [k, ed] of p.edges.entries()) {
    const a = pos.get(ed.from)!;
    const b = pos.get(ed.to)!;
    let x1: number, y1: number, x2: number, y2: number;
    if (a.y === b.y) {
      const right = b.x > a.x;
      x1 = right ? a.x + a.w : a.x;
      x2 = right ? b.x : b.x + b.w;
      y1 = y2 = a.y + nodeH / 2;
    } else {
      const down = b.y > a.y;
      x1 = a.x + a.w / 2;
      x2 = b.x + b.w / 2;
      y1 = down ? a.y + nodeH : a.y;
      y2 = down ? b.y - 2 : b.y + nodeH + 2;
    }
    lines += `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" class="ln" marker-end="url(#a${uid})"/>`;
    if (ed.label) {
      const t = wrap(ed.label, 24, 1)[0]!;
      const tw = t.length * 6.8 + 10;
      const t0 = 0.5 + ((k % 3) - 1) * 0.12;
      const mx = Math.min(Math.max(PAD + tw / 2, x1 + (x2 - x1) * t0), W - PAD - tw / 2);
      const my = y1 + (y2 - y1) * t0 + (a.y === b.y ? -14 : 0);
      labels += `<rect x="${fmt(mx - tw / 2)}" y="${fmt(my - 10)}" width="${fmt(tw)}" height="18" rx="4" class="lg"/><text x="${fmt(mx)}" y="${fmt(my + 3)}" class="lm" font-size="12" text-anchor="middle">${e(t)}</text>`;
    }
  }
  let nodes = "";
  for (const c of p.components) {
    const q = pos.get(c.id)!;
    const ls = wrap(c.label, Math.max(5, Math.floor((q.w - 10) / CH)), 2);
    nodes += `<rect x="${fmt(q.x)}" y="${q.y}" width="${fmt(q.w)}" height="${nodeH}" rx="8" class="nd s-${c.state}"/>`;
    ls.forEach((l, i) => (nodes += `<text x="${fmt(q.x + q.w / 2)}" y="${q.y + (ls.length === 1 ? 29 : 21 + i * 16)}" class="lb" font-size="13" font-weight="600" text-anchor="middle">${e(l)}</text>`));
  }
  return svg(W, height, `a${uid}`, lines + nodes + labels);
}
