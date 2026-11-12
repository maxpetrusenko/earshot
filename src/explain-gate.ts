import type { ExplainSpec, Panel } from "./explain-schema.js";

/** Labels that say a thing happened without showing it. As a whole element label they are rejected. */
const EMPTY_LABELS = /^(?:fixed|implemented|completed|merged)[.!]?$/i;

/** Text that stands in for a picture instead of being one. */
const PLACEHOLDER = /^(?:diagram|screenshot|mock ?up|wireframe|placeholder|todo|tbd|image|picture)(?:\s+of)?(?:\s+here)?[.!]?$/i;

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
    case "journey":
      return p.steps.flatMap((s) => [s.label, s.el.text]);
  }
}

/** Share of the picture taken by drawn things (mockups, bars, arrows, highlights) rather than text. Below this the image is dropped. */
export const MIN_DENSITY = 0.55;

const EL_AREA: Record<string, number> = { bar: 2, controls: 2.2, button: 1.5, link: 1.2, bubble: 1.6, row: 1.1, wave: 2.6, text: 0 };
const words = (t: string): number => t.length / 55;

/** Visual-content density of one spec, 0 to 1. Mockup elements, timeline bars, arrows and highlighted UI count as visual; sentences and plain text boxes count as text. */
export function visualDensity(spec: ExplainSpec): number {
  let vis = 0;
  let txt = words(spec.takeaway) + spec.callouts.reduce((a, c) => a + words(c), 0);
  for (const p of spec.panels) {
    txt += words(p.label) + words(p.caption);
    switch (p.kind) {
      case "ui":
        for (const e of p.elements) {
          const a = EL_AREA[e.kind] ?? 0;
          vis += a;
          txt += e.kind === "text" ? 1 + words(e.text) : 0.25 * words(e.text);
          if (e.hl) vis += 1;
          if (e.note) {
            vis += 0.8; // the arrow
            txt += words(e.note);
          }
        }
        break;
      case "timeline":
        for (const l of p.lanes) {
          vis += l.segments.length * 1.6 + (l.marker >= 0 ? 1.2 : 0);
          txt += 0.3;
        }
        break;
      case "sequence":
        vis += p.messages.length * 1.4 + p.actors.length * 0.5;
        txt += p.messages.reduce((a, m) => a + words(m.text) * 0.5, 0);
        break;
      case "architecture":
        vis += p.components.length * 0.8 + p.edges.length * 1.4;
        txt += p.edges.reduce((a, m) => a + words(m.label) * 0.5, 0);
        break;
      case "journey":
        for (const s of p.steps) {
          vis += (EL_AREA[s.el.kind] ?? 0) + 0.9; // the mockup and the arrow to the next step
          txt += words(s.label);
        }
        break;
    }
  }
  return vis + txt === 0 ? 0 : vis / (vis + txt);
}

/** Does the panel show something (elements, segments, messages, data paths), not just labels? */
function panelProblem(p: Panel, i: number): string | null {
  const n = `panel ${i + 1}`;
  if (!p.caption) return `${n} needs a caption: one sentence about what the user can now do`;
  switch (p.kind) {
    case "ui":
      if (p.elements.length < 2) return `${n} has fewer than two elements; draw the actual interface`;
      if (p.elements.every((e) => e.kind === "text")) return `${n} is only text labels; use bar, controls, button, link, bubble, wave or row elements`;
      if (p.elements.filter((e) => e.kind !== "text").length < 3) return `${n} is too sparse; draw at least three real interface elements`;
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
    case "journey":
      if (p.steps.length < 3) return `${n} needs at least three user steps, each with the real thing the user sees`;
      if (p.steps.every((s) => s.el.kind === "text")) return `${n} steps are only text; give each step a button, bar, link, bubble, wave or controls`;
      return null;
  }
}

/**
 * Quality gate before rendering: would someone understand the change from the picture alone?
 * Returns feedback for the model, or null when the spec passes.
 */
export function explainGate(spec: ExplainSpec, minDensity: number = MIN_DENSITY): string | null {
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
    const fake = labels(p).find((l) => PLACEHOLDER.test(l));
    if (fake) return `"${fake}" describes a picture instead of being one; draw the real interface, values or timeline`;
  }
  const d = visualDensity(spec);
  if (d < minDensity) return `the picture is mostly text (visual density ${d.toFixed(2)}, needs ${minDensity}); draw more mockup elements, arrows, highlights or timeline bars and fewer sentences, or return no_image`;
  return null;
}
