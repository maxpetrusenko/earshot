// Live check of the sketch decision: runs the ear-script prompt on each fixture and compares flow/none to the expected value.
// Usage: pnpm tsx scripts/sketch-hitrate.ts   (uses ~/.config/earshot/config.yaml; calls the real LLM)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { dryRun } from "../src/run.js";

const OUT = join(import.meta.dirname, "..", "test", "fixtures", "outputs");
const SK = join(import.meta.dirname, "..", "test", "fixtures", "sketch");
// flow: a multi-part task; none: a status, answer, report or single change; either: judgment call, not scored
const EXPECT: [string, string, "flow" | "none" | "either", boolean][] = [
  [OUT, "01-bugfix.txt", "flow", true],
  [OUT, "02-refactor.txt", "either", false],
  [OUT, "03-failed-task.txt", "either", false],
  [OUT, "04-research.txt", "none", false],
  [OUT, "05-pr-opened.txt", "none", false],
  [OUT, "06-deploy.txt", "none", false],
  [OUT, "07-test-only.txt", "none", false],
  [OUT, "08-long-multistep.txt", "flow", false],
  [OUT, "09-secrets.txt", "none", false],
  [OUT, "10-no-evidence.txt", "either", false],
  [SK, "small-status.txt", "none", false],
  [SK, "small-fix.txt", "none", false],
  [SK, "multistep-bugfix.txt", "flow", true],
];
const cfg = loadConfig();
const llm = createLlm(cfg.llm);
let hit = 0;
let scored = 0;
for (const [dir, f, want, marks] of EXPECT) {
  const ear = await dryRun(cfg, llm, readFileSync(join(dir, f), "utf8"), () => undefined);
  const got = ear.flow ? "flow" : "none";
  const ok = want === "either" || got === want;
  const markOk = !marks || (!!ear.flow?.broken && !!ear.flow?.fixed);
  if (want !== "either") {
    scored++;
    if (ok) hit++;
  }
  console.log(`${ok ? "ok  " : "MISS"} ${f.padEnd(24)} want ${want.padEnd(6)} got ${got}${ear.flow ? ` (${ear.flow.nodes.length} nodes, broken=${ear.flow.broken ?? "-"} fixed=${ear.flow.fixed ?? "-"})` : ""}${marks && !markOk ? "  NO broken/fixed marks" : ""}`);
}
console.log(`hit rate ${hit}/${scored}`);
