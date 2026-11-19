import { cleanWords } from "./explain-util.js";
import type { FlowPanel, FlowStep, GridPanel, RankedPanel, StepState } from "./explain-cards-schema.js";

/** Gates for the three list-shaped panels: a flow, ranked options and a host grid. Each returns feedback the model can act on, or null. */

/** A step or option name that names nothing. */
const GENERIC_STEP = /^(?:component|service|module|box|layer|node|block|thing|item|step|stage|phase|process|handle|handler|logic|start|end|begin|finish|done|next|action|task|check|validate|run|do|option|choice|plan|approach|variant)(?:\s+[a-z]?\d{1,2})?$/i;

export const FLOW_MIN = 3;
export const FLOW_MAX = 7;

/** What the picture has room for; matches the prompt (detail 30, note 80, fix 80, link 24). */
export const STEP_LIMIT = { detail: 34, note: 80, fix: 80, link: 24 };

const marked = (steps: FlowStep[]): FlowStep[] => steps.filter((s) => s.state !== "ok");
const FAIL_STATES: readonly StepState[] = ["cause"];

/** Words a step name may not end on or start with: the sentence was cut or never began. */
const DANGLING = /^(?:the|a|an|of|to|and|or|but|is|are|was|were|then|with|for|in|on|at|by|that|which)$/i;
const NAME_WORDS_MAX = 5;
const wordsOf = (t: string): string[] => t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const stemOf = (w: string): string => w.replace(/(?:ing|ed|es|s)$/, "");
const FILLER = new Set(["the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "at", "by", "for", "with", "it", "ok"]);

/** Why a step name reads badly, or null. Short noun or verb phrases pass; sentences, repeated words and cut-off names do not. */
export function stepNameProblem(name: string): string | null {
  const t = name.trim();
  const ws = wordsOf(t);
  if (ws.length > NAME_WORDS_MAX) return `has ${ws.length} words; at most ${NAME_WORDS_MAX}`;
  if (/[.!?;:]$/.test(t)) return "reads as a sentence; drop the end punctuation and name the thing";
  if (DANGLING.test(ws[0] ?? "") || DANGLING.test(ws[ws.length - 1] ?? "")) return "starts or ends on a filler word";
  const seen = new Set<string>();
  for (const w of ws) {
    if (FILLER.has(w) || w.length < 3) continue;
    const k = stemOf(w);
    if (seen.has(k)) return `repeats the word "${w}"`;
    seen.add(k);
  }
  return null;
}

const NAME_HINT = 'rewrite it as a short noun phrase or verb phrase, for example "Empty list logged as ok" or "Read Studio, Slack, Gmail"';

/**
 * Flow: real step names, one direction, three to seven steps, an icon on every step. A step is one of: ok, cause (the
 * root cause, red), masked (looks fine, hides the cause, amber), changed (accent), fixed (green). Something must be marked.
 * A bug flow (one lane with a cause or masked step, or a bug situation) must mark the root cause and show the fix, so the
 * reader gets where it broke, what only looked fine, and what to do. Icons must not contradict the state: the alert icon is
 * for the cause only, and the cause never wears a success icon. Two lanes share positions, so they must have the same
 * number of steps and each lane must mark where it differs.
 */
export function flowProblem(p: FlowPanel, opts: { situation?: string; reply?: string } = {}): string | null {
  if (p.lanes.length > 2) return "a flow has one lane or two (before and after)";
  for (const lane of p.lanes) {
    if (lane.steps.length < FLOW_MIN || lane.steps.length > FLOW_MAX) return `each flow lane needs ${FLOW_MIN} to ${FLOW_MAX} steps, got ${lane.steps.length}`;
    const generic = lane.steps.find((s) => GENERIC_STEP.test(s.name.trim()));
    if (generic) return `"${generic.name}" is not a real step name; use the function, branch or state the reply names`;
    const badName = lane.steps.map((s) => ({ s, why: stepNameProblem(s.name) })).find((x) => x.why);
    if (badName) return `the step name "${badName.s.name}" ${badName.why}; ${NAME_HINT}`;
    const dup = lane.steps.find((s, i) => lane.steps.findIndex((o) => o.name.trim().toLowerCase() === s.name.trim().toLowerCase()) !== i);
    if (dup) return `two steps are both named "${dup.name}"; every step needs its own name`;
    const echo = lane.steps.find((s) => s.detail && s.detail.trim().toLowerCase() === s.name.trim().toLowerCase());
    if (echo) return `the detail of "${echo.name}" repeats its name; say something new or leave it empty`;
    // A step the same in both lanes is drawn as a name in the "unchanged" row, never as a tile, so it needs no icon.
    const other = p.lanes.length === 2 ? p.lanes.find((l) => l !== lane) : undefined;
    const bare = lane.steps.find((s, i) => !s.icon && !(other && s.state === "ok" && other.steps[i]?.state === "ok" && other.steps[i]!.name === s.name));
    if (bare) return `"${bare.name}" needs an icon from the allowed list`;
    const wrongIcon = lane.steps.find((s) => (s.icon === "alert" && !FAIL_STATES.includes(s.state)) || (s.icon === "check" && FAIL_STATES.includes(s.state)));
    if (wrongIcon) return wrongIcon.icon === "alert" ? `"${wrongIcon.name}" has the alert icon but is not the root cause; the warning triangle is for the cause only, pick another icon` : `the root cause "${wrongIcon.name}" has a success icon; a failure never gets a check, pick another icon`;
    const long = lane.steps.find((s) => s.note.length > STEP_LIMIT.note || s.detail.length > STEP_LIMIT.detail);
    if (long) return long.note.length > STEP_LIMIT.note ? `the note on "${long.name}" is ${long.note.length} characters; at most ${STEP_LIMIT.note}. Write a short phrase, not a sentence` : `the detail on "${long.name}" is ${long.detail.length} characters; at most ${STEP_LIMIT.detail}`;
    const longFix = lane.steps.find((s) => s.fix.length > STEP_LIMIT.fix);
    if (longFix) return `the fix on "${longFix.name}" is ${longFix.fix.length} characters; at most ${STEP_LIMIT.fix}. Write a short phrase, not a sentence`;
    const longLink = lane.steps.find((s) => s.link.length > STEP_LIMIT.link);
    if (longLink) return `the arrow label on "${longLink.name}" is ${longLink.link.length} characters; at most ${STEP_LIMIT.link}`;
    if (opts.reply !== undefined) {
      const invented = lane.steps.find((s) => s.link && !linkGrounded(s.link, opts.reply!));
      if (invented) return `the arrow label "${invented.link}" is not in the reply; label an arrow only with a timing or word the reply gives, or leave link empty`;
    }
    const noCause = lane.steps.find((s) => s.state === "cause" && !s.note);
    if (noCause) return `the root cause step "${noCause.name}" needs a note with the cause`;
  }
  const all = p.lanes.flatMap((l) => l.steps);
  if (marked(all).length === 0) return 'a flow needs the changed step or the root cause marked: set state to "cause", "changed" or "fixed" on it';
  const [a, b] = p.lanes;
  if (b) {
    if (a!.steps.length !== b.steps.length) return "before and after lanes share step positions, so they need the same number of steps";
    if (marked(a!.steps).length === 0 || marked(b.steps).length === 0) return "mark the step that differs in both lanes (changed or cause in BEFORE, changed in AFTER)";
    const same = a!.steps.every((s, i) => s.name === b.steps[i]!.name && s.state === b.steps[i]!.state);
    if (same) return "the before and after lanes are identical; show what differs";
    return null;
  }
  const bug = all.some((s) => s.state === "cause" || s.state === "masked") || opts.situation === "bug";
  if (!bug) return null;
  const causes = all.filter((s) => s.state === "cause");
  if (causes.length === 0) return 'a bug flow must mark the root cause: set state "cause" on the step that makes it fail (not on the step that only looks fine; that one is "masked")';
  if (causes.length > 1) return `a bug flow has one root cause, got ${causes.length}; keep "cause" on the one that starts the failure and mark the others "masked" or leave them unmarked`;
  const hasFix = causes[0]!.fix || all.some((s) => s.state === "fixed");
  if (!hasFix) return `a bug flow must show the fix: put it in the "fix" of the root cause step "${causes[0]!.name}" (for example "Enable the setting"), or close the chain with a step whose state is "fixed"`;
  return null;
}

/** An arrow label is the reply's own: its words (or numbers) appear in the reply. */
export function linkGrounded(link: string, reply: string): boolean {
  const own = wordsOf(link).filter((w) => !FILLER.has(w));
  if (own.length === 0) return false;
  const known = new Set(wordsOf(reply).map(stemOf));
  return own.every((w) => known.has(stemOf(w)));
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

/**
 * Last resort after the model was already asked once to shorten: cut flow notes, details and fixes at a word boundary
 * so a picture that is right except for a few characters ships instead of dropping to the fallback card.
 */
export function shortenFlowText<T extends { panels: unknown[] }>(spec: T): T {
  for (const p of spec.panels as FlowPanel[]) {
    if (p.kind !== "flow") continue;
    for (const s of p.lanes.flatMap((l) => l.steps)) {
      s.note = cleanWords(s.note, STEP_LIMIT.note);
      s.fix = cleanWords(s.fix, STEP_LIMIT.fix);
      s.detail = cleanWords(s.detail, STEP_LIMIT.detail);
      s.link = cleanWords(s.link, STEP_LIMIT.link);
    }
  }
  return spec;
}
