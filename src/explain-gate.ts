import type { ExplainSpec, Panel } from "./explain-schema.js";

/** Labels that say a thing happened without showing it. As a whole element label they are rejected. */
const EMPTY_LABELS = /^(?:fixed|implemented|completed|merged)[.!]?$/i;

/** Every box-like label in a panel: elements, segments, lanes, actors, components, io fields. */
function labels(p: Panel): string[] {
  switch (p.kind) {
    case "ui":
      return p.elements.map((e) => e.text);
    case "timeline":
      return p.lanes.flatMap((l) => [l.label, ...l.segments.map((s) => s.label)]);
    case "sequence":
      return [...p.actors, ...p.messages.map((m) => m.text)];
    case "architecture":
      return [...p.components.map((c) => c.label), ...p.edges.map((e) => e.label)];
    case "io":
      return [p.input, p.transform, p.output];
  }
}

/** Does the panel show something (elements, segments, messages, data paths), not just labels? */
function panelProblem(p: Panel, i: number): string | null {
  const n = `panel ${i + 1}`;
  switch (p.kind) {
    case "ui":
      if (p.elements.length < 2) return `${n} has fewer than two elements; draw the actual interface`;
      if (p.elements.every((e) => e.kind === "text")) return `${n} is only text labels; use bar, button, link, bubble, image or row elements`;
      return null;
    case "timeline":
      if (p.lanes.reduce((a, l) => a + l.segments.length, 0) < 2) return `${n} has fewer than two segments; give each lane segments with start and duration`;
      return null;
    case "sequence":
      if (p.actors.length < 2 || p.messages.length < 2) return `${n} needs two actors and at least two messages between them`;
      return null;
    case "architecture":
      if (p.components.length < 3 || p.edges.length < 2) return `${n} needs three components and at least two data paths between them`;
      if (!p.edges.some((e) => e.label)) return `${n} has data paths without a label saying what travels on them`;
      return null;
    case "io":
      if (!p.input || !p.output || !p.transform) return `${n} needs a concrete input, a transform and an output`;
      return null;
  }
}

/**
 * Quality gate before rendering: would someone understand the change from the picture alone?
 * Returns feedback for the model, or null when the spec passes.
 */
export function explainGate(spec: ExplainSpec): string | null {
  const beforeAfter = spec.type === "ui_before_after" || spec.type === "bug_before_after";
  if (beforeAfter && spec.panels.length < 2) return "a before/after type needs exactly two panels, before then after";
  if (spec.type === "timeline" && spec.panels.length < 2 && spec.panels[0]?.kind === "timeline" && spec.panels[0].lanes.length < 2) {
    return "a timeline needs two panels (sequential vs parallel, before vs after) or at least two lanes";
  }
  for (const [i, p] of spec.panels.entries()) {
    const bad = panelProblem(p, i);
    if (bad) return bad;
    const empty = labels(p).find((l) => EMPTY_LABELS.test(l.trim()));
    if (empty) return `"${empty}" is a bare status label; show the actual interface, transformation or behavior instead of labeling it`;
  }
  return null;
}
