import { cardLabels, cardsGate, isCardPanel } from "./explain-cards-gate.js";
import type { ExplainSpec, Panel } from "./explain-schema.js";

const DIRECTOR_LINES: readonly (readonly [keyof NonNullable<ExplainSpec["director"]>, string])[] = [
  ["intent", "intent"],
  ["keyFrame", "key_frame"],
  ["firstLook", "first_look"],
  ["twoSecondTest", "two_second_test"],
  ["motion", "motion"],
];

/** Feedback when the director pass is missing or has an empty line; null when all five lines say something. */
export function directorProblem(spec: ExplainSpec): string | null {
  if (!spec.director) return 'the "director" object is missing: write intent, key_frame, first_look, two_second_test and motion before the visual';
  const empty = DIRECTOR_LINES.filter(([k]) => spec.director![k].length < 3).map(([, name]) => name);
  return empty.length ? `the "director" object has empty lines (${empty.join(", ")}): all five lines must say something` : null;
}

/** Labels that say a thing happened without showing it. As a whole element label they are rejected. */
const EMPTY_LABELS = /^(?:fixed|implemented|completed|merged)[.!]?$/i;

/** Text that stands in for a picture instead of being one. */
const PLACEHOLDER = /^(?:diagram|screenshot|mock ?up|wireframe|placeholder|todo|tbd|image|picture)(?:\s+of)?(?:\s+here)?[.!]?$|\bdiagram\b|(?:collapses?|shrinks?|reduces?) to nothing|^(?:nothing|empty|n\/a|none)(?: here)?[.!]?$/i;

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
    default:
      return cardLabels(p);
  }
}

/** Share of the picture taken by drawn things (mockups, bars, arrows, highlights) rather than text. Below this the image is dropped. */
/** Longest footer line the picture has room for. */
export const FOOTER_MAX = 120;
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
          vis += l.segments.length * 2.2 + (l.marker >= 0 ? 1.6 : 0); // a bar is a wide drawn area
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
  vis += (spec.metrics?.length ?? 0) * 0.8; // before-to-after number cards are drawn, not prose
  return vis + txt === 0 ? 0 : vis / (vis + txt);
}

/** Does the panel show something (elements, segments, messages, data paths), not just labels? */
function panelProblem(p: Panel, i: number): string | null {
  const n = `panel ${i + 1}`;
  if (!p.caption) return `${n} needs a caption: one sentence about what the user can now do`;
  switch (p.kind) {
    case "ui":
      if (p.elements.length < 2) return `${n} has fewer than two elements; draw the actual interface`;
      if (p.elements.filter((e) => e.hl).length > 3) return `${n} outlines more than three elements; outline only the one to three that changed, so the eye has one place to go`;
      if (p.elements.every((e) => e.kind === "text")) return `${n} is only text labels; use bar, controls, button, link, bubble, wave or row elements`;
      if (p.elements.filter((e) => e.kind !== "text").length < 3) return `${n} is too sparse; use at least three non-text elements (button, link, controls, row, bubble, bar) for things the reply names, such as a button or link it quotes, or a state it describes; if the reply names fewer, return a flow of the user's steps or no_image, never invented interface`;
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
    default:
      return null;
  }
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "its", "are", "was", "now", "not", "but", "you", "from", "into", "when"]);
const stem = (w: string): string => w.replace(/(?:ing|ed|es|s)$/, "");
const tokens = (t: string): string[] => (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);

/** Most invented elements one ui_before_after panel may carry. Zero highlighted. */
export const MAX_INVENTED_UI = 1;

/** True when at least three quarters of an element's own words appear in the reply. An element with no words of its own (a bare wave) is invented. */
export function elementGrounded(text: string, replyTokens: Set<string>): boolean {
  const own = tokens(text);
  if (own.length === 0) return false;
  return own.filter((w) => replyTokens.has(w)).length / own.length >= 0.75;
}

/**
 * ui_before_after must show only elements the reply names: with no live page to screenshot the model otherwise fills the
 * mockup with plausible chrome. At most MAX_INVENTED_UI per panel, none outlined; the feedback sends it to a flow or no_image.
 */
export function uiGroundingProblem(spec: ExplainSpec, reply: string): string | null {
  if (spec.type !== "ui_before_after") return null;
  const known = new Set(tokens(reply));
  for (const [i, p] of spec.panels.entries()) {
    if (p.kind !== "ui") continue;
    const invented = p.elements.filter((e) => !elementGrounded(e.text, known));
    const n = `panel ${i + 1}`;
    const lit = invented.find((e) => e.hl);
    if (lit) return `${n} outlines "${lit.text}", which the reply never names; outline only what the reply names`;
    if (invented.length > MAX_INVENTED_UI) return `${n} shows elements the reply never names (${invented.map((e) => `"${e.text}"`).join(", ")}); draw only what the reply names, or return a flow of the user's steps, or no_image`;
    if (p.elements.length - invented.length < 3) return `${n} has fewer than three elements the reply names; the reply does not name enough interface to draw it: return a flow of the user's steps (before and after lanes) or no_image`;
  }
  return null;
}

/**
 * Quality gate before rendering: would someone understand the change from the picture alone?
 * Returns feedback for the model, or null when the spec passes.
 */
export function explainGate(spec: ExplainSpec, minDensity: number = MIN_DENSITY, reply?: string): string | null {
  const noDirector = directorProblem(spec);
  if (noDirector) return noDirector;
  // The parser keeps a long footer whole so it is never cut mid-sentence; the model is asked to shorten it instead.
  if (spec.footer.length > FOOTER_MAX) return `the footer is ${spec.footer.length} characters; at most ${FOOTER_MAX}. Keep the numbers, drop the rest`;
  if (isCardPanel(spec.panels[0])) {
    // Reference style: cards, a range axis or layers. No density measure; the rules are about content, not area.
    const p = spec.panels[0]!;
    const empty = cardLabels(p).find((l) => EMPTY_LABELS.test(l.trim()));
    if (empty) return `"${empty}" is a bare status label; show the actual values instead of labeling them`;
    const fake = cardLabels(p).find((l) => PLACEHOLDER.test(l));
    if (fake) return `"${fake}" describes a picture instead of being one; use the real component names and values`;
    return cardsGate(spec);
  }
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
  // Code-level diagrams show what the agent did, not what the user now sees.
  if (spec.type === "sequence") return "a sequence diagram shows how the code works, not what changed for the person; draw what they see instead (a log_compare, state_key or range_chart), or return no_image";
  if (spec.type === "architecture") return "an architecture drawn as boxes and lines shows how the code works, not what changed; it is allowed only as layers (name, detail, icon, link, items): real component names, an icon on each, one flow direction, or return no_image";
  if (spec.type === "log_compare" || spec.type === "state_key" || spec.type === "range_chart" || spec.type === "flow" || spec.type === "ranked" || spec.type === "grid") return `${spec.type} needs its own panel shape (cards, rows)`;
  const ungrounded = reply === undefined ? null : uiGroundingProblem(spec, reply);
  if (ungrounded) return ungrounded;
  const d = visualDensity(spec);
  if (d < minDensity) return `the picture is mostly text (visual density ${(Math.floor(d * 1000) / 1000).toFixed(3)}, needs ${minDensity.toFixed(3)}); draw more mockup elements, arrows, highlights or timeline bars and fewer sentences, or return no_image`;
  return null;
}
