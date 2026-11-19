/**
 * When does a reply get an image? Two paths, no LLM call.
 *
 * Asked: the user's latest message asks for a visual (visualize, diagram, chart, draw, show me the architecture...).
 * Then there is always one, and the situation is picked from the reply.
 *
 * Not asked: only strong, specific evidence in the reply counts, and only four stories are worth drawing unprompted:
 * a measured before-to-after (perf), a structure word next to a change verb (architecture), a named cause and a named
 * fix (bug), and a status table whose rows are hosts or agents (hosts). Generic ops vocabulary scores nothing. The reply
 * must be about 1200 characters, clear a confidence bar, and respect the per-session rate limit.
 */
import { classifyReply, type Classification, type Situation } from "./situation.js";

/** The not-asked path needs a reply this long; shorter replies carry no picture. */
export const AUTO_MIN_CHARS = 1200;
/** Lowest confidence that counts as strong evidence. */
export const CONFIDENCE_MIN = 6;
/** At most one automatic image per session in this window. */
export const RATE_WINDOW_MS = 10 * 60_000;

// ---------------------------------------------------------------- asked

/** Strip what is not the user's own words: injected reminders, task notices, pasted blocks and image placeholders. */
export function userWords(prompt: string): string {
  return prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, " ")
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, " ")
    .replace(/\[Image #\d+\]/g, " ")
    .slice(0, 1000);
}

/** Programmatic prompts (reviewer briefs, quality checks) are not a person asking for a picture. */
const PROGRAMMATIC = /^\s*(?:you are\b|\/no_think|johto quality check)/i;
/** Imperative forms that ask for a picture on their own. */
const ASK_STRONG = /\bvisuali[sz]e\b|\bdraw (?:me|a|an|the|this|it)\b|\bsketch (?:me|a|an|the|this|it|out)\b|\bdiagram (?:of|for|this|it|the)\b|\b(?:compare|show) (?:it )?visually\b|\bvisually compare\b/i;
const FILLER = String.raw`(?:(?:me|us|it|them|an?|the|some|any|this|that|my|your|one|two|three|\d|actual|real|quick|simple|small|nice|good|better|visual|useful|clear|high-quality|new|timeline|architecture|flow|data|latency|before|after|and|system|network|sequence|bar|line|pie)\s+){0,4}`;
/** A request verb right in front of a picture noun: "make a chart", "show me an image", "draw a diagram". */
const ASK_PICTURE = new RegExp(String.raw`\b(?:show|give|make|create|generate|produce|need|want|send|draw|please|can you|could you|let me see)\s+(?:to\s+)?${FILLER}(?:images?|pictures?|visuals?|diagrams?|charts?|graphs?|plots?|flow-?charts?|infographics?|mock-?ups?|sketch(?:es)?)\b`, "gi");
/** Architecture, flow and timeline are everyday words; only a show-or-draw verb makes them a request for a picture. */
const ASK_SHOW = /\b(?:show|draw|map|sketch|present|pull|visuali[sz]e|diagram)\b[^.\n?!]{0,40}?\b(?:architecture|flows?|timeline|data flow)\b/i;
const NEGATION = /(?:\bdon['’]?t|\bdo not|\bno|\bnot|\bnever|\bwithout|n['’]t)\b[^.\n]{0,25}$/i;

/** A picture-request match that is not negated just before the verb ("no need to show any images"). */
const pictureAsk = (t: string): boolean => [...t.matchAll(ASK_PICTURE)].some((m) => !NEGATION.test(t.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0)));

/** True when the user's latest message asks for a visual. */
export function asksForVisual(prompt: string | undefined | null): boolean {
  if (!prompt || PROGRAMMATIC.test(prompt)) return false;
  const t = userWords(prompt);
  return ASK_STRONG.test(t) || pictureAsk(t) || ASK_SHOW.test(t);
}

// ---------------------------------------------------------------- not asked

const NUM = String.raw`\d[\d.,]*\+?`;
const UNIT = String.raw`(?:ms|s|sec|seconds?|min|minutes?|hours?|h|kb|mb|gb|x|qps|rps|queries|req\/s|%)(?![a-z])`;
const SIDE = String.raw`${NUM}\s?(?:${UNIT})?`;
const ARROW = String.raw`\s*(?:→|->|=>)\s*`;
const PAIRS: RegExp[] = [new RegExp(`(${SIDE})${ARROW}(${SIDE})`, "gi"), new RegExp(String.raw`\bfrom\s+(${SIDE})\s+to\s+(${SIDE})`, "gi"), new RegExp(String.raw`\b(${NUM}\s?${UNIT})\s+to\s+(${NUM}\s?${UNIT})`, "gi"), new RegExp(String.raw`\b(\d+\+)\s+to\s+(${NUM})`, "gi")];
const HAS_UNIT = new RegExp(UNIT, "i");
/** Capacity and housekeeping changes are not performance results. */
const HOUSEKEEPING = /\b(?:free|freed|disk|space|swap|memory|storage|ram|backup|briefs?|folder|rows|files)\b/i;

/** Units of time, size and throughput. A percentage or a bare count alone is not a measured result. */
const PERF_UNIT = /(?:ms|s|sec|seconds?|min|minutes?|hours?|h|kb|mb|gb|x|qps|rps|queries|req\/s)(?![a-z])/i;
/** "from 30 to 55 min" is a range until a verb says something changed. Arrows say it themselves. */
const CHANGED = /\b(?:went|goes|dropped?|down|up|cut|cuts|reduced?|shr[ua]nk|grew|rose|fell|improved?|brought|sped|slowed|now|was|were|moved|shaved|saves?|saved)\b/i;
const PERF_NOUN = /\b(?:latency|p9[059]|faster|slower|speed|response time|load time|took|takes|per turn|throughput|bundle|startup|build time|runtime|render|cold start)\b/i;

/** Spoken scripts and quoted claims ("Say this: ...") are not results the reply reports. */
const withoutQuotes = (t: string): string => t.replace(/^\s*>.*$/gm, " ").replace(/["“][^"”\n]{20,400}["”]/g, " ");

/** Evidence from distinct before-to-after pairs: 6 for a time, size or throughput pair; 3 for a percentage or bare count, plus 3 when the sentence names a perf noun. Sums across pairs. */
export function beforeAfterScore(raw: string): number {
  const t = withoutQuotes(raw);
  const seen: number[] = [];
  let score = 0;
  for (const re of PAIRS) {
    for (const m of t.matchAll(re)) {
      const a = m[1] ?? "";
      const b = m[2] ?? "";
      if (!HAS_UNIT.test(a) && !HAS_UNIT.test(b) && !/\+/.test(a + b)) continue;
      const at = m.index ?? 0;
      if (HOUSEKEEPING.test(t.slice(Math.max(0, at - 60), at + m[0].length))) continue;
      // The same pair can match two patterns; one position counts once.
      if (seen.some((p) => Math.abs(p - at) < 6)) continue;
      const sentence = t.slice(Math.max(0, t.lastIndexOf("\n", at), t.lastIndexOf(". ", at)), at + m[0].length + 30);
      if (!/→|->|=>/.test(m[0]) && !CHANGED.test(t.slice(Math.max(0, at - 45), at + m[0].length))) continue;
      seen.push(at);
      // A percentage or a bare count is not a measured result on its own; it needs a perf noun in the same sentence.
      score += PERF_UNIT.test(a.replace(/^[\d.,+\s]+/, "")) || PERF_UNIT.test(b.replace(/^[\d.,+\s]+/, "")) ? 6 : PERF_NOUN.test(sentence) ? 6 : 0;
    }
  }
  return score;
}

const tableRows = (t: string): string[][] => {
  const rows: string[][] = [];
  for (const line of t.split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  return rows;
};

/** A markdown table of measured numbers: a Before and Now (or After) table with numbers in three rows, or three rows with two columns of numbers with units. */
function measuredTable(t: string): boolean {
  const all = tableRows(t);
  const rows = all.slice(1);
  if (rows.length < 3) return false;
  const head = (all[0] ?? []).map((h) => h.toLowerCase());
  const bi = head.findIndex((h) => /^(?:before|was|old|baseline)\b/.test(h));
  const ai = head.findIndex((h) => /^(?:after|now|new)\b/.test(h));
  if (bi >= 0 && ai >= 0 && rows.filter((r) => /\d/.test(r[bi] ?? "") && /\d/.test(r[ai] ?? "")).length >= 3) return true;
  const cols = Math.max(...rows.map((r) => r.length));
  let numeric = 0;
  for (let c = 0; c < cols; c++) if (rows.filter((r) => new RegExp(`${NUM}\\s?${UNIT}`, "i").test(r[c] ?? "")).length >= Math.ceil(rows.length / 2)) numeric++;
  return numeric >= 2;
}

const STRUCT = /\b(?:architecture|architectural|layers?|boundar(?:y|ies)|component diagram|data flow|topology)\b/i;
const CHANGE = /\b(?:added|moved|replaced|split into|now goes through|now routes? through|introduced|extracted|merged into|collapsed|inserted|separated into|rewired)\b/i;

/** Sentences and bullets: a structure word and a change verb in the same one. */
export function architectureHits(t: string): number {
  return t.split(/\n+|(?<=[.!?])\s+/).filter((u) => u.length <= 320 && !/^\s*[|>]/.test(u) && !/^\s*["“]/.test(u) && STRUCT.test(u) && CHANGE.test(u)).length;
}

/** An explicit cause statement ("Root cause:", "root cause is", "caused by"), not a mention ("the root cause of", a quoted nudge, "root cause fixed"). */
const CAUSE = /\broot cause\b(?:\*\*)?\s*(?::|is\b|was\b|\()|\bcaused by\b|\bthe cause (?:is|was)\b|\bcause (?:is|was) confirmed\b/i;
/** An explicit fix statement after it: a Fix label, "fixed by", "the fix", not the bare word. */
const FIX = /\*\*fix(?:ed)?[:.]?\*\*|(?:^|\n)\s*(?:[-*]\s*)?fix(?:ed)?\s*:|\bfixed by\b|\bthe fix (?:is|was)\b|\bfix:/i;
/** A score or rating is a review of something, not a bug report, even when it lists what was fixed. */
const RATING = /\b\d+(?:\.\d+)?\s?\/\s?10\b/;

/** An explicit cause, then a fix, both named; stronger when the lead of the reply is about it. */
export function bugConfidence(t: string): number {
  if (RATING.test(t)) return 0;
  const c = CAUSE.exec(t);
  if (!c) return 0;
  const after = t.slice(c.index + c[0].length, c.index + c[0].length + 900);
  if (!FIX.test(after)) return 0;
  // Both named is not enough: the reply's own lead has to be about the bug, or it is a status report with a bug section.
  return /\b(?:root cause|caused by|cause|fix(?:ed)?|bug|broke|broken)\b/i.test(t.slice(0, 500)) ? 8 : 4;
}

const HOST_NAME = String.raw`(?:pro|macbook(?: pro)?|maxiclaw|uniclaw|mini|mac mini|vps-builder|vps-prod|contabo|hermes|claude(?: code)?|codex|grok|cursor|opencode2?|opus|sonnet|agent \w+|worker \w+)`;
const HOST_CELL = new RegExp(String.raw`^(?:\*\*)?\`?${HOST_NAME}\`?(?:\*\*)?(?:\s*\([^)]*\))?$`, "i");
/** A status table or grid: three or more rows whose first cell is a host or an agent by name . */
export function hostsTable(t: string): boolean {
  const rows = tableRows(t);
  if (rows.length < 4) return false;
  const named = new Set(rows.slice(1).map((r) => (r[0] ?? "").toLowerCase()).filter((c) => HOST_CELL.test(c)));
  return named.size >= 3;
}

/** Text made for the user to use elsewhere (a spoken answer, a cover letter, a resume claim, meeting prep) is a document, not a report of work. */
const DOCUMENT = /\bsay:|\b(?:say this|say it like this|cover letter|(?<![/\w])resume|talk track|meeting prep|interview|recruiter|call prep|here['’]?s (?:a |the )?draft)\b/i;

/** The strict, not-asked classifier. Situation is perf, architecture, bug, hosts or none; score is the confidence. */
export function classifyStrict(reply: string): Classification {
  const t = reply.replace(/::orca-visual\{[^}]*\}/g, "").replace(/\[Listen\]\([^)]*\)[^\n]*/g, "").trim();
  const none: Classification = { situation: "none", score: 0, route: "none" };
  if (t.length < AUTO_MIN_CHARS) return none;
  if (DOCUMENT.test(t)) return none;
  const pairScore = beforeAfterScore(t);
  const scores: [Situation, number][] = [
    ["bug", bugConfidence(t)],
    ["perf", Math.min(pairScore, 12) + (measuredTable(t) ? 6 : 0)],
    ["architecture", Math.min(architectureHits(t), 2) * 6],
    ["hosts", hostsTable(t) ? 8 : 0],
  ];
  let best: [Situation, number] = ["none", 0];
  for (const s of scores) if (s[1] > best[1]) best = s;
  if (best[1] < CONFIDENCE_MIN) return none;
  return { situation: best[0], score: best[1], route: "explain" };
}

// ---------------------------------------------------------------- decision

export interface TriggerState {
  /** When the last automatic image for this session was made. */
  lastAutoAt?: number;
  /** Whether the previous reply in this session had an image. */
  lastHadImage?: boolean;
}

export interface Decision {
  visual: boolean;
  situation: Situation;
  /** asked, forced, auto, or why not. */
  why: string;
  /** True when this reply carries an automatic (not asked, not forced) image: the rate limiter counts it. */
  auto: boolean;
}

export interface DecideInput {
  reply: string;
  /** The user's latest message, when the caller has it. */
  prompt?: string | null;
  /** `--visual` (true) or `--no-visual` (false). */
  flag?: boolean;
  /** Config visuals.auto. */
  autoOn: boolean;
  state?: TriggerState;
  now?: number;
}

/** The situation for an asked picture: the loose reply classifier, else its best guess, else a plain flow. */
function askedSituation(reply: string): Situation {
  const c = classifyReply(reply);
  return c.situation === "none" || c.situation === "post" ? "plan" : c.situation;
}

export function decideVisual(i: DecideInput): Decision {
  if (i.flag === false) return { visual: false, situation: "none", why: "--no-visual", auto: false };
  if (i.flag === true) return { visual: true, situation: askedSituation(i.reply), why: "--visual", auto: false };
  if (asksForVisual(i.prompt)) return { visual: true, situation: askedSituation(i.reply), why: "asked", auto: false };
  if (!i.autoOn) return { visual: false, situation: "none", why: "visuals.auto is off", auto: false };
  const c = classifyStrict(i.reply);
  if (c.route !== "explain") return { visual: false, situation: "none", why: "no strong evidence", auto: false };
  const now = i.now ?? Date.now();
  if (i.state?.lastHadImage) return { visual: false, situation: c.situation, why: "rate limit: previous reply had an image", auto: false };
  if (i.state?.lastAutoAt !== undefined && now - i.state.lastAutoAt < RATE_WINDOW_MS) return { visual: false, situation: c.situation, why: "rate limit: one automatic image per 10 minutes", auto: false };
  return { visual: true, situation: c.situation, why: `auto ${c.situation} (${c.score})`, auto: true };
}
