import { describe, expect, it } from "vitest";
import { buildExplain, directorFileName, directorLines, loadExplainPrompt } from "../src/explain.js";
import { renderFallbackHtml } from "../src/explain-fallback.js";
import { directorProblem, explainGate } from "../src/explain-gate.js";
import { renderExplainHtml } from "../src/explain-render.js";
import { parseExplain, type ExplainSpec } from "../src/explain-schema.js";
import type { LlmProvider } from "../src/llm.js";
import { armOrcaDeadline, orcaLines } from "../src/orca-output.js";
import { renderPendingHtml } from "../src/orca.js";
import { DIRECTOR, EXPLAIN_SPEC } from "./explain-fixtures.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const LOG = {
  director: DIRECTOR,
  eyebrow: "Earshot / Log comparison",
  title: "The gate was right.",
  takeaway: "The log made the rejection look wrong.",
  type: "log_compare",
  panels: [{ cards: [{ tag: "BEFORE", sub: "REPORTED LOG", tone: "bad", mono: "0.55 needs 0.55" }, { tag: "AFTER", sub: "EXPECTED DISPLAY", tone: "good", mono: "0.549 needs 0.550" }] }],
};
const spec = (o: unknown): ExplainSpec => parseExplain(o)!;
const fake = (...answers: unknown[]): LlmProvider & { calls: string[] } => {
  const calls: string[] = [];
  return { name: "f", model: "f", calls, complete: async ({ user }) => (calls.push(user), JSON.stringify(answers[Math.min(calls.length - 1, answers.length - 1)])) };
};

describe("director pass", () => {
  it("passes a visual with all five lines", () => {
    expect(directorProblem(spec(LOG))).toBeNull();
    expect(explainGate(spec(LOG))).toBeNull();
  });
  it("the gate rejects a visual with no director object", () => {
    const o = clone(LOG) as Record<string, unknown>;
    delete o.director;
    expect(spec(o).director).toBeNull();
    expect(explainGate(spec(o))).toMatch(/"director" object is missing/);
  });
  it("the gate rejects an empty director object and an empty line, naming the line", () => {
    expect(explainGate(spec({ ...LOG, director: {} }))).toMatch(/"director" object is missing/);
    expect(explainGate(spec({ ...LOG, director: { ...DIRECTOR, first_look: "  " } }))).toMatch(/empty lines \(first_look\)/);
    expect(explainGate(spec({ ...LOG, director: { ...DIRECTOR, intent: "", motion: "" } }))).toMatch(/empty lines \(intent, motion\)/);
  });
  it("applies to every type, not only the card types", () => {
    const o = clone(EXPLAIN_SPEC) as Record<string, unknown>;
    expect(explainGate(spec(o))).toBeNull();
    delete o.director;
    expect(explainGate(spec(o))).toMatch(/"director" object is missing/);
  });
  it("buildExplain asks again with the director feedback and then ships", async () => {
    const noDirector = { ...clone(LOG), director: undefined };
    const llm = fake(noDirector, LOG);
    const r = await buildExplain(llm, "reply");
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toMatch(/"director" object is missing/);
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.spec.director?.intent).toBe(DIRECTOR.intent);
  });
  it("a visual that stays without a director is NO_IMAGE for the model, not a page", async () => {
    const noDirector = { ...clone(LOG), director: undefined };
    const r = await buildExplain(fake(noDirector), "reply");
    expect(r.visuals).toHaveLength(0);
    expect(r.reason).toMatch(/^gate: the "director" object is missing/);
  });
  it("is saved as five lines and never drawn on the page", () => {
    const lines = directorLines(spec(LOG).director!);
    expect(lines.map((l) => l.split(":")[0])).toEqual(["intent", "key_frame", "first_look", "two_second_test", "motion"]);
    expect(directorFileName(0)).toBe("explain.director.txt");
    expect(directorFileName(2)).toBe("explain3.director.txt");
    const html = renderExplainHtml(spec(LOG));
    expect(html).not.toContain(DIRECTOR.intent);
    expect(html).not.toContain(DIRECTOR.first_look);
  });
  it("prompt v6 asks for the five lines before the visual", () => {
    const sys = loadExplainPrompt();
    expect(sys).toContain("DIRECTOR PASS FIRST");
    expect(sys).toContain('"director"');
    for (const k of ["intent", "key_frame", "first_look", "two_second_test", "motion"]) expect(sys).toContain(k);
    expect(sys.indexOf('"director"')).toBeLessThan(sys.indexOf('"eyebrow"'));
  });
});

describe("fallback card", () => {
  const texts = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  it("is built from the reply's headings and bullets", () => {
    const html = renderFallbackHtml("# Retries now stop at five\n\nThe counter reset on every 5xx.\n\n## Changes\n- Counter keeps its value on the job record\n- **Dead letter** after five tries\n1. See [the log](http://x/y)\n\n```\n- code bullet\n```\n");
    expect(html).toContain("<h1>Retries now stop at five.</h1>");
    expect(html).toContain("<span>Counter keeps its value on the job record</span>");
    expect(html).toContain("<span>Dead letter after five tries</span>");
    expect(html).toContain("<span>See the log</span>");
    expect(html).not.toContain("code bullet");
    expect(html).toContain("WHAT CHANGED");
  });
  it("is in the house style: light, one card, no script, escaped", () => {
    const html = renderFallbackHtml("# <script>alert(1)</script> & more\n- <img src=x onerror=1> bullet");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/prefers-color-scheme|dark/);
    expect(html).toContain('class="cd wc"');
  });
  it.each([
    ["empty", ""],
    ["whitespace", "  \n\n  "],
    ["only a code fence", "```\nls\n```"],
    ["only an orca line", '::orca-visual{file="earshot-abc-player.html" title="Listen"}'],
    ["only a table", "| a | b |\n|---|---|"],
    ["one word", "ok"],
    ["plain prose", "Fixed the flaky webhook retries. The counter reset on every 5xx. Now it stops after five attempts."],
    ["headings with no bullets", "# Done\n## Next\nText here for the card."],
    ["a very long bullet list", Array.from({ length: 30 }, (_, i) => `- item number ${i} with a fairly long description that keeps going on and on and on`).join("\n")],
  ])("is never empty: %s", (_name, reply) => {
    const html = renderFallbackHtml(reply);
    expect(html).toContain("<h1>");
    expect(html).toMatch(/<li><i><\/i><span>\S[^<]*<\/span><\/li>/);
    expect(texts(html).length).toBeGreaterThan(40);
  });
  it("caps the card at six rows and nine headline words", () => {
    const html = renderFallbackHtml(`# One two three four five six seven eight nine ten eleven\n${Array.from({ length: 30 }, (_, i) => `- row ${i}`).join("\n")}`);
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect(/<h1>(.*?)<\/h1>/.exec(html)![1]!.split(" ")).toHaveLength(9);
  });
});

describe("--visual lines and placeholders", () => {
  it("prints the Explain line between the player line and the links only with visual", () => {
    const on = orcaLines("abc", "http://h", true).split("\n");
    expect(on).toHaveLength(3);
    expect(on[0]).toBe('::orca-visual{file="earshot-abc-player.html" title="Listen"}');
    expect(on[1]).toBe('::orca-visual{file="earshot-abc-explain.html" title="Explain"}');
    expect(on[2]).toMatch(/^\[Listen\]\(/);
    expect(orcaLines("abc", "http://h")).not.toMatch(/explain/i);
    expect(orcaLines("abc", "http://h", false).split("\n")).toHaveLength(2);
  });
  it("writes nothing up front; at the read window's end it writes the card and a note, never over a real page", async () => {
    const d = mkdtempSync(join(tmpdir(), "earshot-vis-"));
    try {
      const job = { dir: d, png: false, visual: true, written: { player: false, explain: false } };
      expect(readdirSync(d)).toEqual([]);
      const disarm = armOrcaDeadline(job, "abc", () => "<h1>card</h1>", () => undefined, 20);
      await new Promise((r) => setTimeout(r, 80));
      disarm();
      expect(readFileSync(join(d, "earshot-abc-explain.html"), "utf8")).toContain("card");
      expect(readFileSync(join(d, "earshot-abc-player.html"), "utf8")).toContain("Use the Listen link");
      expect(readFileSync(join(d, "earshot-abc-player.html"), "utf8")).not.toContain("location.reload()");
      const d2 = mkdtempSync(join(tmpdir(), "earshot-vis2-"));
      const done = { dir: d2, png: false, visual: true, written: { player: true, explain: true } };
      armOrcaDeadline(done, "abc", () => "x", () => undefined, 10);
      await new Promise((r) => setTimeout(r, 60));
      expect(readdirSync(d2)).toEqual([]);
      rmSync(d2, { recursive: true, force: true });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("the unused explain stand-in still shows nothing", () => {
    expect(renderPendingHtml("explain", { reload: false })).toContain("display:none");
  });
});
