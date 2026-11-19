import { cleanText } from "./explain-util.js";

/**
 * Footer tone and the one duration stat. The model supplies the tone and names the two clock times of a span; code
 * checks both times are in the reply and does the arithmetic, so a duration is never a number the model made up.
 */

export const FOOTER_TONES = ["risk", "bad", "good", "neutral"] as const;
export type FooterTone = (typeof FOOTER_TONES)[number];

/** Words that say something bad could happen or did. A footer with these never gets a green dot. */
const NEGATIVE = /\b(?:could have|might have|may have|missed|lost|loses|losing|blind|stuck|fails?|failed|failing|broken|breaks?|risk(?:s|y)?|unsafe|wrong|never|no longer works?|leaks?|crash(?:es|ed)?|down|dropped|stale)\b/i;
const POSITIVE = /\b(?:fixed|now (?:passes|works|stops|runs)|verified|restored|recovered|resolved|safe|passes|passing)\b/i;

export const isNegativeText = (t: string): boolean => NEGATIVE.test(t);

/** The tone for a footer the model gave no tone for: only a clear signal moves it off neutral. */
export function inferFooterTone(footer: string): FooterTone {
  if (!footer) return "neutral";
  if (NEGATIVE.test(footer)) return "risk";
  if (POSITIVE.test(footer)) return "good";
  return "neutral";
}

export function parseFooterTone(v: unknown): FooterTone | "" {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (t === "warn" || t === "warning" || t === "amber" || t === "negative") return "risk";
  if (t === "red" || t === "error") return "bad";
  if (t === "green" || t === "positive" || t === "ok" || t === "outcome") return "good";
  if (t === "gray" || t === "grey") return "neutral";
  return (FOOTER_TONES as readonly string[]).includes(t) ? (t as FooterTone) : "";
}

/** The two clock times and the word for the span, as the model wrote them. */
export interface SpanRef {
  from: string;
  to: string;
  /** What the span measures, one or two words: "blind", "to recover". */
  label: string;
}
export interface Stat {
  /** Computed by code, for example "15.5 h". */
  value: string;
  label: string;
  /** The reply's own two times, for example "07:00 to 22:30". */
  range: string;
}

export function parseSpan(v: unknown): SpanRef | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const from = cleanText(r.from, 12);
  const to = cleanText(r.to, 12);
  return from && to ? { from, to, label: cleanText(r.label, 18) } : null;
}

/** Minutes after midnight for 07:00, 7:05, 22:30, 7 pm, 7:30 am; null for anything else. */
export function clockMinutes(t: string): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  } else if (h > 23 || !m[2]) return null;
  return h * 60 + min;
}

/** 45 min, 1 h 20 min, 15.5 h, 3 h. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 180 && minutes % 60 !== 0 && minutes % 30 !== 0) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inReply = (reply: string, t: string): boolean => new RegExp(`(?<![\\d:])${escapeRe(t.trim())}(?![\\d:]\\d)`, "i").test(reply);

/**
 * The stat for a span, or null. Both times must appear in the reply and the end must differ from the start; a span that
 * ends earlier than it starts crosses midnight. A span over 24 hours is dropped: a clock time cannot tell it.
 */
export function durationStat(span: SpanRef | null, reply: string): Stat | null {
  if (!span) return null;
  if (!inReply(reply, span.from) || !inReply(reply, span.to)) return null;
  const a = clockMinutes(span.from);
  const b = clockMinutes(span.to);
  if (a === null || b === null || a === b) return null;
  const minutes = (b - a + 1440) % 1440;
  return { value: formatDuration(minutes), label: span.label, range: `${span.from.trim()} to ${span.to.trim()}` };
}
