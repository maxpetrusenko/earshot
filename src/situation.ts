/**
 * Situation classifier: picks, with no LLM call, what kind of picture a reply would carry. A deterministic score over
 * the reply's structure (headings, bullets, code, numbers with units) and its vocabulary. This loose classifier only
 * names the situation (the hint that goes to the explain model, and the pick when the user asked for a picture).
 * Whether a picture is made at all is decided in `trigger.ts`: asked, or strong specific evidence.
 */

export const SITUATIONS = ["plan", "architecture", "post", "logic", "bug", "perf", "ui", "schema", "options", "hosts", "none"] as const;
export type Situation = (typeof SITUATIONS)[number];

export interface Classification {
  situation: Situation;
  /** Winning score, 0 for none. */
  score: number;
  /** Where the picture goes: the explain stage, post media (no explain image), or nowhere. */
  route: "explain" | "post-media" | "none";
}

/** What each situation should draw. Passed to the explain model as a hint, never as a command. */
export const SITUATION_HINT: Record<Exclude<Situation, "post" | "none">, string> = {
  plan: "plan review: draw a flow of the plan's steps in order (3 to 7 real step names); mark the step the reader must decide, or that carries the most risk, as changed, and state the scope in the footer. One visual only.",
  architecture: "architecture change: draw layered architecture with real names; outline the layer or piece that moved with core: true.",
  logic: "logic change: draw a flow with before and after lanes sharing step positions; mark the changed branch in both lanes. One visual only.",
  bug: "bug or incident: draw one flow lane. Mark the ROOT CAUSE step (state cause, the earliest step that is actually wrong, with why in the note) and the step that only looks fine (state masked). Show the fix in the cause step's fix field, or close with a fixed step. Set footer_tone from the footer (risk when it states what could have gone wrong). One visual only.",
  perf: "performance result: draw a range_chart from the reply's own numbers, or a log_compare when it is one wrong-looking value.",
  ui: "UI change: draw ui_before_after using only interface elements the reply names (its labels, states and controls); outline what changed. Add no chrome the reply does not mention. If the reply names fewer than three elements per panel, draw a flow of the user's steps instead, or no_image.",
  schema: "data or schema change: draw ui_before_after with plain frames, one row element per column (table name as the frame title), the changed column highlighted, before then after; the footer carries the row counts and the rollback fact from the reply. One visual only.",
  options: "options comparison: draw ranked options, best first, the recommendation first and marked.",
  hosts: "multi-host or agent status: draw a grid with one cell per host or agent, its state and one line of what it is doing that keeps the reply's own numbers (percent, counts, times). Do not drop a host.",
};

const count = (t: string, re: RegExp): number => t.match(re)?.length ?? 0;
const cap = (n: number, m: number): number => Math.min(n, m);

interface Rule {
  re: RegExp;
  w: number;
  /** Highest total one rule can add. */
  max: number;
}
const R = (re: RegExp, w: number, max = w * 3): Rule => ({ re, w, max });

const RULES: Record<Exclude<Situation, "post" | "none">, Rule[]> = {
  bug: [R(/\broot cause\b/gi, 4, 4), R(/\b(?:incident|outage|regression|postmortem)\b/gi, 3), R(/\b(?:bug|crash(?:es|ed)?|stack trace|hotfix|leak)\b/gi, 2), R(/\b(?:fail(?:s|ed|ing|ure)|broke|broken|wrong|stuck)\b/gi, 1, 3), R(/\b(?:the )?cause\b/gi, 1, 2), R(/\bfix(?:ed|es)?\b/gi, 1, 2)],
  perf: [R(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds?|minutes?|kb|mb|gb|x|qps|rps|queries|req\/s|%)(?![a-z])/gi, 1.5, 6), R(/\b(?:faster|slower|latency|throughput|p9[59]|benchmark|speed-?up|slow|wait(?:s|ed)?)\b/gi, 1.5, 6), R(/\bfrom \d[\d.,]*\s?\w* to \d/gi, 2, 4)],
  schema: [R(/\b(?:schema|migration|migrations|column|columns|foreign key|backfill|primary key)\b/gi, 3, 9), R(/\b(?:alter|create|drop) table\b/gi, 4, 4), R(/\b(?:tables?|rows?|index(?:es)?)\b/gi, 1, 4)],
  ui: [R(/\b(?:button|screen|modal|sidebar|layout|css|ui|ux|dialog|tooltip|toolbar|navbar|viewport|responsive|dropdown|tab)\b/gi, 1.5, 7.5), R(/\b(?:user sees|looks like|renders?|rendered|mobile)\b/gi, 1.5, 4.5), R(/https?:\/\/(?:localhost|127\.0\.0\.1)[:/\w.-]*/gi, 3, 3)],
  logic: [R(/\b(?:branch|condition(?:al)?|retry|retries|fallback|handler|state machine|validation|returns?|early return|else)\b/gi, 1.5, 7.5), R(/\b(?:now (?:checks|retries|waits|skips|returns|falls)|instead of|used to|previously)\b/gi, 2.5, 7.5), R(/\bbefore\b[\s\S]{0,400}\bafter\b/gi, 3, 3), R(/\b(?:flow|logic)\b/gi, 1.5, 3)],
  architecture: [R(/\b(?:architecture|layers?|daemon|boundary|monolith|microservices?|pipeline|abstraction)\b/gi, 2, 8), R(/\b(?:refactor(?:ed)?|moved|split|extract(?:ed)?|decoupl\w+|separate(?:d)?)\b/gi, 1.5, 6), R(/\b(?:services?|modules?|components?|queue|gateway|worker|launchagent|socket|splits? into|capabilit\w+)\b/gi, 1, 5)],
  options: [R(/\b(?:options?|alternatives?|trade-?offs?|pros|cons|ranked|ranking)\b/gi, 2, 8), R(/\b(?:recommend(?:ed|ation)?|i['’]d pick|go with)\b/gi, 2.5, 5), R(/\boption [a-d1-4]\b/gi, 2, 6), R(/\b[a-z0-9 ]{3,24} vs\.? [a-z0-9 ]{3,24}\b/gi, 1.5, 3)],
  hosts: [R(/\b(?:pro|maxiclaw|uniclaw|vps-builder|vps-prod|mini|contabo|host|hosts|node|nodes)\b/gi, 1.5, 9), R(/\b(?:agents?|workers?|fleet|running on|idle|online|offline)\b/gi, 1.5, 6), R(/\bstatus\b/gi, 1.5, 3)],
  plan: [R(/\b(?:plan|roadmap|milestones?|phase \d|next steps|proposal|proposed|scope|rollout|slices?)\b/gi, 2, 8), R(/\bstep \d\b/gi, 1.5, 4.5), R(/^\s*\d+[.)]\s+/gm, 1.2, 6)],
};

/** Order of preference on a tie: the more specific story wins. */
const PRIORITY: Exclude<Situation, "post" | "none">[] = ["bug", "perf", "schema", "ui", "logic", "options", "hosts", "architecture", "plan"];
const THRESHOLD = 5;

const POST = /\b(?:tweet|x post|linkedin post|post draft|caption|hook line|draft (?:for|of) (?:an? )?(?:x|twitter|linkedin) post)\b/i;
const DRAFT = /\b(?:here['’]?s (?:a |the )?draft|draft (?:reply|email)|subject:|dear |hi [a-z]+,|best,|regards,)/i;
const TEST_RESULT = /\b\d+\s+(?:tests?|specs?|checks?)\s+(?:pass|passed|passing)\b|\b(?:lint|typecheck|tsc|eslint|build)\s+(?:is\s+)?(?:clean|passes|passed|green|ok)\b|\ball (?:checks|tests) (?:pass|green)\b/i;
const STATUS = /\b(?:pr (?:opened|merged)|pushed|ci (?:pending|green|running)|nothing (?:is )?waiting|no files changed|committed)\b/i;

/** Structure score: headings, bullets, code and numbers make a reply a candidate for a picture. */
function structure(t: string): number {
  return cap(count(t, /^#{1,4}\s/gm), 3) * 0.8 + cap(count(t, /^\s*(?:[-*+]|\d+[.)])\s/gm), 6) * 0.4 + cap(count(t, /```/g) / 2, 2) * 0.5;
}

export function classifyReply(reply: string): Classification {
  const t = reply.replace(/::orca-visual\{[^}]*\}/g, "").replace(/\[Listen\]\([^)]*\)[^\n]*/g, "").trim();
  const none: Classification = { situation: "none", score: 0, route: "none" };
  if (t.length < 80) return none;
  if (POST.test(t)) return { situation: "post", score: 1, route: "post-media" };
  const scores = new Map<Situation, number>();
  for (const s of PRIORITY) scores.set(s, RULES[s].reduce((a, r) => a + cap(count(t, r.re) * r.w, r.max), 0));
  const best = PRIORITY.reduce((a, b) => (scores.get(b)! > scores.get(a)! ? b : a));
  const base = scores.get(best)!;
  // Status, test results and drafts are never pictures, however many numbers they carry.
  if ((TEST_RESULT.test(t) || STATUS.test(t) || DRAFT.test(t)) && t.length < 450 && base < THRESHOLD + 8) return none;
  if (base < THRESHOLD) return none;
  return { situation: best, score: Math.round((base + structure(t)) * 10) / 10, route: "explain" };
}

/** First page the reply names: an http(s) URL, or a localhost:port mention. Null when none. */
export function findPageUrl(reply: string): string | null {
  const m = /https?:\/\/[^\s)>\]"'`]+|\blocalhost:\d{2,5}[^\s)>\]"'`]*/i.exec(reply);
  if (!m) return null;
  const raw = m[0].replace(/[.,;:!?]+$/, "");
  return /^https?:/i.test(raw) ? raw : `http://${raw}`;
}
