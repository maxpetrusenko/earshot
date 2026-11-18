import { arr, cleanText, cleanWords, num, oneOf, padDecimals, rangeText, rec } from "./explain-util.js";

/**
 * Panels of the reference style: one concept per image, a few labeled cards. The model returns data only.
 * cards: BEFORE/AFTER log values or two named states. range: values on one shared axis.
 * layers: a layered architecture with real component names, icons and one flow direction.
 */
export const TONES = ["bad", "good", "neutral"] as const;
export type Tone = (typeof TONES)[number];
export const MARKS = ["none", "dashed", "wave"] as const;
export type Mark = (typeof MARKS)[number];
/** Icons the renderer can draw. A layer or component without one of these is rejected by the gate. */
export const ICONS = ["agents", "cursor", "keyboard", "eye", "desktop", "server", "database", "cloud", "terminal", "gear", "network", "file", "user", "lock", "bolt", "chat"] as const;
export type Icon = (typeof ICONS)[number];

export interface Card {
  /** BEFORE, AFTER, WAITING, PLAYING. */
  tag: string;
  /** Second half of the card eyebrow, for example REPORTED LOG. */
  sub: string;
  tone: Tone;
  /** A state name in the page font, for example "waits for edited". */
  title: string;
  /** A log or console value, exactly as the reply gives it. Drawn in mono. */
  mono: string;
  mark: Mark;
  caption: string;
}
export interface CardsPanel {
  kind: "cards";
  label: string;
  caption: string;
  cards: Card[];
}
export interface RangeRow {
  label: string;
  from: number;
  /** Equal to from for a single point. */
  to: number;
  /** An open value (more than, at least): drawn from `from` to the axis end with no closing cap. */
  open: boolean;
  /** Printed value, for example "about 60 s". Drawn from the numbers when empty. */
  text: string;
  tone: Tone;
  /** A second measure tied to this row, for example "201 queries": the cause next to the number it explains. */
  note: string;
}
export interface RangePanel {
  kind: "range";
  label: string;
  caption: string;
  unit: string;
  rows: RangeRow[];
  /** The values are when Original becomes available in the player: dashed waiting before, a waveform after. */
  player: boolean;
  /** Shared axis end, a round number at or above the largest value. */
  axisMax: number;
  ticks: number[];
}
export interface LayerItem {
  name: string;
  detail: string;
  icon: Icon | "";
}
export interface Layer extends LayerItem {
  /** What travels to the next layer, drawn on the arrow below this one. */
  link: string;
  /** Outlined as the middle piece of the design. */
  core: boolean;
  items: LayerItem[];
}
export interface LayersPanel {
  kind: "layers";
  label: string;
  caption: string;
  layers: Layer[];
}

/** Axis end and ticks: the smallest 1, 2 or 5 step that reaches the largest value in at most three steps, so tick labels never crowd. */
export function niceAxis(max: number): { axisMax: number; ticks: number[] } {
  const top = max > 0 ? max : 1;
  for (let k = -3; k < 12; k++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** k;
      const n = Math.ceil(top / step - 1e-9);
      if (n <= 3) {
        const ticks = Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
        return { axisMax: ticks[n]!, ticks };
      }
    }
  }
  return { axisMax: top, ticks: [0, top] };
}

export function cardsPanel(p: Record<string, unknown>): CardsPanel {
  const cards: Card[] = [];
  for (const c of arr(p.cards).slice(0, 2)) {
    const r = rec(c);
    const card: Card = {
      tag: cleanText(r.tag, 20),
      sub: cleanText(r.sub, 28),
      tone: oneOf(r.tone, TONES, "neutral"),
      title: cleanText(r.title, 40),
      mono: padDecimals(cleanText(r.mono, 36)),
      mark: oneOf(r.mark, MARKS, "none"),
      caption: cleanText(r.caption, 90),
    };
    if (card.tag || card.title || card.mono) cards.push(card);
  }
  return { kind: "cards", label: "", caption: "", cards };
}

export function rangePanel(p: Record<string, unknown>): RangePanel {
  const rows: RangeRow[] = [];
  for (const raw of arr(p.rows).slice(0, 4)) {
    const r = rec(raw);
    const from = num(r.from ?? r.value, 0, 1e9, NaN);
    if (Number.isNaN(from)) continue;
    const to = Math.max(from, num(r.to, 0, 1e9, from));
    rows.push({ label: cleanText(r.label, 24), from, to, open: r.open === true, text: rangeText(r.text, 30), tone: oneOf(r.tone, TONES, "neutral"), note: cleanWords(r.note, 24) });
  }
  // An open row needs headroom past its number so the open end has somewhere to go.
  const { axisMax, ticks } = niceAxis(rows.reduce((m, r) => Math.max(m, r.open ? r.to * 1.3 : r.to), 0));
  return { kind: "range", label: "", caption: "", unit: cleanText(p.unit, 12), rows, player: p.player === true, axisMax, ticks };
}

const item = (v: unknown, nameMax: number, detailMax: number): LayerItem => {
  const r = rec(v);
  return { name: cleanText(r.name, nameMax), detail: cleanText(r.detail, detailMax), icon: oneOf(r.icon, ICONS, "" as Icon) };
};

export function layersPanel(p: Record<string, unknown>): LayersPanel {
  const layers: Layer[] = [];
  for (const raw of arr(p.layers).slice(0, 5)) {
    const r = rec(raw);
    const base = item(r, 30, 60);
    if (!base.name) continue;
    const items = arr(r.items).slice(0, 4).map((i) => item(i, 18, 24)).filter((i) => i.name);
    layers.push({ ...base, link: cleanWords(r.link, 40), core: r.core === true, items });
  }
  return { kind: "layers", label: "", caption: "", layers };
}
