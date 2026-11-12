import { describe, expect, it } from "vitest";
import { buildExplain, loadExplainPrompt } from "../src/explain.js";
import { explainGate } from "../src/explain-gate.js";
import { renderExplainHtml } from "../src/explain-render.js";
import { cleanText, ExplainError, parseExplain, type ExplainSpec } from "../src/explain-schema.js";
import type { LlmProvider } from "../src/llm.js";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";

const INJECT = `<script>alert(1)</script> "q" 'a' & <img onerror=x>`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const spec = (o: unknown = EXPLAIN_SPEC): ExplainSpec => parseExplain(o)!;

const TIMELINE = {
  type: "timeline",
  title: "Original audio starts sooner",
  takeaway: "You hear the original right away instead of after the edited memo.",
  panels: [
    { label: "Before: one after the other", caption: "You waited 6.7 s before the original made a sound.", unit: "s", lanes: [{ label: "Edited", segments: [{ label: "speech", start: 0, duration: 5 }] }, { label: "Original", marker: 6.7, marker_label: "you hear it at 6.7 s", segments: [{ label: "waits", start: 0, duration: 5, state: "muted" }, { label: "speech", start: 5, duration: 6.7 }] }] },
    { label: "After: in parallel", caption: "Both tracks start together, so you press play almost immediately.", unit: "s", lanes: [{ label: "Edited", segments: [{ label: "speech", start: 0, duration: 5 }] }, { label: "Original", marker: 0.6, marker_label: "you hear it at 0.6 s", segments: [{ label: "speech", start: 0, duration: 6.7, state: "good" }] }] },
  ],
};
const SEQUENCE = {
  type: "sequence",
  title: "Hook to player",
  takeaway: "A reply becomes a played memo.",
  panels: [{ label: "Reply to audio", caption: "Your reply turns into a clip you can play without leaving the chat.", actors: ["Agent", "Hook", "Kokoro"], messages: [{ from: "Agent", to: "Hook", text: "final reply" }, { from: "Hook", to: "Kokoro", text: "script chunks" }, { from: "Kokoro", to: "Hook", text: "mp3", dashed: true }] }],
};
const ARCH = {
  type: "architecture",
  title: "Two paths now",
  takeaway: "Audio and picture are made side by side.",
  panels: [{ label: "After", caption: "The picture and the audio are made side by side, so neither waits.", components: [{ id: "a", label: "Reply" }, { id: "b", label: "Script" }, { id: "c", label: "Explain" }, { id: "d", label: "Orca chat", state: "good" }], edges: [{ from: "a", to: "b", label: "text" }, { from: "a", to: "c", label: "text" }, { from: "b", to: "d", label: "mp3" }, { from: "c", to: "d", label: "html" }] }],
};
const JOURNEY = {
  type: "journey",
  title: "Reply to sound in one tap",
  takeaway: "You can listen without waiting for the whole memo.",
  panels: [
    {
      label: "After: the reply comes with audio",
      caption: "You press play two steps after the agent finishes.",
      steps: [
        { label: "Agent replies", el: { kind: "bubble", text: "Done, 212 tests pass", value: -1 } },
        { label: "Audio ready", el: { kind: "bar", text: "Listen 0:34", value: 0 } },
        { label: "Press Play", state: "good", el: { kind: "wave", text: "0:07 / 0:34", value: 20 } },
        { label: "Image, big tasks only", optional: true, el: { kind: "button", text: "What changed", value: -1 } },
      ],
    },
  ],
};
const ALL = { ui: EXPLAIN_SPEC, timeline: TIMELINE, sequence: SEQUENCE, architecture: ARCH, journey: JOURNEY };

describe("parseExplain", () => {
  it("no_image and the text NO_IMAGE give no spec", () => {
    expect(parseExplain({ no_image: true })).toBeNull();
    expect(parseExplain("NO_IMAGE")).toBeNull();
  });
  it("rejects an unknown type or empty panels", () => {
    expect(() => parseExplain({ title: "x", type: "flowchart", panels: [{}] })).toThrow(ExplainError);
    expect(() => parseExplain({ title: "x", type: "timeline", panels: [] })).toThrow(ExplainError);
  });
  it("drops unknown fields, caps strings and counts, and strips emoji and long dashes", () => {
    const o = clone(EXPLAIN_SPEC) as Record<string, unknown>;
    (o as { evil: string }).evil = "x";
    const p = (o.panels as Record<string, unknown>[])[0]!;
    p.onclick = "bad()";
    (p.elements as unknown[]).length = 0;
    for (let i = 0; i < 20; i++) (p.elements as unknown[]).push({ kind: "row", text: `Row ${"x".repeat(200)} \u{1F600} a—b`, hacker: 1 });
    const s = spec(o);
    expect(s).not.toHaveProperty("evil");
    expect(s.panels[0]).not.toHaveProperty("onclick");
    const ui = s.panels[0]!;
    if (ui.kind !== "ui") throw new Error("kind");
    expect(ui.elements).toHaveLength(8);
    expect(ui.elements[0]!.text.length).toBeLessThanOrEqual(60);
    expect(ui.elements[0]).not.toHaveProperty("hacker");
    expect(cleanText("a—b \u{1F680}ok\n\tz", 40)).toBe("a, b ok z");
  });
  it("keeps up to three callouts and three metrics, and maps actors and components by name", () => {
    const o = { ...clone(EXPLAIN_SPEC), callouts: ["a", "b", "c", "d"], metrics: [1, 2, 3, 4].map((n) => ({ label: `m${n}`, after: `${n}` })) };
    expect(spec(o).callouts).toHaveLength(3);
    expect(spec(o).metrics).toHaveLength(3);
    expect(spec(o).metrics[0]!.verified).toBe(false);
    const seq = spec(SEQUENCE).panels[0]!;
    if (seq.kind !== "sequence") throw new Error("kind");
    expect(seq.messages.map((m) => [m.from, m.to])).toEqual([[0, 1], [1, 2], [2, 1]]);
  });
});

describe("explainGate", () => {
  it("passes real content of every type", () => {
    for (const o of Object.values(ALL)) expect(explainGate(spec(o))).toBeNull();
  });
  it("rejects bare label boxes", () => {
    const o = clone(EXPLAIN_SPEC);
    o.panels[1]!.elements = [{ kind: "text", text: "Done" } as never, { kind: "text", text: "Tests" } as never];
    expect(explainGate(spec(o))).toMatch(/only text labels/);
    const one = clone(EXPLAIN_SPEC);
    one.panels.pop();
    expect(explainGate(spec(one))).toMatch(/two panels/);
    const arch = clone(ARCH);
    arch.panels[0]!.edges = [];
    expect(explainGate(spec(arch))).toMatch(/three components/);
  });
  it("rejects Fixed, Implemented, Completed and Merged as a whole label, any case", () => {
    for (const word of ["Fixed", "implemented", "COMPLETED", "Merged"]) {
      const o = clone(EXPLAIN_SPEC);
      o.panels[1]!.elements[2] = { kind: "button", text: word } as never;
      expect(explainGate(spec(o)), word).toMatch(/bare status label/);
    }
    const ok = clone(EXPLAIN_SPEC);
    ok.panels[1]!.elements[2] = { kind: "button", text: "Fixed in five tries" } as never;
    expect(explainGate(spec(ok))).toBeNull();
  });
});

describe("renderExplainHtml", () => {
  it.each(Object.keys(ALL))("renders %s with escaped values and a clean page", (name) => {
    const o = clone(ALL[name as keyof typeof ALL]) as Record<string, unknown>;
    o.title = INJECT;
    o.takeaway = INJECT;
    o.callouts = [INJECT];
    o.metrics = [{ label: INJECT, before: INJECT, after: INJECT, verified: true }];
    const panels = o.panels as Record<string, unknown>[];
    for (const p of panels) {
      p.label = INJECT;
      for (const k of ["title", "input", "transform", "output"]) if (k in p) p[k] = INJECT;
      for (const e of (p.elements ?? []) as Record<string, unknown>[]) e.text = INJECT;
      for (const l of (p.lanes ?? []) as { label: string; segments: { label: string }[] }[]) {
        l.label = INJECT;
        for (const s of l.segments) s.label = INJECT;
      }
      for (const m of (p.messages ?? []) as { text: string }[]) m.text = INJECT;
      for (const c of (p.components ?? []) as { label: string }[]) c.label = INJECT;
      for (const ed of (p.edges ?? []) as { label: string }[]) ed.label = INJECT;
      if (Array.isArray(p.actors)) p.actors = p.actors.map((a) => `${a}`); // actor names key the messages
    }
    const html = renderExplainHtml(spec(o));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/onerror=x>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;q&quot;");
    expect(html).not.toMatch(/<[^>]+\son\w+=/i);
  });
  it("is light, tokened and display-only", () => {
    for (const o of Object.values(ALL)) {
      const html = renderExplainHtml(spec(o));
      expect(html).not.toContain(":root");
      expect(html).not.toMatch(/(^|[;{\s])--[a-z-]+\s*:/m);
      for (const v of html.match(/var\(--[a-z-]+[^)]*\)/g) ?? []) expect(v).toMatch(/,/);
      expect(html).not.toContain("html.ios");
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(html).not.toMatch(/prefers-color-scheme|dark/i);
      expect(html).not.toMatch(/fetch\(|https?:\/\/(?!www\.w3\.org)/);
      expect(html).not.toMatch(/font-family:[^;}]*\b(?:Inter|Roboto|Arial)\b/);
      for (const m of html.matchAll(/background:\s*#([0-9a-f]{6})\b/gi)) {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
        expect(0.299 * r! + 0.587 * g! + 0.114 * b!).toBeGreaterThan(150);
      }
    }
  });
  it("shows a verified metric as measured and an unverified one as target", () => {
    const o = clone(EXPLAIN_SPEC);
    o.metrics = [{ label: "Measured", before: "6.7 s", after: "0.6 s", verified: true, source: "measured on pro, 1.5 KB reply" }, { label: "Goal", before: "", after: "1 s", verified: false } as never];
    const html = renderExplainHtml(spec(o));
    expect(html).toContain("0.6 s");
    expect(html.match(/class="tg">target</g)).toHaveLength(1);
    expect(html).toContain("measured, measured on pro, 1.5 KB reply");
    expect(html.indexOf("Goal")).toBeLessThan(html.indexOf("target"));
  });
  it("stacks the panels on a narrow screen and splits them on a wide one", () => {
    const html = renderExplainHtml(spec());
    expect(html).toContain("@media(min-width:760px)");
    expect(html).toContain('class="ps two"');
  });
});

/** A provider that answers each call from a queue of raw strings (objects are JSON-encoded). */
function fake(...answers: unknown[]): LlmProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    model: "fake",
    calls,
    async complete(req) {
      calls.push(req.user);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof a === "string" ? a : JSON.stringify(a);
    },
  };
}

describe("buildExplain", () => {
  const bare = { ...clone(EXPLAIN_SPEC), panels: clone(EXPLAIN_SPEC).panels.map((p) => ({ ...p, elements: [{ kind: "text", text: "Fixed" }, { kind: "text", text: "Tests" }] })) };
  it("uses the verbatim designer prompt plus the format appendix", () => {
    const sys = loadExplainPrompt();
    expect(sys.startsWith("You design small visual explanations")).toBe(true);
    expect(sys).toContain("A picture earns its place only when it shows something that text states poorly");
    expect(sys).toContain('"visuals"');
    expect(sys).toContain("OUTPUT FORMAT");
  });
  it("renders a good answer in one call", async () => {
    const llm = fake(EXPLAIN_SPEC);
    const r = await buildExplain(llm, "reply text");
    expect(r.html).toContain("Retries now stop at five");
    expect(r.retries).toBe(0);
    expect(llm.calls[0]).toContain("<<<REPLY\nreply text\nREPLY>>>");
  });
  it("emits nothing for no_image and for the text NO_IMAGE", async () => {
    expect((await buildExplain(fake({ no_image: true }), "x")).html).toBeNull();
    const llm = fake("NO_IMAGE");
    expect((await buildExplain(llm, "x")).html).toBeNull();
    expect(llm.calls).toHaveLength(1);
  });
  it("retries once with the gate feedback, then renders", async () => {
    const llm = fake(bare, EXPLAIN_SPEC);
    const r = await buildExplain(llm, "x");
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toMatch(/previous answer was rejected: panel 1 is only text labels/);
    expect(r.html).not.toBeNull();
    expect(r.retries).toBe(1);
  });
  it("a second failure is NO_IMAGE, not an error", async () => {
    const llm = fake(bare, "not json at all");
    const r = await buildExplain(llm, "x");
    expect(llm.calls).toHaveLength(2);
    expect(r.html).toBeNull();
    expect(r.reason).toMatch(/^gate:/);
  });
  it("lets a provider error through so the pipeline can record it", async () => {
    const llm: LlmProvider = { name: "x", model: "x", complete: async () => Promise.reject(new Error("boom")) };
    await expect(buildExplain(llm, "x")).rejects.toThrow("boom");
  });
});
