import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastCodexUserPrompt } from "../src/extract/codex.js";
import { lastUserPrompt } from "../src/extract/claude-code.js";
import { asksForVisual, AUTO_MIN_CHARS, classifyStrict, decideVisual, RATE_WINDOW_MS } from "../src/trigger.js";
import { readTriggerState, recordTriggerState } from "../src/trigger-state.js";

interface Fx {
  name: string;
  group: "johto-ops" | "asked" | "evidence";
  kind?: "perf" | "bug" | "hosts" | "architecture";
  expect: "none" | "image";
  prompt: string;
  reply: string;
}
const load = (f: string): Fx[] => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/trigger", f), "utf8")) as Fx[];
const ops = load("johto-ops.json");
const asked = load("asked.json");
const evidence = load("evidence.json");
const decide = (x: Fx) => decideVisual({ reply: x.reply, prompt: x.prompt, autoOn: true });
const pad = (s: string): string => `${s}\n\n${"The rest of the reply carries plain detail that names nothing special. ".repeat(20)}`;

describe("trigger corpus (scrubbed real Claude Code replies)", () => {
  it("Johto lane and ops replies where no picture was asked get none", () => {
    expect(ops.length).toBeGreaterThanOrEqual(40);
    const hits = ops.filter((x) => decide(x).visual).map((x) => x.name);
    expect(hits).toEqual([]);
  });
  it("turns that ask for a visual always get one", () => {
    expect(asked.length).toBeGreaterThanOrEqual(4);
    for (const x of asked) {
      const d = decide(x);
      expect(d.visual, x.name).toBe(true);
      expect(d.why, x.name).toBe("asked");
    }
  });
  it("strong specific evidence (a measured before and after, a named cause and fix, a host table) gets one, of the right kind", () => {
    for (const x of evidence) {
      const d = decide(x);
      expect(d.visual, x.name).toBe(true);
      expect(d.situation, x.name).toBe(x.kind);
    }
  });
  it("the old trigger put a picture on most of the Johto ops fixtures (documented in each fixture)", () => {
    const old = (ops as unknown as { old: boolean }[]).filter((x) => x.old).length;
    expect(old / ops.length).toBeGreaterThan(0.7);
  });
  it("precision and recall on the whole fixture set", () => {
    const all = [...ops, ...asked, ...evidence];
    const yes = (x: Fx) => x.expect === "image";
    const tp = all.filter((x) => yes(x) && decide(x).visual).length;
    const fp = all.filter((x) => !yes(x) && decide(x).visual).length;
    const fn = all.filter((x) => yes(x) && !decide(x).visual).length;
    expect(fp).toBe(0);
    expect(fn).toBe(0);
    expect(tp / (tp + fp)).toBe(1);
  });
});

describe("asked", () => {
  const yes = ["visualize the flow of this change", "can you draw me a diagram of how it works", "show me the architecture", "make a chart of the latency", "give me a picture of the layers", "draw me an example of the notification", "I need a timeline diagram", "sketch out the data flow", "show me an image of the new page", "compare visually before and after"];
  const no = ["fix the typer and run the tests", "show me the fields for the next step", "show me the table view of the agents", "what is the architecture of this repo?", "can you do a better architecture for this", "dont show any images unless asked", "why i dont see images anywhere in chats", "check the flow of money", "your agent is generating diagrams of what it did", "You are an independent editorial critic. Draw a chart of your findings."];
  for (const p of yes) it(`yes: ${p}`, () => expect(asksForVisual(p)).toBe(true));
  for (const p of no) it(`no: ${p}`, () => expect(asksForVisual(p)).toBe(false));
  it("ignores injected reminders, task notices, pasted blocks and image placeholders", () => {
    expect(asksForVisual("<system-reminder>draw a diagram of everything</system-reminder> fix the bug")).toBe(false);
    expect(asksForVisual("[TASKNOTIF] <task-notification>make a chart of it</task-notification>")).toBe(false);
    expect(asksForVisual("thoughts? <pasted_content id=1>please draw a diagram</pasted_content>")).toBe(false);
    expect(asksForVisual(null)).toBe(false);
  });
  it("an ask wins over a short or plain reply and picks the situation from the reply", () => {
    const d = decideVisual({ reply: "Latency fell from 1.8 s to 240 ms after the cache.", prompt: "make a chart of this", autoOn: true });
    expect(d).toMatchObject({ visual: true, why: "asked", auto: false });
    expect(d.situation).not.toBe("none");
    expect(decideVisual({ reply: "Plain note about nothing in particular.", prompt: "visualize it", autoOn: true }).visual).toBe(true);
  });
  it("an ask is honoured even when visuals.auto is off; --no-visual still wins", () => {
    expect(decideVisual({ reply: "x".repeat(300), prompt: "draw a diagram", autoOn: false }).visual).toBe(true);
    expect(decideVisual({ reply: "x".repeat(300), prompt: "draw a diagram", autoOn: true, flag: false }).visual).toBe(false);
    expect(decideVisual({ reply: "plain", autoOn: false, flag: true }).visual).toBe(true);
  });
});

describe("not asked: strong evidence only", () => {
  it("perf: a before-to-after with units counts, a percentage or a range does not", () => {
    expect(classifyStrict(pad("The cache cut p95 from 1.8 s to 240 ms.")).situation).toBe("perf");
    expect(classifyStrict(pad("Cold start: 6.7 s → 0.6 s on the mini.")).situation).toBe("perf");
    expect(classifyStrict(pad("The meeting runs from 30 to 55 min depending on the agenda.")).situation).toBe("none");
    expect(classifyStrict(pad("The take rate rose from 25% to 29% last year.")).situation).toBe("none");
    expect(classifyStrict(pad("Free space went from 24 GB to 29 GB after the cleanup.")).situation).toBe("none");
  });
  it("perf: an explicit table of measured numbers counts", () => {
    const table = "| Step | Before | Now |\n|---|---|---|\n| Load | 300 | 21 |\n| Swap | 27 | 16 |\n| Idle | 11 | 2 |";
    expect(classifyStrict(pad(`The mini after the cleanup.\n\n${table}`)).situation).toBe("perf");
  });
  it("architecture: a structure word and a change verb in one sentence; generic ops nouns score 0", () => {
    expect(classifyStrict(pad("We added a queue layer between the API and the worker.")).situation).toBe("architecture");
    expect(classifyStrict(pad("The boundary moved: auth now lives in the gateway.")).situation).toBe("architecture");
    const ops = "The worker moved to the other queue. The service split into two modules behind the gateway. The socket daemon runs as a launchagent in the pipeline, and the lane is separate.";
    expect(classifyStrict(pad(ops)).situation).toBe("none");
  });
  it("bug: a named cause then a named fix; a mention of the phrase is not enough", () => {
    expect(classifyStrict(pad("The typer is fixed.\n\n**Root cause:** it counted words without spaces.\n\n**Fix:** it now retypes the same text.")).situation).toBe("bug");
    expect(classifyStrict(pad("It was caused by a stale cache. Fixed by clearing it on deploy. The cause is gone.")).situation).toBe("bug");
    expect(classifyStrict(pad("Nudges like \"you are not fixing the root cause\" are what staff want. We fixed the other thing.")).situation).toBe("none");
    expect(classifyStrict(pad("The root cause of the outage is still unknown.")).situation).toBe("none");
    expect(classifyStrict(`I rate it 8/10. ${pad("**Root cause:** shown on step 1. **Fix:** a green strip.")}`).situation).toBe("none");
  });
  it("hosts: only a status table whose rows are hosts or agents; machine names alone score 0", () => {
    const grid = "| Machine | State |\n|---|---|\n| pro | busy |\n| maxiclaw | idle |\n| uniclaw | down |";
    expect(classifyStrict(pad(`Fleet status.\n\n${grid}`)).situation).toBe("hosts");
    expect(classifyStrict(pad("pro is at 60%, maxiclaw is idle and uniclaw is online. The host status is fine on every node and every agent.")).situation).toBe("none");
    expect(classifyStrict(pad("| Item | Status |\n|---|---|\n| Claude Code login | no |\n| Codex login | no |\n| Hermes setup | maybe |")).situation).toBe("none");
  });
  it("needs about 1200 characters and a document is never drawn", () => {
    const short = "**Root cause:** a stale cache.\n\n**Fix:** clear it on deploy.";
    expect(short.length).toBeLessThan(AUTO_MIN_CHARS);
    expect(classifyStrict(short).situation).toBe("none");
    expect(classifyStrict(pad("Say this: the cache cut p95 from 1.8 s to 240 ms.")).situation).toBe("none");
    expect(classifyStrict(pad("Your resume says p95 went from 72 ms to 28 ms.")).situation).toBe("none");
  });
  it("visuals.auto off means no automatic picture", () => {
    expect(decideVisual({ reply: pad("Latency fell from 1.8 s to 240 ms."), autoOn: false }).visual).toBe(false);
  });
});

describe("rate limit (not-asked path only)", () => {
  const reply = pad("Latency fell from 1.8 s to 240 ms after the cache.");
  const now = 1_000_000_000;
  it("allows the first, blocks the next reply and the next 10 minutes, then allows again", () => {
    expect(decideVisual({ reply, autoOn: true, state: {}, now })).toMatchObject({ visual: true, auto: true });
    expect(decideVisual({ reply, autoOn: true, state: { lastAutoAt: now, lastHadImage: true }, now: now + 60_000 }).visual).toBe(false);
    expect(decideVisual({ reply, autoOn: true, state: { lastAutoAt: now, lastHadImage: false }, now: now + RATE_WINDOW_MS - 1 }).visual).toBe(false);
    expect(decideVisual({ reply, autoOn: true, state: { lastAutoAt: now, lastHadImage: false }, now: now + RATE_WINDOW_MS }).visual).toBe(true);
  });
  it("asked and forced requests are exempt", () => {
    const state = { lastAutoAt: now, lastHadImage: true };
    expect(decideVisual({ reply, prompt: "draw a chart", autoOn: true, state, now: now + 1000 }).visual).toBe(true);
    expect(decideVisual({ reply, autoOn: true, flag: true, state, now: now + 1000 }).visual).toBe(true);
  });
});

describe("state file and transcripts", () => {
  let home: string;
  const prev = process.env.EARSHOT_HOME;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "earshot-trigger-"));
    process.env.EARSHOT_HOME = home;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.EARSHOT_HOME;
    else process.env.EARSHOT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  it("keeps the last automatic image time and whether the last reply had one, per session", () => {
    expect(readTriggerState("s1")).toEqual({});
    recordTriggerState("s1", { image: true, auto: true, now: 5 });
    expect(readTriggerState("s1")).toMatchObject({ lastAutoAt: 5, lastHadImage: true });
    recordTriggerState("s1", { image: false, auto: false, now: 9 });
    expect(readTriggerState("s1")).toMatchObject({ lastAutoAt: 5, lastHadImage: false });
    expect(readTriggerState("s2")).toEqual({});
    expect(readTriggerState(undefined)).toEqual({});
  });
  it("reads the last real user message from a Claude Code transcript", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first ask" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply one" }] } },
      { type: "user", isMeta: true, message: { role: "user", content: "injected context" } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "please draw a diagram" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    ];
    expect(lastUserPrompt(lines.map((l) => JSON.stringify(l)).join("\n"))).toBe("please draw a diagram");
    expect(lastUserPrompt("")).toBeNull();
  });
  it("reads the last user message from a Codex rollout", () => {
    const lines = [
      { type: "event_msg", payload: { type: "user_message", message: "explain the flow" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "user_message", message: "show me a chart" } },
    ];
    expect(lastCodexUserPrompt(lines.map((l) => JSON.stringify(l)).join("\n"))).toBe("show me a chart");
  });
  it("the prompt file path is a plain read", () => {
    const f = join(home, "p.txt");
    writeFileSync(f, "visualize this");
    expect(asksForVisual(readFileSync(f, "utf8"))).toBe(true);
  });
});
