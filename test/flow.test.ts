import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFieldStream } from "../src/stream-json.js";

describe("JsonFieldStream other values", () => {
  const collect = (chunks: string[]) => {
    const got: Record<string, string> = {};
    const s = new JsonFieldStream({ field: (k, v) => (got[k] = v), other: (k, j) => (got[k] = j) });
    for (const c of chunks) s.push(c);
    return got;
  };
  it("reports an object value split across chunks, and keeps the string fields", () => {
    const got = collect(['{"title": "T", "script": "Hi there.", "sketch": {"nodes": [{"id": "a", "la', 'bel": "x, y"}], "edges": []}, "evidence": ""}']);
    expect(JSON.parse(got.sketch!)).toEqual({ nodes: [{ id: "a", label: "x, y" }], edges: [] });
    expect(got.evidence).toBe("");
    expect(got.title).toBe("T");
  });
  it("reports a string none and a trailing object", () => {
    expect(collect(['{"script": "A.", "sketch": "none"}']).sketch).toBe("none");
    expect(JSON.parse(collect(['{"script": "A.", "sketch": {"nodes": []}}']).sketch!)).toEqual({ nodes: [] });
  });
});

describe("sketch fixtures", () => {
  const dir = join(import.meta.dirname, "fixtures", "sketch");
  it("has a small reply (expect none) and a multi-step bugfix (expect broken and fixed)", () => {
    expect(readFileSync(join(dir, "small-status.txt"), "utf8").length).toBeLessThan(300);
    expect(readFileSync(join(dir, "multistep-bugfix.txt"), "utf8")).toMatch(/Root cause/);
  });
});
