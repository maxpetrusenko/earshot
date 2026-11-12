/**
 * The structured spec the explain stage asks the model for, and the strict validator that turns raw model output into it.
 * The model only ever returns data. Unknown fields are dropped, strings are cleaned and length-capped, counts are capped;
 * the renderer then escapes every value again on output.
 */

export class ExplainError extends Error {}

export const EXPLAIN_TYPES = ["ui_before_after", "bug_before_after", "architecture", "timeline", "sequence", "example_io", "journey"] as const;
export type ExplainType = (typeof EXPLAIN_TYPES)[number];

export type ElKind = "bar" | "controls" | "button" | "link" | "text" | "bubble" | "wave" | "row";
export const EL_KINDS: readonly ElKind[] = ["bar", "controls", "button", "link", "text", "bubble", "wave", "row"];
export type State = "normal" | "good" | "bad" | "muted";
const STATES: readonly State[] = ["normal", "good", "bad", "muted"];

export interface UiEl {
  kind: ElKind;
  text: string;
  state: State;
  /** Chat bubbles: which side of the frame. */
  side: "left" | "right";
  /** Progress bars and waveforms: 0 to 100, or -1 for none. */
  value: number;
  /** Draw a colored outline: this is what changed. */
  hl: boolean;
  /** An arrow annotation under the element saying what it is or does. */
  note: string;
}
export interface UiPanel {
  kind: "ui";
  label: string;
  frame: "mac" | "phone" | "chat" | "plain";
  title: string;
  elements: UiEl[];
  /** One sentence about the user impact of this panel. */
  caption: string;
}
export interface JourneyStep {
  label: string;
  /** The real thing the user sees at this step, drawn as a small mockup. */
  el: { kind: ElKind; text: string; value: number };
  state: State;
  /** Happens only sometimes (for example only for complex tasks). */
  optional: boolean;
}
export interface JourneyPanel {
  kind: "journey";
  label: string;
  steps: JourneyStep[];
  caption: string;
}
export interface Segment {
  label: string;
  start: number;
  duration: number;
  state: State;
}
export interface TimelinePanel {
  kind: "timeline";
  label: string;
  unit: string;
  lanes: { label: string; segments: Segment[]; marker: number; markerLabel: string }[];
  caption: string;
}
export interface SequencePanel {
  kind: "sequence";
  label: string;
  actors: string[];
  messages: { from: number; to: number; text: string; dashed: boolean }[];
  caption: string;
}
export interface ArchPanel {
  kind: "architecture";
  label: string;
  components: { id: string; label: string; state: State }[];
  edges: { from: string; to: string; label: string }[];
  caption: string;
}
export interface IoPanel {
  kind: "io";
  label: string;
  inLabel: string;
  input: string;
  transform: string;
  outLabel: string;
  output: string;
  caption: string;
}
export type Panel = UiPanel | TimelinePanel | SequencePanel | ArchPanel | IoPanel | JourneyPanel;

export interface Metric {
  label: string;
  before: string;
  after: string;
  verified: boolean;
  /** Where a measured number came from, for example "measured on pro, 1.5 KB reply". */
  source: string;
}

export interface ExplainSpec {
  title: string;
  takeaway: string;
  type: ExplainType;
  panels: Panel[];
  callouts: string[];
  metrics: Metric[];
  assumptions: string[];
}

export const MAX = { panels: 2, elements: 8, lanes: 4, segments: 6, actors: 5, messages: 8, components: 7, edges: 9, callouts: 3, metrics: 3, assumptions: 4, steps: 5, visuals: 3 };

const EMOJI = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;

/** Plain, single-line, length-capped text. Controls, emoji and long dashes are removed. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v)
    .replace(EMOJI, "")
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const oneOf = <T extends string>(v: unknown, set: readonly T[], dflt: T): T => (typeof v === "string" && (set as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : dflt);

function uiPanel(p: Record<string, unknown>): UiPanel {
  const elements: UiEl[] = [];
  for (const e of arr(p.elements).slice(0, MAX.elements)) {
    const r = rec(e);
    const kind = oneOf(r.kind, EL_KINDS, "text");
    const text = cleanText(r.text, r.kind === "controls" ? 80 : 60);
    if (!text) continue;
    elements.push({ kind, text, state: oneOf(r.state, STATES, "normal"), side: oneOf(r.side, ["left", "right"] as const, "left"), value: num(r.value, 0, 100, -1), hl: r.highlight === true || r.hl === true, note: cleanText(r.note, 48) });
  }
  return { kind: "ui", label: cleanText(p.label, 50), frame: oneOf(p.frame, ["mac", "phone", "chat", "plain"] as const, "plain"), title: cleanText(p.title, 30), elements, caption: cleanText(p.caption, 120) };
}

function timelinePanel(p: Record<string, unknown>): TimelinePanel {
  const lanes: TimelinePanel["lanes"] = [];
  for (const l of arr(p.lanes).slice(0, MAX.lanes)) {
    const r = rec(l);
    const segments: Segment[] = [];
    for (const s of arr(r.segments).slice(0, MAX.segments)) {
      const q = rec(s);
      const duration = num(q.duration, 0, 100000, 0);
      if (duration <= 0) continue;
      segments.push({ label: cleanText(q.label, 24), start: num(q.start, 0, 100000, 0), duration, state: oneOf(q.state, STATES, "normal") });
    }
    const label = cleanText(r.label, 36);
    const marker = num(r.marker, 0, 100000, -1);
    if (label || segments.length) lanes.push({ label, segments, marker, markerLabel: cleanText(r.marker_label, 24) });
  }
  return { kind: "timeline", label: cleanText(p.label, 50), unit: cleanText(p.unit, 4) || "s", lanes, caption: cleanText(p.caption, 120) };
}

function sequencePanel(p: Record<string, unknown>): SequencePanel {
  const actors = arr(p.actors).slice(0, MAX.actors).map((a) => cleanText(a, 18)).filter(Boolean);
  const index = (v: unknown): number => {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < actors.length) return v;
    const t = cleanText(v, 18).toLowerCase();
    return actors.findIndex((a) => a.toLowerCase() === t);
  };
  const messages: SequencePanel["messages"] = [];
  for (const m of arr(p.messages).slice(0, MAX.messages)) {
    const r = rec(m);
    const from = index(r.from);
    const to = index(r.to);
    const text = cleanText(r.text, 40);
    if (from >= 0 && to >= 0 && text) messages.push({ from, to, text, dashed: r.dashed === true });
  }
  return { kind: "sequence", label: cleanText(p.label, 50), actors, messages, caption: cleanText(p.caption, 120) };
}

function archPanel(p: Record<string, unknown>): ArchPanel {
  const components: ArchPanel["components"] = [];
  const seen = new Set<string>();
  for (const c of arr(p.components).slice(0, MAX.components)) {
    const r = rec(c);
    const label = cleanText(r.label, 24);
    const id = cleanText(r.id, 20) || label;
    if (!label || seen.has(id)) continue;
    seen.add(id);
    components.push({ id, label, state: oneOf(r.state, STATES, "normal") });
  }
  const find = (v: unknown): string | null => {
    const t = cleanText(v, 24).toLowerCase();
    return components.find((c) => c.id.toLowerCase() === t || c.label.toLowerCase() === t)?.id ?? null;
  };
  const edges: ArchPanel["edges"] = [];
  for (const e of arr(p.edges).slice(0, MAX.edges)) {
    const r = rec(e);
    const from = find(r.from);
    const to = find(r.to);
    if (from && to && from !== to) edges.push({ from, to, label: cleanText(r.label, 22) });
  }
  return { kind: "architecture", label: cleanText(p.label, 50), components, edges, caption: cleanText(p.caption, 120) };
}

function ioPanel(p: Record<string, unknown>): IoPanel {
  return {
    kind: "io",
    label: cleanText(p.label, 50),
    inLabel: cleanText(p.input_label, 16) || "Input",
    input: cleanText(p.input, 140),
    transform: cleanText(p.transform, 100),
    outLabel: cleanText(p.output_label, 16) || "Output",
    output: cleanText(p.output, 140),
    caption: cleanText(p.caption, 120),
  };
}

function journeyPanel(p: Record<string, unknown>): JourneyPanel {
  const steps: JourneyStep[] = [];
  for (const s of arr(p.steps).slice(0, MAX.steps)) {
    const r = rec(s);
    const e = rec(r.el);
    const label = cleanText(r.label, 28);
    const text = cleanText(e.text, 40);
    if (!label || !text) continue;
    steps.push({ label, el: { kind: oneOf(e.kind, EL_KINDS, "text"), text, value: num(e.value, 0, 100, -1) }, state: oneOf(r.state, STATES, "normal"), optional: r.optional === true });
  }
  return { kind: "journey", label: cleanText(p.label, 50), steps, caption: cleanText(p.caption, 120) };
}

const BUILD: Record<ExplainType, (p: Record<string, unknown>) => Panel> = {
  ui_before_after: uiPanel,
  bug_before_after: uiPanel,
  timeline: timelinePanel,
  sequence: sequencePanel,
  architecture: archPanel,
  example_io: ioPanel,
  journey: journeyPanel,
};

/** True for the text NO_IMAGE or a JSON object whose no_image is true. */
export function isNoImage(raw: string): boolean {
  return /^\s*(?:```(?:json)?\s*)?NO_IMAGE\b/i.test(raw);
}

/**
 * Validate parsed model output. Returns null for no_image, a clean spec otherwise.
 * Throws ExplainError with a sentence the model can act on when the structure is unusable.
 */
export function parseExplain(raw: unknown): ExplainSpec | null {
  const o = rec(raw);
  if (o.no_image === true || (typeof raw === "string" && isNoImage(raw))) return null;
  const type = typeof o.type === "string" ? (o.type.toLowerCase() as ExplainType) : ("" as ExplainType);
  if (!EXPLAIN_TYPES.includes(type)) throw new ExplainError(`"type" must be one of ${EXPLAIN_TYPES.join(", ")}`);
  const panels = arr(o.panels).slice(0, MAX.panels).map((p) => BUILD[type](rec(p)));
  if (panels.length === 0) throw new ExplainError('"panels" is empty');
  const metrics: Metric[] = [];
  for (const m of arr(o.metrics).slice(0, MAX.metrics)) {
    const r = rec(m);
    const label = cleanText(r.label, 40);
    const after = cleanText(r.after, 20);
    if (label && after) metrics.push({ label, before: cleanText(r.before, 20), after, verified: r.verified === true, source: r.verified === true ? cleanText(r.source, 48) : "" });
  }
  const title = cleanText(o.title, 60);
  if (!title) throw new ExplainError('"title" is missing');
  return {
    title,
    takeaway: cleanText(o.takeaway, 140),
    type,
    panels,
    callouts: arr(o.callouts).slice(0, MAX.callouts).map((c) => cleanText(c, 80)).filter(Boolean),
    metrics,
    assumptions: arr(o.assumptions).slice(0, MAX.assumptions).map((c) => cleanText(c, 120)).filter(Boolean),
  };
}

/**
 * Validate the model's whole answer: NO_IMAGE, one visual object, or {"visuals":[...]} with up to three.
 * Each visual is validated alone; one unusable visual throws so the model can fix it.
 */
export function parseExplainAll(raw: unknown): ExplainSpec[] {
  if (typeof raw === "string" && isNoImage(raw)) return [];
  const o = rec(raw);
  if (o.no_image === true && !Array.isArray(o.visuals)) return [];
  const items = Array.isArray(o.visuals) ? o.visuals.slice(0, MAX.visuals) : [raw];
  return items.map((v) => parseExplain(v)).filter((s): s is ExplainSpec => s !== null);
}
