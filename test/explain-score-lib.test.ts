import { describe, expect, it } from "vitest";
import { strictJson, validRubric } from "../scripts/explain-score-lib.js";

const good = { realism: 8, legibility: 8, density: 7, journey: 8, metrics: 9, how: 8, clarity: 8, style: 7, overall: 8, notes: "ok" };

describe("explain-score strict JSON", () => {
  it("takes one object, with or without a code fence", () => {
    expect(strictJson(JSON.stringify(good))).toEqual(good);
    expect(strictJson("```json\n" + JSON.stringify(good) + "\n```")).toEqual(good);
  });
  it("rejects prose around the object, two objects, arrays and truncated output", () => {
    expect(strictJson("Here you go: " + JSON.stringify(good))).toBeNull();
    expect(strictJson(JSON.stringify(good) + " " + JSON.stringify(good))).toBeNull();
    expect(strictJson("[1]")).toBeNull();
    expect(strictJson('{"overall": 8, "notes": "cut')).toBeNull();
    expect(strictJson("")).toBeNull();
  });
  it("a rubric needs every area as an integer 1 to 10; zeros and strings are not scores", () => {
    expect(validRubric(good)).toBe(true);
    expect(validRubric({ ...good, overall: 0 })).toBe(false);
    expect(validRubric({ ...good, style: "8" })).toBe(false);
    expect(validRubric({ ...good, how: 11 })).toBe(false);
    expect(validRubric({ ...good, clarity: 7.5 })).toBe(false);
    const missing: Record<string, unknown> = { ...good };
    delete missing.metrics;
    expect(validRubric(missing)).toBe(false);
  });
});
