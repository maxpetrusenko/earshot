import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flowToMermaid, parseFlowSpec, renderFlow } from "../src/sketch.js";
import { JsonFieldStream } from "../src/stream-json.js";

const GOOD = {
  nodes: [
    { id: "a", label: "Webhook" },
    { id: "b", label: "Charge service" },
    { id: "c", label: "Idempotency guard" },
    { id: "d", label: "Ledger" },
  ],
  edges: [["a", "b"], ["b", "c"], ["c", "d"]],
  broken: "b",
  fixed: "c",
};

describe("parseFlowSpec", () => {
  it("accepts a multi-part flow and keeps broken and fixed", () => {
    expect(parseFlowSpec(GOOD)).toMatchObject({ broken: "b", fixed: "c" });
    expect(parseFlowSpec(JSON.stringify(GOOD))?.nodes).toHaveLength(4);
  });
  it("none, junk, too few or too many nodes and edgeless graphs are no picture", () => {
    expect(parseFlowSpec("none")).toBeNull();
    expect(parseFlowSpec(undefined)).toBeNull();
    expect(parseFlowSpec("{nope")).toBeNull();
    expect(parseFlowSpec({ ...GOOD, nodes: GOOD.nodes.slice(0, 2) })).toBeNull();
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Part ${i}` }));
    expect(parseFlowSpec({ nodes: many, edges: many.slice(1).map((n, i) => [`n${i}`, n.id]) })).toBeNull();
    expect(parseFlowSpec({ ...GOOD, edges: [] })).toBeNull();
  });
  it("drops unknown marks and cleans labels to plain words", () => {
    const f = parseFlowSpec({ ...GOOD, broken: "zzz", fixed: "b", nodes: [{ id: "a", label: 'Web"hook]; <b>' }, ...GOOD.nodes.slice(1)] })!;
    expect(f.broken).toBeUndefined();
    expect(f.nodes[0]!.label).toBe("Web hook b");
  });
});

describe("flowToMermaid and renderFlow", () => {
  it("marks the broken and fixed nodes with a word and renders them red and green", async () => {
    const spec = parseFlowSpec(GOOD)!;
    expect(flowToMermaid(spec).mermaid).toContain("B[Charge service broke]");
    expect(flowToMermaid(spec).mermaid).toContain("C[Idempotency guard fixed]");
    const { svg } = await renderFlow(spec);
    expect(svg).toContain('class="node broke"');
    expect(svg).toContain('class="node fixed"');
    expect(svg).toContain("#B42318");
    expect(svg).toContain("#1F6F5C");
    expect(svg).not.toMatch(/<script|onclick|@import/i);
  });
  it("renders an unmarked flow with no red", async () => {
    const { svg } = await renderFlow(parseFlowSpec({ ...GOOD, broken: undefined, fixed: undefined })!);
    expect(svg).not.toContain("#B42318");
  });
});

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
