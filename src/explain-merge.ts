import type { ExplainSpec, Panel } from "./explain-schema.js";

const FOOTER_MAX = 80;
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** The numbers of a range panel as one phrase: "201 to 1". */
function values(p: Panel): string {
  if (p.kind !== "range") return "";
  return p.rows.map((r) => r.text || (r.to > r.from ? `${num(r.from)} to ${num(r.to)}` : num(r.from))).join(" to ");
}

const singular = (unit: string, value: string): string => (value === "1" ? unit.replace(/ies$/, "y").replace(/s$/, "") : unit);

/** A dropped chart whose rows line up with the kept one becomes a note on each row: the cause next to the number it explains. */
function rowNotes(keep: Panel, other: Panel): string[] | null {
  if (keep.kind !== "range" || other.kind !== "range" || keep.rows.length !== other.rows.length || !other.unit) return null;
  return other.rows.map((r) => {
    const v = num(r.from);
    return `${v} ${singular(other.unit, v)}`;
  });
}

/**
 * One reply makes one perf image. Several range charts would each leave out the other's main number, so keep the
 * chart with the most rows and move each dropped chart's numbers into the footer line of the kept one.
 */
export function mergeRangeCharts(specs: ExplainSpec[]): ExplainSpec[] {
  const isRange = (s: ExplainSpec): boolean => s.type === "range_chart" && s.panels[0]?.kind === "range";
  const ranges = specs.filter(isRange);
  if (ranges.length < 2) return specs;
  const keep = ranges.reduce((a, b) => ((b.panels[0] as { rows: unknown[] }).rows.length > (a.panels[0] as { rows: unknown[] }).rows.length ? b : a));
  const keepPanel = keep.panels[0]!;
  const dropped = ranges.filter((s) => s !== keep);
  const notes = dropped.length === 1 ? rowNotes(keepPanel, dropped[0]!.panels[0]!) : null;
  if (notes && keepPanel.kind === "range") {
    const merged = { ...keep, panels: [{ ...keepPanel, rows: keepPanel.rows.map((r, i) => ({ ...r, note: notes[i]! })) }] };
    let done = false;
    return specs.flatMap((s) => (!isRange(s) ? [s] : done ? [] : ((done = true), [merged])));
  }
  const extra = dropped.map((s) => `${s.takeaway.replace(/[.\s]+$/, "")}: ${values(s.panels[0]!)}`)
    .filter((t) => !t.endsWith(": "));
  const footer = [keep.footer, ...extra].filter(Boolean).join(". ").slice(0, FOOTER_MAX).trim();
  const merged = { ...keep, footer };
  let placed = false;
  return specs.flatMap((s) => {
    if (!isRange(s)) return [s];
    if (placed) return [];
    placed = true;
    return [merged];
  });
}
