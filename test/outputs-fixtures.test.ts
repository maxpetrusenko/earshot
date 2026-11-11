import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { redact } from "../src/redact.js";
import { runPipeline } from "../src/run.js";
import { startFakeProvider } from "./helpers.js";

const DIR = join(import.meta.dirname, "fixtures", "outputs");
const files = readdirSync(DIR).filter((f) => f.endsWith(".txt")).sort();
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-fx-"));
  process.env.EARSHOT_HOME = home;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("synthetic agent outputs", () => {
  it("has the ten expected kinds", () => {
    expect(files.map((f) => f.replace(/^\d+-|\.txt$/g, ""))).toEqual(["bugfix", "refactor", "failed-task", "research", "pr-opened", "deploy", "test-only", "long-multistep", "secrets", "no-evidence"]);
  });
  it("scrubs every secret in the secrets fixture before any network call", () => {
    const r = redact(readFileSync(join(DIR, "09-secrets.txt"), "utf8"));
    for (const s of ["sk_test_FAKEFIXTURE", "whsec_FAKEFIXTURE", "S3cretPassw0rd", "ghp_FAKEFIXTURE"]) expect(r.text).not.toContain(s);
    expect(r.count).toBeGreaterThanOrEqual(4);
  });
  it("runs all ten through the pipeline to ready", async () => {
    const p = await startFakeProvider();
    try {
      const cfg = parseConfig(`llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\n`);
      for (const f of files) {
        const r = await runPipeline(cfg, createLlm(cfg.llm), readFileSync(join(DIR, f), "utf8"), { from: "stdin" });
        expect(r.meta.status, f).toBe("ready");
      }
    } finally {
      p.server.close();
    }
  });
});
