/** Small value cleaners shared by the explain schema parsers. */

const C = (...codes: number[]): string => String.fromCharCode(...codes);
const EMOJI = new RegExp(`[\\p{Extended_Pictographic}${C(0x200d, 0xfe0f)}]`, "gu");
const LONG_DASH = new RegExp(`[${C(0x2013, 0x2014)}]`, "g");
const CONTROLS = new RegExp(`[${C(0)}-${C(0x1f)}${C(0x7f)}${C(0x2028, 0x2029)}]+`, "g");
/** The en dash, the one dash allowed, for number ranges. */
export const EN_DASH = C(0x2013);

/** Plain, single-line, length-capped text. Controls, emoji and long dashes are removed. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v)
    .replace(EMOJI, "")
    .replace(LONG_DASH, ", ")
    .replace(CONTROLS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
export const oneOf = <T extends string>(v: unknown, set: readonly T[], dflt: T): T => (typeof v === "string" && (set as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : dflt);

/** Like cleanText, but a number range ("7 to 11", "7-11") keeps its en dash: "7-11 s" with the en dash. */
export function rangeText(v: unknown, max: number): string {
  const raw = typeof v === "string" || typeof v === "number" ? String(v).replace(new RegExp(`(\\d)\\s*(?:to|[${C(0x2013, 0x2014)}-])\\s*(\\d)`, "g"), "$1 to $2") : "";
  return cleanText(raw, max).replace(/(\d)\s+to\s+(\d)/g, `$1${EN_DASH}$2`);
}

/**
 * Pad every decimal number in a log line to the longest decimal count on that line, so a threshold never reads
 * coarser than the value it is compared with ("0.549 needs 0.55" becomes "0.549 needs 0.550"). Needs two or more decimals.
 */
export function padDecimals(line: string): string {
  const nums = line.match(/\d+\.\d+/g) ?? [];
  if (nums.length < 2) return line;
  const places = Math.max(...nums.map((n) => n.split(".")[1]!.length));
  return line.replace(/\d+\.\d+/g, (n) => n + "0".repeat(places - n.split(".")[1]!.length));
}
