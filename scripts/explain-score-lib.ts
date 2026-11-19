/** Pure helpers of explain-score.ts, kept apart so a test can import them without running the scorer. */

/** The eight rubric areas, each scored 1 to 10, plus the overall verdict. */
export const AREAS = ["realism", "legibility", "density", "journey", "metrics", "how", "clarity", "style"] as const;

/**
 * Strict JSON: the whole answer (after an optional code fence) must be one JSON object. No first-brace to last-brace
 * guessing: prose around the object, or two objects, is a parse failure and the call is retried.
 */
export const strictJson = (raw: string): Record<string, unknown> | null => {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** A rubric score is a whole number 1 to 10. Zero is never a score: it means the judge did not grade. */
export const validScore = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10;
export const validRubric = (o: Record<string, unknown>): boolean => [...AREAS, "overall"].every((k) => validScore(o[k]));
