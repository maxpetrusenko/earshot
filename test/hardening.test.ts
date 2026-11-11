import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir, briefsRoot } from "../src/bundle.js";
import { DEFAULTS, parseConfig } from "../src/config.js";
import { claudeCliProvider, createLlm } from "../src/llm.js";
import { runPipeline } from "../src/run.js";
import { createEarshotServer } from "../src/serve.js";
import { GOOD_SCRIPT, startFakeProvider } from "./helpers.js";

const REPORT = readFileSync(new URL("./fixtures/webhook.txt", import.meta.url), "utf8");
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-hard-"));
  process.env.EARSHOT_HOME = home;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const cfgFor = (url: string, extra = "") =>
  parseConfig(`llm:\n  type: openai-compatible\n  base_url: ${url}\n  model: fake\ntts:\n  base_url: ${url}\n${extra}`);

describe("claude-cli provider", () => {
  const fakeClaude = (body: string) => {
    const path = join(home, `fake-claude-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };

  it("passes the isolation flags and strips credentials from the child env", async () => {
    const out = join(home, "argv.txt");
    const cmd = fakeClaude(`printf '%s\\n' "$@" > ${out}\nenv | grep -E '^ANTHROPIC_' >> ${out}\ncat >/dev/null\necho '{"ok":1}'`);
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.ANTHROPIC_AUTH_TOKEN = "x";
    process.env.ANTHROPIC_BASE_URL = "http://x";
    try {
      const llm = claudeCliProvider({ ...DEFAULTS.llm, command: cmd });
      expect(await llm.complete({ system: "sys", user: "hi" })).toContain("ok");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
    }
    const rec = readFileSync(out, "utf8");
    for (const flag of ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "--tools", "--no-session-persistence"]) {
      expect(rec).toContain(flag);
    }
    expect(rec).not.toMatch(/ANTHROPIC_/);
  });

  it("rejects instead of crashing when the child exits before reading stdin", async () => {
    const cmd = fakeClaude("exit 3");
    const llm = claudeCliProvider({ ...DEFAULTS.llm, command: cmd });
    await expect(llm.complete({ system: "s", user: "x".repeat(5_000_000) })).rejects.toThrow(/exited 3/);
  });
});

describe("serve survives a file read error", () => {
  it("answers 404 and keeps serving when the mp3 cannot be read", async () => {
    const p = await startFakeProvider();
    const cfg = cfgFor(p.url);
    const id = (await runPipeline(cfg, createLlm(cfg.llm), REPORT, { from: "stdin" })).meta.id;
    p.server.close();
    const mp3 = join(briefDir(id), "edited.mp3");
    chmodSync(mp3, 0o000);
    const site = await createEarshotServer();
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/b/${id}/edited.mp3`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      chmodSync(mp3, 0o600);
      site.close();
    }
  });
});

describe("generated text is scrubbed", () => {
  it("scrubs script, title and --title before writing the bundle", async () => {
    const p = await startFakeProvider({ script: `${GOOD_SCRIPT} password=hunter2xyz`, title: "Fixed token=tok98765 leak" });
    try {
      const cfg = cfgFor(p.url);
      const r = await runPipeline(cfg, createLlm(cfg.llm), REPORT, { from: "stdin", title: "api_key: ak556677 rotated" });
      const all = ["card.html", "script.md", "meta.json"].map((f) => readFileSync(join(r.dir, f), "utf8")).join("\n");
      expect(all).not.toMatch(/hunter2xyz|tok98765|ak556677/);
      const r2 = await runPipeline(cfg, createLlm(cfg.llm), REPORT, { from: "stdin" });
      expect(readFileSync(join(r2.dir, "meta.json"), "utf8")).not.toContain("tok98765");
    } finally {
      p.server.close();
    }
  });

  it("keeps privacy.redact:false but logs a warning", async () => {
    const p = await startFakeProvider();
    try {
      const cfg = cfgFor(p.url, "privacy:\n  redact: false\n");
      const lines: string[] = [];
      await runPipeline(cfg, createLlm(cfg.llm), REPORT, { from: "stdin", log: (l) => lines.push(l) });
      expect(lines.join("\n")).toMatch(/privacy\.redact is false/);
    } finally {
      p.server.close();
    }
  });
});

describe("a brief never stays pending", () => {
  it("marks the brief failed on SIGTERM", async () => {
    const p = await startFakeProvider({ chatDelayMs: 30000 });
    const cfgPath = join(home, "slow.yaml");
    writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\n  timeout_s: 60\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n`);
    const before = new Set(existsSync(briefsRoot()) ? readdirSync(briefsRoot()) : []);
    const env: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home };
    delete env.NODE_USE_ENV_PROXY;
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", "run", "--config", cfgPath], { env, cwd: join(import.meta.dirname, "..") });
    child.stdin.end(REPORT);
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      id = readdirSync(briefsRoot()).find((d) => !before.has(d) && existsSync(join(briefsRoot(), d, "meta.json")));
      if (!id) await new Promise((r) => setTimeout(r, 100));
    }
    expect(id).toBeDefined();
    expect(JSON.parse(readFileSync(join(briefDir(id!), "meta.json"), "utf8")).status).toBe("pending");
    const code = new Promise<number | null>((r) => child.on("close", r));
    child.kill("SIGTERM");
    expect(await code).toBe(143);
    const meta = JSON.parse(readFileSync(join(briefDir(id!), "meta.json"), "utf8"));
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("SIGTERM");
    expect(readFileSync(join(briefDir(id!), "card.html"), "utf8")).toContain("Could not make this memo");
    p.server.close();
  });
});
