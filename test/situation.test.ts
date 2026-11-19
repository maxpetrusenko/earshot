import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_VISUAL_MIN_CHARS, classifyReply, findPageUrl, shouldAutoVisual, type Situation } from "../src/situation.js";

const dir = join(import.meta.dirname, "fixtures/explain");
interface Fx {
  name: string;
  situation?: Situation;
  reply: string;
}
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fx);
const get = (n: string): Fx => fixtures.find((f) => f.name === n)!;

describe("situation classifier: one fixture per situation", () => {
  const cases: [Situation, string][] = [
    ["plan", "sit-plan"],
    ["architecture", "architecture-rec"],
    ["post", "sit-post"],
    ["logic", "sit-logic"],
    ["bug", "sit-bug"],
    ["perf", "perf"],
    ["ui", "sit-ui"],
    ["schema", "sit-schema"],
    ["options", "sit-options"],
    ["hosts", "sit-hosts"],
  ];
  for (const [situation, name] of cases) {
    it(`${situation}: ${name}`, () => {
      expect(classifyReply(get(name).reply).situation).toBe(situation);
    });
  }
  it("every long fixture that carries a label is classified as labelled", () => {
    for (const f of fixtures.filter((x) => x.situation && x.reply.length >= AUTO_VISUAL_MIN_CHARS - 100)) expect(classifyReply(f.reply).situation, f.name).toBe(f.situation);
  });
  it("post routes to post media, not to the explain stage", () => {
    const c = classifyReply(get("sit-post").reply);
    expect(c.route).toBe("post-media");
    expect(shouldAutoVisual(get("sit-post").reply, c)).toBe(false);
  });
});

describe("situation classifier: none", () => {
  const none: [string, string][] = [
    ["status update", get("status").reply],
    ["test result", get("status-tests").reply],
    ["test result, long", `Ran the full gate. ${"All 212 tests pass, lint is clean, typecheck passes and the build passes. ".repeat(9)}`],
    ["short answer", "Yes, the cache key includes the tenant id."],
    ["email draft", `Here's a draft reply to the vendor, not sent. Subject: Invoice 4471\n\nHi Dana,\n\nThanks for the note. We can move the renewal to the first of the month if the discount stays. Let me know what works on your side.\n\nBest,\nMax\n\nSay send and I will send it; otherwise tell me what to change in the tone or the dates.`],
    ["pushed", "PR opened and pushed to the branch. CI pending. Nothing is waiting on you."],
  ];
  for (const [label, text] of none) {
    it(label, () => {
      expect(classifyReply(text).situation).toBe("none");
      expect(shouldAutoVisual(text)).toBe(false);
    });
  }
});

describe("automatic visual", () => {
  it("needs a situation and about 600 characters", () => {
    const bug = get("sit-bug").reply;
    expect(shouldAutoVisual(bug)).toBe(true);
    expect(shouldAutoVisual(bug.slice(0, 400))).toBe(false);
  });
  it("finds the page a reply names", () => {
    expect(findPageUrl("Open http://localhost:3000/invoices to see it.")).toBe("http://localhost:3000/invoices");
    expect(findPageUrl("It runs on localhost:5173.")).toBe("http://localhost:5173");
    expect(findPageUrl("See https://example.com/a, then retry.")).toBe("https://example.com/a");
    expect(findPageUrl("no page here")).toBeNull();
  });
});
