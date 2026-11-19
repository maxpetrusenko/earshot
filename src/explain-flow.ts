import type { FlowPanel, FlowStep, GridPanel, RankedPanel } from "./explain-cards-schema.js";

/** Gates for the three list-shaped panels: a flow, ranked options and a host grid. Each returns feedback the model can act on, or null. */

/** A step or option name that names nothing. */
const GENERIC_STEP = /^(?:component|service|module|box|layer|node|block|thing|item|step|stage|phase|process|handle|handler|logic|start|end|begin|finish|done|next|action|task|check|validate|run|do|option|choice|plan|approach|variant)(?:\s+[a-z]?\d{1,2})?$/i;

export const FLOW_MIN = 3;
export const FLOW_MAX = 7;

const marked = (steps: FlowStep[]): FlowStep[] => steps.filter((s) => s.state !== "ok");

/**
 * Flow: real step names, one direction, three to seven steps, an icon on every step. The changed or broken step is
 * required: a flow with nothing marked is only a chain of boxes. A broken step carries its cause. Two lanes share
 * positions, so they must have the same number of steps and each lane must mark where it differs.
 */
export function flowProblem(p: FlowPanel): string | null {
  if (p.lanes.length > 2) return "a flow has one lane or two (before and after)";
  for (const lane of p.lanes) {
    if (lane.steps.length < FLOW_MIN || lane.steps.length > FLOW_MAX) return `each flow lane needs ${FLOW_MIN} to ${FLOW_MAX} steps, got ${lane.steps.length}`;
    const generic = lane.steps.find((s) => GENERIC_STEP.test(s.name.trim()));
    if (generic) return `"${generic.name}" is not a real step name; use the function, branch or state the reply names`;
    const bare = lane.steps.find((s) => !s.icon);
    if (bare) return `"${bare.name}" needs an icon from the allowed list`;
    const noCause = lane.steps.find((s) => s.state === "broken" && !s.note);
    if (noCause) return `the broken step "${noCause.name}" needs a note with the cause`;
  }
  const all = p.lanes.flatMap((l) => l.steps);
  if (marked(all).length === 0) return 'a flow needs the changed or broken step marked: set state to "changed" or "broken" on it';
  const [a, b] = p.lanes;
  if (b) {
    if (a!.steps.length !== b.steps.length) return "before and after lanes share step positions, so they need the same number of steps";
    if (marked(a!.steps).length === 0 || marked(b.steps).length === 0) return "mark the step that differs in both lanes (changed or broken in BEFORE, changed in AFTER)";
    const same = a!.steps.every((s, i) => s.name === b.steps[i]!.name && s.state === b.steps[i]!.state);
    if (same) return "the before and after lanes are identical; show what differs";
  }
  return null;
}

/** Ranked options: two to five real names in rank order, the recommendation marked and first. */
export function rankedProblem(p: RankedPanel): string | null {
  if (p.items.length < 2 || p.items.length > 5) return "ranked options need two to five options";
  const generic = p.items.find((i) => GENERIC_STEP.test(i.name.trim()));
  if (generic) return `"${generic.name}" is not a real option name; name the approach`;
  if (p.items.some((i) => !i.detail)) return "every option needs one line saying why it ranks there";
  const rec = p.items.filter((i) => i.recommended);
  if (rec.length !== 1) return "mark exactly one option as recommended";
  if (!p.items[0]!.recommended) return "options are ranked best first: the recommended option is first";
  return null;
}

/** Host or agent grid: two to six named cells, each with an icon and a line saying what it does. */
export function gridProblem(p: GridPanel): string | null {
  if (p.cells.length < 2 || p.cells.length > 6) return "a status grid needs two to six hosts or agents";
  if (new Set(p.cells.map((c) => c.name.toLowerCase())).size !== p.cells.length) return "every cell needs its own name";
  const bare = p.cells.find((c) => !c.icon || !c.line);
  if (bare) return `"${bare.name}" needs an icon and a line saying what it is doing`;
  const generic = p.cells.find((c) => GENERIC_STEP.test(c.name.trim()));
  if (generic) return `"${generic.name}" is not a real host or agent name`;
  return null;
}
