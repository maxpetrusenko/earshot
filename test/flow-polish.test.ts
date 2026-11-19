import { describe, expect, it } from "vitest";
import { CARDS_CSS } from "../src/explain-cards-css.js";
import { explainGate } from "../src/explain-gate.js";
import { stepIcon } from "../src/explain-flow-render.js";
import { stepNameProblem } from "../src/explain-flow.js";
import { renderExplainHtml } from "../src/explain-render.js";
import { parseExplain, type ExplainSpec } from "../src/explain-schema.js";
import { clockMinutes, durationStat, formatDuration, inferFooterTone } from "../src/explain-stat.js";
import { DIRECTOR } from "./explain-fixtures.js";

const REPLY = 'Since 07:00 every run failed with "no JS-capable Chrome window". Each run logged ok every minute. The alert fired once at 22:30. Fix: turn on Allow JavaScript from Apple Events.';
type Step = Record<string, unknown>;
const steps = (): Step[] => [
  { name: "Apple Events JS off", detail: "Chrome Profile 1", icon: "lock", state: "cause", note: "no script can read the page", fix: "Enable Allow JavaScript from Apple Events" },
  { name: "Studio read fails", detail: "no JS-capable window", icon: "file" },
  { name: "Empty list logged as ok", detail: "empty claimable list", icon: "check", state: "masked", note: "a failed read looks like no tickets", link: "every minute" },
  { name: "Blind alert fires", detail: "once", icon: "send" },
];
const bug = (over: Record<string, unknown> = {}, st: Step[] = steps()): ExplainSpec =>
  parseExplain({ director: DIRECTOR, eyebrow: "WATCHER / FAILURE CHAIN", title: "A failed read looks like no tickets.", takeaway: "The watcher was blind.", type: "flow", footer: "Tickets since 07:00 could have been missed.", footer_tone: "risk", span: { from: "07:00", to: "22:30", label: "blind" }, panels: [{ steps: st }], ...over })!;
const gate = (s: ExplainSpec, situation?: string): string | null => explainGate(s, undefined, REPLY, situation);
const withStat = (s: ExplainSpec): ExplainSpec => ({ ...s, stat: durationStat(s.span, REPLY) });

describe("cause, symptom, changed, fixed", () => {
  it("accepts a bug flow with a cause, a masked step and the fix on the cause", () => {
    expect(gate(bug())).toBeNull();
  });
  it("maps the older words to the new states", () => {
    const s = bug({}, [{ ...steps()[0]!, state: "broken" }, steps()[1]!, { ...steps()[2]!, state: "symptom" }, steps()[3]!]);
    const lane = (s.panels[0] as { lanes: { steps: { state: string }[] }[] }).lanes[0]!;
    expect(lane.steps.map((x) => x.state)).toEqual(["cause", "ok", "masked", "ok"]);
  });
  it("draws ROOT CAUSE red, LOOKS FINE amber, the fix as a green strip", () => {
    const html = renderExplainHtml(withStat(bug()));
    expect(html).toMatch(/fc s-cause[\s\S]*ROOT CAUSE[\s\S]*Apple Events JS off/);
    expect(html).toMatch(/fc s-masked[\s\S]*LOOKS FINE/);
    expect(html).toMatch(/class="fs-fix"><b>FIX<\/b><span>Enable Allow JavaScript from Apple Events/);
    expect(html).not.toContain("BROKEN");
  });
  it("draws changed and fixed states", () => {
    const s = bug({}, [steps()[0]!, { ...steps()[1]!, state: "changed", note: "now retried" }, steps()[2]!, { ...steps()[3]!, state: "fixed", note: "reads work" }]);
    const html = renderExplainHtml(s);
    expect(html).toContain("fc s-changed");
    expect(html).toMatch(/fc s-fixed[\s\S]*FIXED/);
  });
  it("rejects a bug flow without the root cause, with two, or without a fix", () => {
    const none: Step[] = steps().map((x) => ({ ...x, state: x.state === "cause" ? "changed" : x.state }));
    expect(gate(bug({}, none))).toMatch(/mark the root cause/);
    const two = steps();
    two[1]!.state = "cause";
    two[1]!.note = "x";
    expect(gate(bug({}, two))).toMatch(/one root cause/);
    const nofix = steps();
    delete nofix[0]!.fix;
    expect(gate(bug({}, nofix))).toMatch(/must show the fix/);
  });
  it("a closing fixed step counts as the fix", () => {
    const st = steps();
    delete st[0]!.fix;
    st[3] = { name: "Reads succeed", detail: "ticket list is real", icon: "check", state: "fixed" };
    expect(gate(bug({}, st))).toBeNull();
  });
  it("a bug situation requires the cause even when nothing is masked", () => {
    const st: Step[] = steps().map((x) => ({ ...x, state: x.state === "ok" ? "ok" : "changed" }));
    delete st[0]!.fix;
    expect(gate(bug({}, st), "bug")).toMatch(/mark the root cause/);
  });
});

describe("icons follow the state", () => {
  it("rejects a success icon on the cause and a warning icon anywhere else", () => {
    const a = steps();
    a[0]!.icon = "check";
    expect(gate(bug({}, a))).toMatch(/success icon/);
    const b = steps();
    b[1]!.icon = "alert";
    expect(gate(bug({}, b))).toMatch(/alert icon but is not the root cause/);
  });
  it("the renderer never contradicts the state either", () => {
    expect(stepIcon({ icon: "check", state: "cause" })).toBe("alert");
    expect(stepIcon({ icon: "alert", state: "ok" })).not.toBe("alert");
    expect(stepIcon({ icon: "alert", state: "changed" })).not.toBe("alert");
    expect(stepIcon({ icon: "lock", state: "cause" })).toBe("lock");
    expect(stepIcon({ icon: "", state: "fixed" })).toBe("check");
  });
});

describe("step names", () => {
  it("rejects nonsense, repeats and sentences, keeps short phrases", () => {
    expect(stepNameProblem("Run logs run ok")).toMatch(/repeats/);
    expect(stepNameProblem("The alert fires.")).toMatch(/sentence/);
    expect(stepNameProblem("Reads Studio and then")).toMatch(/filler/);
    expect(stepNameProblem("Reads the Studio queue every minute")).toMatch(/words/);
    for (const ok of ["Empty list logged as ok", "Read Studio, Slack, Gmail", "Apple Events JS off", "Handle 429", "Check attempts"]) expect(stepNameProblem(ok), ok).toBeNull();
  });
  it("the gate asks the model to rewrite", () => {
    const st = steps();
    st[2]!.name = "Run logs run ok";
    expect(gate(bug({}, st))).toMatch(/short noun phrase or verb phrase/);
  });
});

describe("arrow label", () => {
  it("draws a label the reply gives and rejects an invented one", () => {
    expect(renderExplainHtml(bug())).toContain('<span class="cn-l">every minute</span>');
    const st = steps();
    st[2]!.link = "every 5 min";
    expect(gate(bug({}, st))).toMatch(/not in the reply/);
  });
  it("draws no label when there is none", () => {
    const st = steps().map((x) => ({ ...x, link: undefined }));
    expect(renderExplainHtml(bug({}, st)).split("</style>")[1]).not.toContain("cn-l");
  });
});

describe("footer tone", () => {
  it("colors the dot by tone", () => {
    expect(renderExplainHtml(bug())).toContain('class="ft ft-risk"');
    expect(renderExplainHtml(bug({ footer: "Verified with a test.", footer_tone: "good" }))).toContain("ft-good");
    expect(renderExplainHtml(bug({ footer: "Scope: one host.", footer_tone: "neutral" }))).toContain("ft-neutral");
    expect(CARDS_CSS).toMatch(/\.ft-neutral i\{background:#6b766f\}/);
  });
  it("rejects a good tone on a risk footer and infers a tone when none is given", () => {
    expect(gate(bug({ footer_tone: "good" }))).toMatch(/footer_tone/);
    const s = bug({ footer_tone: undefined });
    expect(s.footerTone).toBe("risk");
    expect(inferFooterTone("Verified on pro.")).toBe("good");
    expect(inferFooterTone("Scope: one host.")).toBe("neutral");
  });
});

describe("duration stat", () => {
  it("computes the span from the reply's two times, in code", () => {
    expect(durationStat({ from: "07:00", to: "22:30", label: "blind" }, REPLY)).toEqual({ value: "15.5 h", label: "blind", range: "07:00 to 22:30" });
  });
  it("wraps past midnight and formats short spans", () => {
    expect(clockMinutes("7 pm")).toBe(19 * 60);
    expect(clockMinutes("25:00")).toBeNull();
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(80)).toBe("1 h 20 min");
    expect(formatDuration(180)).toBe("3 h");
    expect(durationStat({ from: "22:00", to: "01:00", label: "" }, "from 22:00 to 01:00")?.value).toBe("3 h");
  });
  it("drops a span the reply does not contain", () => {
    expect(durationStat({ from: "07:00", to: "21:00", label: "blind" }, REPLY)).toBeNull();
    expect(durationStat(null, REPLY)).toBeNull();
  });
  it("draws once, under the subhead", () => {
    const html = renderExplainHtml(withStat(bug()));
    expect(html.match(/15\.5 h/g)).toHaveLength(1);
    expect(html).toMatch(/class="sb"[\s\S]*class="stat"[\s\S]*class="cd flw"/);
    expect(renderExplainHtml(bug())).not.toContain('class="stat"');
  });
});

describe("typography and layout", () => {
  it("balances the headline, prettifies body text, drops the display weight", () => {
    expect(CARDS_CSS).toMatch(/h1\{[^}]*font-weight:700[^}]*text-wrap:balance/);
    expect(CARDS_CSS).toMatch(/\.sb\{text-wrap:balance/);
    expect(renderExplainHtml(bug())).toMatch(/\.fs-dt\{[^}]*text-wrap:pretty/);
  });
  it("one page background, so no band shows below the content", () => {
    expect(CARDS_CSS).toMatch(/body\{[^}]*background:none/);
  });
  it("centers the arrow on the icon column", () => {
    const css = renderExplainHtml(bug());
    expect(css).toMatch(/\.cn-a\{[^}]*width:var\(--tl\)/);
    expect(css).toMatch(/\.fl\.one \.cn\{[^}]*padding-left:calc\(var\(--pd\) \+ var\(--bd\)\)/);
  });
});
