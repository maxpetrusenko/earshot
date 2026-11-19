import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainGate } from "../src/explain-gate.js";
import { renderExplainHtml } from "../src/explain-render.js";
import { parseExplain, parseExplainAll, type ExplainSpec } from "../src/explain-schema.js";

const load = (n: string): Record<string, unknown> => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/specs", `${n}.json`), "utf8")) as Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const spec = (o: unknown): ExplainSpec => parseExplain(o)!;
type Steps = { name: string; state?: string; note?: string; icon?: string }[];
const lanes = (o: Record<string, unknown>) => (o.panels as { steps?: Steps; before?: Steps; after?: Steps }[])[0]!;

describe("flow type", () => {
  it("the flow and bug fixtures pass the gate and render", () => {
    for (const n of ["flow", "bug"]) {
      const s = spec(load(n));
      expect(explainGate(s), n).toBeNull();
      const html = renderExplainHtml(s);
      expect(html).toContain('class="fl ');
      expect(html).toContain("<svg");
    }
  });
  it("bug: the broken step is red with its cause; flow: both lanes mark the changed step", () => {
    const bug = renderExplainHtml(spec(load("bug")));
    expect(bug).toContain("fc s-cause");
    expect(bug).toContain("counter resets to zero on every rebuild");
    const flow = renderExplainHtml(spec(load("flow")));
    expect(flow.match(/fc s-changed/g)).toHaveLength(2);
    expect(flow).toContain("BEFORE");
    expect(flow).toContain("AFTER");
  });
  it("rejects a flow with no marked step", () => {
    const o = clone(load("bug"));
    for (const s of lanes(o).steps!) delete s.state;
    expect(explainGate(spec(o))).toMatch(/changed step or the root cause marked/);
  });
  it("rejects generic labels, a missing icon, a root cause with no note, and the wrong step count", () => {
    const g = clone(load("bug"));
    lanes(g).steps![0]!.name = "Step 1";
    expect(explainGate(spec(g))).toMatch(/not a real step name/);
    const i = clone(load("bug"));
    delete lanes(i).steps![0]!.icon;
    expect(explainGate(spec(i))).toMatch(/needs an icon/);
    const c = clone(load("bug"));
    delete lanes(c).steps![2]!.note;
    expect(explainGate(spec(c))).toMatch(/needs a note with the cause/);
    const few = clone(load("bug"));
    lanes(few).steps = lanes(few).steps!.slice(0, 2);
    expect(explainGate(spec(few))).toMatch(/3 to 7 steps/);
    const many = clone(load("bug"));
    lanes(many).steps = [...lanes(many).steps!, ...lanes(many).steps!];
    expect(parseExplain(many)!.panels[0]).toMatchObject({ kind: "flow" });
    expect(explainGate(spec(many))).toMatch(/3 to 7 steps/);
  });
  it("two lanes share positions: equal length, a mark in each, not identical", () => {
    const o = clone(load("flow"));
    lanes(o).after = lanes(o).after!.slice(0, 4);
    expect(explainGate(spec(o))).toMatch(/same number of steps/);
    const n = clone(load("flow"));
    for (const s of lanes(n).after!) delete s.state;
    expect(explainGate(spec(n))).toMatch(/both lanes/);
    const same = clone(load("flow"));
    lanes(same).after = clone(lanes(same).before!);
    expect(explainGate(spec(same))).toMatch(/identical/);
  });
  it("needs the director pass like every visual", () => {
    const o = clone(load("flow"));
    delete o.director;
    expect(explainGate(spec(o))).toMatch(/director/);
  });
  it("ranked and grid pass their gates and reject the obvious misses", () => {
    const director = (load("flow") as { director: unknown }).director;
    const ranked = { director, eyebrow: "REPORTS / OPTIONS", title: "Redis wins the cache choice.", takeaway: "Three options ranked.", type: "ranked", panels: [{ items: [{ name: "Redis with a TTL", detail: "already running, one delete", recommended: true }, { name: "In-process cache", detail: "each worker keeps a copy" }, { name: "Materialized view", detail: "up to an hour stale" }] }] };
    expect(explainGate(spec(ranked))).toBeNull();
    expect(renderExplainHtml(spec(ranked))).toContain("RECOMMENDED");
    const second = clone(ranked);
    second.panels[0]!.items.reverse();
    expect(explainGate(spec(second))).toMatch(/first/);
    const grid = { director, eyebrow: "FLEET / STATUS", title: "Only maxiclaw is busy.", takeaway: "Four hosts, one busy.", type: "grid", panels: [{ cells: [{ name: "pro", icon: "desktop", state: "ok", line: "idle" }, { name: "maxiclaw", icon: "server", state: "warn", line: "CI sender mid-run" }] }] };
    expect(explainGate(spec(grid))).toBeNull();
    expect(renderExplainHtml(spec(grid))).toContain("g-warn");
    const bare = clone(grid);
    delete (bare.panels[0]!.cells[0] as { icon?: string }).icon;
    expect(explainGate(spec(bare))).toMatch(/needs an icon/);
  });
  it("a flow can come in a visuals list with the other types", () => {
    expect(parseExplainAll({ visuals: [load("flow"), load("bug")] })).toHaveLength(2);
  });
});
