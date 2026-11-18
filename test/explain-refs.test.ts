import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExplain, loadExplainPrompt } from "../src/explain.js";
import { alignLines } from "../src/explain-cards-render.js";
import { explainGate } from "../src/explain-gate.js";
import { renderExplainHtml } from "../src/explain-render.js";
import { parseExplain, type ExplainSpec } from "../src/explain-schema.js";
import type { LlmProvider } from "../src/llm.js";
import { padDecimals } from "../src/explain-util.js";

const root = join(import.meta.dirname, "..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const spec = (o: unknown): ExplainSpec => parseExplain(o)!;

const LOG = {
  eyebrow: "Earshot / Log comparison",
  title: "The gate was right.",
  takeaway: "The log made the rejection look wrong.",
  type: "log_compare",
  footer: "Gate decision unchanged.",
  panels: [{ cards: [{ tag: "BEFORE", sub: "REPORTED LOG", tone: "bad", mono: "0.55 needs 0.55", caption: "Same-looking numbers." }, { tag: "AFTER", sub: "EXPECTED DISPLAY", tone: "good", mono: "0.549 needs 0.550", caption: "Visibly below." }] }],
};
const STATES = {
  eyebrow: "Orca player / Timeline states",
  title: "Waiting isn't playing.",
  takeaway: "Two states the player should distinguish.",
  type: "state_key",
  footer: "State key only. No timing or alignment implied.",
  panels: [{ cards: [{ tag: "WAITING", title: "waits for edited", mark: "dashed" }, { tag: "PLAYING", title: "rest of Original", tone: "good", mark: "wave" }] }],
};
const RANGE = {
  eyebrow: "Earshot / Illustrative data",
  title: "Original is ready sooner.",
  takeaway: "Time until Original can play.",
  type: "range_chart",
  illustrative: true,
  panels: [{ unit: "s", player: true, rows: [{ label: "Before", from: 60, to: 60, text: "about 60 s" }, { label: "After", from: 7, to: 11, tone: "good" }] }],
};
const ARCH = {
  eyebrow: "Earshot / Architecture",
  title: "Agents drive one input service.",
  takeaway: "One native service does the clicking.",
  type: "architecture",
  panels: [
    {
      layers: [
        { name: "Independent AI agents", detail: "Hermes, Claude", icon: "agents", link: "CLI / MCP / socket" },
        { name: "Native macOS Input Service", detail: "Swift LaunchAgent", icon: "cursor", core: true, items: [{ name: "Mouse", icon: "cursor" }, { name: "Keyboard", icon: "keyboard" }, { name: "Observe", icon: "eye" }] },
        { name: "Visible macOS desktop", detail: "Screen Sharing", icon: "desktop" },
      ],
    },
  ],
};

describe("reference style gate", () => {
  it("passes the four reference shapes", () => {
    for (const o of [LOG, STATES, RANGE, ARCH]) expect(explainGate(spec(o)), String(o.type)).toBeNull();
  });
  it("allows architecture only as real, iconed layers", () => {
    expect(explainGate(spec(ARCH))).toBeNull();
    const boxes = { type: "architecture", title: "Two paths", takeaway: "x", eyebrow: "A / B", panels: [{ caption: "c", components: [{ id: "a", label: "Reply" }, { id: "b", label: "Script" }, { id: "c", label: "Explain" }], edges: [{ from: "a", to: "b", label: "text" }, { from: "a", to: "c", label: "text" }] }] };
    expect(explainGate(spec(boxes))).toMatch(/only as layers/);
    const noIcon = clone(ARCH);
    delete (noIcon.panels[0]!.layers[2] as { icon?: string }).icon;
    expect(explainGate(spec(noIcon))).toMatch(/needs an icon/);
    const generic = clone(ARCH);
    generic.panels[0]!.layers[2]!.name = "Component 3";
    expect(explainGate(spec(generic))).toMatch(/not a real component name/);
    const diagram = clone(ARCH);
    diagram.panels[0]!.layers[2]!.name = "Diagram";
    expect(explainGate(spec(diagram))).toMatch(/describes a picture/);
  });
  it("requires the illustrative label in the eyebrow when values are marked illustrative", () => {
    const o = clone(RANGE);
    o.eyebrow = "Earshot / Timing";
    expect(explainGate(spec(o))).toMatch(/must say it/);
    expect(explainGate(spec(RANGE))).toBeNull();
  });
  it("draws no axis without timings", () => {
    const o = clone(RANGE) as { panels: { rows: { from?: number; to?: number }[] }[] };
    o.panels[0]!.rows = [{ label: "Before" } as never, { label: "After" } as never];
    expect(explainGate(spec(o))).toMatch(/no axis/);
    const html = renderExplainHtml(spec(STATES));
    expect(html).not.toMatch(/class="axis|class="gl"|class="plot"/);
    expect(renderExplainHtml(spec(LOG))).not.toMatch(/class="axis/);
    expect(renderExplainHtml(spec(RANGE))).toMatch(/class="axis/);
  });
  it("needs an eyebrow, a short headline, two cards and different states", () => {
    const a = clone(LOG);
    a.eyebrow = "";
    expect(explainGate(spec(a))).toMatch(/eyebrow/);
    const b = clone(LOG);
    b.title = "The gate was right all along and nothing about it was ever broken";
    expect(explainGate(spec(b))).toMatch(/headline/);
    const c = clone(STATES);
    c.panels[0]!.cards[1]!.mark = "dashed";
    expect(explainGate(spec(c))).toMatch(/look different/);
    const d = clone(LOG);
    d.panels[0]!.cards[1]!.mono = "0.55 needs 0.55";
    expect(explainGate(spec(d))).toMatch(/same value/);
  });
});

describe("reference style render", () => {
  it("aligns the two log lines and highlights only the digits that differ", () => {
    const [a, b] = alignLines("0.55 needs 0.55", "0.549 needs 0.550");
    expect(b).toContain('<mark class="df">9</mark>');
    expect(b).toContain('<mark class="df">0</mark>');
    expect(a).toContain('class="gp"');
    expect(a).not.toContain('class="df"');
    expect(b.match(/<mark/g)).toHaveLength(2);
  });
  it("is light, one close-up with no cards for a log, and prints a range value once", () => {
    const log = renderExplainHtml(spec(LOG));
    expect(log).toContain('class="log"');
    expect(log).not.toMatch(/class="cd/);
    expect(log).not.toMatch(/dark|prefers-color-scheme/);
    const r = renderExplainHtml(spec(RANGE));
    expect(r.match(/7–11 s/g)).toHaveLength(1);
    expect(r).toContain('class="pw"');
    expect(r).toContain('class="rb"');
    expect(r).toContain('class="pt"');
  });
  it("draws an open value (more than N) as an open bracket, not a dot", () => {
    const o = clone(RANGE) as { panels: { player: boolean; rows: unknown[] }[] };
    o.panels[0]!.player = false;
    o.panels[0]!.rows = [{ label: "Before", from: 40, open: true, text: "more than 40" }, { label: "After", from: 5, text: "exactly 5", tone: "good" }];
    const html = renderExplainHtml(spec(o));
    expect(html).toContain('class="rb open"');
    expect(html.match(/class="pt"/g)).toHaveLength(1);
  });
  it("escapes model text", () => {
    const o = clone(LOG);
    o.panels[0]!.cards[0]!.mono = "<script>x</script>";
    expect(renderExplainHtml(spec(o))).not.toContain("<script>x");
  });
});

describe("status replies", () => {
  it("the 343-tests status reply is NO_IMAGE", async () => {
    const fx = JSON.parse(readFileSync(join(root, "test/fixtures/explain/status-tests.json"), "utf8")) as { reply: string; expect: string };
    expect(fx.reply).toBe("Lint, typecheck, build and tests all pass (343 tests).");
    expect(fx.expect).toBe("no_image");
    const llm: LlmProvider = { name: "f", model: "f", complete: async () => "NO_IMAGE" };
    const r = await buildExplain(llm, fx.reply);
    expect(r.visuals).toHaveLength(0);
    expect(r.reason).toBe("no_image");
  });
  it("the prompt tells the model a status line gets no picture", () => {
    expect(loadExplainPrompt()).toMatch(/A status update, a test or lint or build result[^\n]*no picture/);
  });
});

describe("skill and prompt share one rule set", () => {
  const skillDir = join(root, "integrations/claude-code/skills/explainer-visuals");
  it("ships SKILL.md under 300 lines with references", () => {
    const skill = join(skillDir, "SKILL.md");
    expect(existsSync(skill)).toBe(true);
    const text = readFileSync(skill, "utf8");
    expect(text.split("\n").length).toBeLessThan(300);
    expect(text).toMatch(/^---\nname: explainer-visuals\ndescription: /);
    expect(existsSync(join(skillDir, "references"))).toBe(true);
  });
  it("the rules both files name are the same", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const prompt = loadExplainPrompt();
    for (const rule of ["one concept", "dashed", "waveform", "bracket", "no time axis", "illustrative", "status update", "two-second"]) {
      expect(skill.toLowerCase(), `skill: ${rule}`).toContain(rule);
    }
    for (const rule of ["one concept", "dashed", "waveform", "bracket", "no time axis", "illustrative", "status update"]) {
      expect(prompt.toLowerCase(), `prompt: ${rule}`).toContain(rule);
    }
  });
});

describe("log precision and one perf image", () => {
  it("pads every decimal on a line to the same places: 0.549 needs 0.55 reads 0.549 needs 0.550", () => {
    expect(padDecimals("0.549 needs 0.55")).toBe("0.549 needs 0.550");
    expect(padDecimals("0.55 needs 0.55")).toBe("0.55 needs 0.55");
    expect(padDecimals("took 1.5 s")).toBe("took 1.5 s");
    const o = clone(LOG);
    o.panels[0]!.cards[1]!.mono = "0.549 needs 0.55";
    const html = renderExplainHtml(spec(o));
    expect(html).toContain('needs 0.55<mark class="df">0</mark>');
    expect(spec(o).panels[0]).toMatchObject({ cards: [{}, { mono: "0.549 needs 0.550" }] });
  });
  it("draws a log as one close-up with no caption lines", () => {
    const html = renderExplainHtml(spec(LOG));
    expect(html).not.toContain('class="cc');
    expect(html).not.toContain("Same-looking numbers.");
    expect(html).not.toContain("Visibly below.");
  });
  it("one reply with two perf charts ships one image that carries both main numbers", async () => {
    const time = { eyebrow: "Invoices / Performance", title: "The page loads faster.", takeaway: "Page time.", type: "range_chart", panels: [{ unit: "s", rows: [{ label: "Before", from: 1.8, to: 1.8, text: "1.8 s" }, { label: "After", from: 0.24, to: 0.24, text: "240 ms", tone: "good" }] }] };
    const queries = { eyebrow: "Invoices / Performance", title: "One query per page.", takeaway: "Queries per page.", type: "range_chart", panels: [{ unit: "queries", rows: [{ label: "Before", from: 201, to: 201 }, { label: "After", from: 1, to: 1, tone: "good" }] }] };
    const llm: LlmProvider = { name: "f", model: "f", complete: async () => JSON.stringify({ visuals: [time, queries] }) };
    const r = await buildExplain(llm, "Page 1.8 s to 240 ms, queries 201 to 1.");
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]!.html).toContain("1.8 s");
    expect(r.visuals[0]!.html).toContain("240 ms");
    expect(r.visuals[0]!.html).toContain("Queries per page: 201 to 1");
  });
});
