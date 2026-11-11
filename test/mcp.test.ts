import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir, failPending, readMeta } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { briefStatus, narrate, RateLimiter, ToolError, waitFor } from "../src/mcp/tools.js";
import { startFakeProvider } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
let home: string;
let provider: Awaited<ReturnType<typeof startFakeProvider>>;
let cfgPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "earshot-mcp-"));
  process.env.EARSHOT_HOME = join(home, "earshot");
  provider = await startFakeProvider({ title: "Fake mcp title" });
  cfgPath = join(home, "mcp.yaml");
  writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${provider.url}\n  model: fake\n  timeout_s: 30\ntts:\n  base_url: ${provider.url}\nserve:\n  mode: loopback\n  port: 17790\n`);
  process.env.EARSHOT_CONFIG = cfgPath;
  execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });
}, 60_000);
afterAll(() => {
  provider.server.close();
  rmSync(home, { recursive: true, force: true });
});

const cfg = () => parseConfig(readFileSync(cfgPath, "utf8"));
const deps = { cfg, baseUrl: async () => "http://localhost:17790" };
const fresh = () => new RateLimiter();

describe("narrate tool logic", () => {
  it("returns the Listen link at once (wait=false) with a pending brief and the mcp source", async () => {
    const t0 = performance.now();
    const r = await narrate({ text: "I fixed the bug and ran the tests. ".repeat(10) }, fresh(), deps);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ status: "pending" });
    expect(r.url).toBe(`http://localhost:17790/b/${r.id}`);
    expect(readMeta(r.id)?.source.from).toBe("mcp");
    expect(r.audio_url).toBeUndefined();
  });

  it("wait=true blocks until ready and returns the script and file links", async () => {
    const r = await narrate({ text: "Deployed the worker. ".repeat(20), wait: true, title: "My title" }, fresh(), deps);
    expect(r.status).toBe("ready");
    expect(r.script).toContain("word");
    expect(r.audio_url).toBe(`${r.url}/edited.mp3`);
    expect(r.image_url).toBe(`${r.url}/sketch.svg`);
    expect(r.title).toBe("My title");
    expect(existsSync(join(briefDir(r.id), "edited.mp3"))).toBe(true);
    const again = await briefStatus(r.id, deps);
    expect(again).toMatchObject({ id: r.id, status: "ready", audio_url: r.audio_url });
  }, 30_000);

  it("wait=true times out into a pending view, not an error", async () => {
    const slow = await startFakeProvider({ chatDelayMs: 30_000 });
    const slowYaml = `llm:\n  type: openai-compatible\n  base_url: ${slow.url}\n  model: fake\n  timeout_s: 60\ntts:\n  base_url: ${slow.url}\nserve:\n  mode: loopback\n  port: 17790\n`;
    const slowPath = join(home, "slow.yaml");
    writeFileSync(slowPath, slowYaml);
    process.env.EARSHOT_CONFIG = slowPath; // the detached worker reads this
    try {
      const t0 = performance.now();
      const r = await narrate({ text: "Long job. ".repeat(40), wait: true }, fresh(), { ...deps, cfg: () => parseConfig(slowYaml), waitTimeoutMs: 600 });
      expect(r.status).toBe("pending");
      expect(performance.now() - t0).toBeLessThan(3000);
      const v = await waitFor(r.id, "http://localhost:17790", { waitTimeoutMs: 100 });
      expect(v.status).toBe("pending");
      failPending(r.id, "test cleanup");
    } finally {
      process.env.EARSHOT_CONFIG = cfgPath;
      slow.server.close();
    }
  });

  it("scrubs secrets from the text and the title before anything is written or spawned", async () => {
    const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const r = await narrate({ text: `Rotated the key ${key} and verified.`.repeat(5), title: `Rotate ${key}` }, fresh(), deps);
    const dir = briefDir(r.id);
    for (const f of readdirSync(dir).filter((n) => !n.startsWith("."))) expect(readFileSync(join(dir, f), "utf8")).not.toContain(key);
    expect(readMeta(r.id)?.source.redacted).toBeGreaterThan(0);
    const mine = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(r.id));
    expect(mine.some((l) => l.includes(key))).toBe(false);
  });

  it("strips <narrate> tags, rejects empty and oversized text, and rate-limits a loop", async () => {
    const r = await narrate({ text: `<narrate>${"Tagged body. ".repeat(10)}</narrate> trailing chatter` }, fresh(), deps);
    expect(readFileSync(join(briefDir(r.id), "input.txt"), "utf8")).not.toContain("trailing chatter");
    await expect(narrate({ text: "   " }, fresh(), deps)).rejects.toThrow(ToolError);
    await expect(narrate({ text: "x".repeat(cfg().privacy.max_input_chars * 4 + 1) }, fresh(), deps)).rejects.toThrow(/over/);
    const lim = new RateLimiter(2, 1000);
    expect(lim.take(0)).toBe(true);
    expect(lim.take(10)).toBe(true);
    expect(lim.take(20)).toBe(false);
    expect(lim.take(1500)).toBe(true);
    const l = fresh();
    for (let i = 0; i < 6; i++) await narrate({ text: "Short loop run. ".repeat(10) }, l, deps);
    await expect(narrate({ text: "Short loop run. ".repeat(10) }, l, deps)).rejects.toThrow(/rate limit/);
  }, 30_000);

  it("accepts an evidence link only when it is in the text and on an allowed host", async () => {
    const pr = "https://github.com/acme/widgets/pull/42";
    const ok = await narrate({ text: `Opened ${pr} with the fix. `.repeat(8), evidence: pr }, fresh(), deps);
    expect(readMeta(ok.id)?.evidence).toBe(pr);
    const notInText = await narrate({ text: "No link here. ".repeat(20), evidence: pr }, fresh(), deps);
    expect(readMeta(notInText.id)?.evidence).toBeNull();
    const evilHost = "https://evil.example.com/x";
    const bad = await narrate({ text: `See ${evilHost} for details. `.repeat(8), evidence: evilHost }, fresh(), deps);
    expect(readMeta(bad.id)?.evidence).toBeNull();
  });

  it("brief_status validates the id and reports unknown briefs", async () => {
    await expect(briefStatus("../etc/passwd", deps)).rejects.toThrow(/16-character/);
    await expect(briefStatus("AAAAAAAAAAAAAAAA", deps)).rejects.toThrow(/no brief/);
  });
});

describe("MCP over stdio (real SDK client, real server process)", () => {
  it("lists both tools and runs narrate then brief_status to ready", async () => {
    const client = new Client({ name: "earshot-test", version: "0.0.0" });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.EARSHOT_HOME = process.env.EARSHOT_HOME!;
    env.EARSHOT_CONFIG = cfgPath;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist", "cli.js"), "mcp"], env, stderr: "ignore" }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["brief_status", "narrate"]);
      const call = await client.callTool({ name: "narrate", arguments: { text: "Migrated the table and all rows moved. ".repeat(12) } });
      expect(call.isError).toBeFalsy();
      const first = call.structuredContent as { id: string; url: string; status: string };
      expect(first.url).toMatch(/^http:\/\/localhost:17790\/b\/[A-Za-z0-9]{16}$/);
      let status = first.status;
      let last: Record<string, unknown> = {};
      for (let i = 0; i < 60 && status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        last = (await client.callTool({ name: "brief_status", arguments: { id: first.id } })).structuredContent as Record<string, unknown>;
        status = last.status as string;
      }
      expect(status).toBe("ready");
      expect(last.audio_url).toBe(`${first.url}/edited.mp3`);
      const bad = await client.callTool({ name: "narrate", arguments: { text: "" } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
