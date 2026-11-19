import { describe, expect, it } from "vitest";
import { flowProblem } from "../src/explain-flow.js";
import { renderExplainHtml, visibleElements } from "../src/explain-render.js";
import { parseExplain, type UiEl } from "../src/explain-schema.js";

const director = { intent: "a", key_frame: "b", first_look: "c", two_second_test: "d", motion: "no" };
const flow = (panel: Record<string, unknown>) =>
  parseExplain({ director, eyebrow: "SYNC / LOGIC", title: "A 429 now retries.", takeaway: "One step changed.", type: "flow", panels: [panel] })!;

const same = (name: string) => ({ name, detail: "same", icon: "file" });

describe("two-lane flows collapse unchanged steps", () => {
  const spec = flow({
    before: [same("Receive job"), same("Call billing API"), { name: "Handle 429", icon: "alert", state: "broken", note: "marks job failed" }, same("Write result")],
    after: [same("Receive job"), same("Call billing API"), { name: "Handle 429", icon: "retry", state: "changed", note: "retries five times" }, same("Write result")],
  });
  const html = renderExplainHtml(spec);
  it("draws one compact row per run and only the changed row side by side", () => {
    expect(html).toContain("2 unchanged steps");
    expect(html).toContain("1 unchanged step<");
    expect((html.match(/class="fc /g) ?? []).length).toBe(2);
    expect(html).toContain("BROKEN");
  });
  it("does not need an icon on a collapsed step", () => {
    const bare = flow({
      before: [{ name: "Receive job" }, { name: "Call billing API" }, { name: "Handle 429", icon: "alert", state: "broken", note: "x" }],
      after: [{ name: "Receive job" }, { name: "Call billing API" }, { name: "Handle 429", icon: "retry", state: "changed", note: "y" }],
    });
    expect(flowProblem(bare.panels[0] as never)).toBeNull();
  });
  it("labels a changed BEFORE step as replaced", () => {
    const s = flow({
      before: [same("Open More menu"), { name: "Pick Export", icon: "file", state: "changed", note: "hidden" }, same("Choose format")],
      after: [same("Open More menu"), { name: "Click Export", icon: "send", state: "changed", note: "visible" }, same("Choose format")],
    });
    expect(renderExplainHtml(s)).toContain("REPLACED");
  });
});

describe("a one-lane bug flow shows the fix on the broken step", () => {
  it("draws the fix inside the broken card", () => {
    const s = flow({ steps: [same("Send webhook"), { name: "Rebuild request", icon: "retry", state: "broken", note: "counter reset", fix: "counter moved to the job record" }, same("Check attempts")] });
    expect(renderExplainHtml(s)).toMatch(/s-broken[\s\S]*fs-fix[\s\S]*counter moved to the job record/);
  });
  it("accepts an 80 character note", () => {
    const note = "n".repeat(80);
    const s = flow({ steps: [same("Send webhook"), { name: "Rebuild request", icon: "retry", state: "broken", note }, same("Check attempts")] });
    expect(flowProblem(s.panels[0] as never)).toBeNull();
  });
});

describe("mockup height is capped", () => {
  const els = (n: number, hl: number[] = []): UiEl[] => Array.from({ length: n }, (_, i) => ({ kind: "row", text: `c${i}`, state: "normal", side: "left", value: -1, hl: hl.includes(i), note: "" }));
  it("keeps outlined rows and folds the rest", () => {
    const { shown, hidden } = visibleElements(els(7, [4, 6]));
    expect(shown.map((x) => x.text)).toEqual(["c0", "c1", "c4", "c6"]);
    expect(hidden).toBe(3);
  });
  it("leaves a short panel alone", () => {
    expect(visibleElements(els(4)).hidden).toBe(0);
  });
});

describe("a long flow note is cut at a word on the last attempt, not dropped", () => {
  it("shortenFlowText brings an 84 character note under the limit", async () => {
    const { shortenFlowText } = await import("../src/explain-flow.js");
    const s = flow({ steps: [same("Read export"), { name: "Change POST", icon: "code", state: "changed", note: "Two internal scripts expect the file, so keep a flag for them in the first release" }, same("Notify owner")] });
    expect(flowProblem(s.panels[0] as never)).toMatch(/at most 80/);
    shortenFlowText(s);
    expect(flowProblem(s.panels[0] as never)).toBeNull();
  });
});
