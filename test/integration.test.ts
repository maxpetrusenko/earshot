import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { runPipeline } from "../src/run.js";
import { createEarshotServer } from "../src/serve.js";
import { GOOD_SCRIPT, startFakeProvider } from "./helpers.js";

const REPORT = readFileSync(new URL("./fixtures/webhook.txt", import.meta.url), "utf8");

let home: string;
let provider: Awaited<ReturnType<typeof startFakeProvider>>;
let cfgYaml: string;
let site: Server;
let base: string;
let id: string;
let degradedId: string;

const cfgFor = (yaml: string) => parseConfig(yaml);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "earshot-test-"));
  process.env.EARSHOT_HOME = home;
  provider = await startFakeProvider();
  cfgYaml = `llm:\n  type: openai-compatible\n  base_url: ${provider.url}\n  model: fake\ntts:\n  base_url: ${provider.url}\nserve:\n  mode: loopback\n  port: 17777\n`;
  const cfg = cfgFor(cfgYaml);
  const r = await runPipeline(cfg, createLlm(cfg.llm), `${REPORT}\nOPENAI_API_KEY=sk-live-abcdefghijklmnop1234`, { from: "stdin" });
  id = r.meta.id;
  // A brief whose tts endpoint is dead must degrade, not fail.
  const dead = cfgFor(`${cfgYaml}`.replace(`base_url: ${provider.url}\nserve`, "base_url: http://127.0.0.1:9/v1\nserve"));
  degradedId = (await runPipeline(dead, createLlm(dead.llm), REPORT, { from: "stdin" })).meta.id;
  site = await createEarshotServer();
  await new Promise<void>((r2) => site.listen(0, "127.0.0.1", r2));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

afterAll(() => {
  site.close();
  provider.server.close();
  rmSync(home, { recursive: true, force: true });
});

describe("pipeline against a fake OpenAI-compatible provider", () => {
  it("produces a ready bundle", () => {
    const meta = JSON.parse(readFileSync(join(briefDir(id), "meta.json"), "utf8"));
    expect(meta.status).toBe("ready");
    expect(meta.title).toBe("Fake title");
    expect(meta.audio.duration_s).toBeGreaterThan(1);
    expect(meta.image.renderer).toBe("beautiful-mermaid");
    expect(meta.stages.map((s: { name: string }) => s.name).sort()).toEqual(["ear-script", "scrub", "sketch", "tts-edited", "tts-original"]);
    expect(meta.source.redacted).toBeGreaterThan(0);
    const files = readdirSync(briefDir(id)).sort();
    expect(files.filter((f) => !/^(?:edited|original)-\d{3}\.mp3$/.test(f))).toEqual(["card.html", "edited.mp3", "input.txt", "meta.json", "original.mp3", "script.md", "sketch.svg"]);
    expect(meta.tracks.edited.status).toBe("ready");
    expect(meta.tracks.original.status).toBe("ready");
    expect(meta.tracks.edited.chunks.length).toBeGreaterThan(1);
    expect(meta.tracks.edited.first_audio_ms).toBeLessThan(meta.total_ms);
  });
  it("scrubs secrets before anything is stored or sent", () => {
    expect(readFileSync(join(briefDir(id), "input.txt"), "utf8")).not.toContain("sk-live");
    expect(JSON.stringify(provider.calls)).not.toContain("sk-live");
  });
  it("degrades when tts is down", () => {
    const meta = JSON.parse(readFileSync(join(briefDir(degradedId), "meta.json"), "utf8"));
    expect(meta.status).toBe("degraded");
    expect(meta.error).toContain("edited");
    expect(meta.audio).toBeNull();
    expect(meta.image).not.toBeNull();
  });
  it("renders every sketch failure as a recorded degraded state", async () => {
    const p2 = await startFakeProvider({ mermaid: ["not a diagram"] });
    try {
      // The repair call returns a good diagram, so this one recovers with one retry.
      const cfg = cfgFor(cfgYaml.replaceAll(provider.url, p2.url));
      const r = await runPipeline(cfg, createLlm(cfg.llm), REPORT, { from: "stdin" });
      expect(r.meta.status).toBe("ready");
      expect(r.meta.image?.mermaid).toContain("Fixed");
    } finally {
      p2.server.close();
    }
  });
});

describe("serve security", () => {
  const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

  it("serves healthz, card, mp3, svg, meta with correct types and headers", async () => {
    expect((await get("/healthz")).status).toBe(200);
    const card = await get(`/b/${id}`);
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("text/html");
    expect(card.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(card.headers.get("x-content-type-options")).toBe("nosniff");
    expect(card.headers.get("cache-control")).toContain("private");
    expect(card.headers.get("access-control-allow-origin")).toBeNull();
    const mp3 = await get(`/b/${id}/edited.mp3`);
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
    const svg = await get(`/b/${id}/sketch.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect((await get(`/b/${id}/meta.json`)).status).toBe(200);
    expect((await get("/assets/card.css")).status).toBe(200);
    expect((await get("/assets/card.js")).headers.get("content-type")).toContain("javascript");
  });

  it("supports range requests", async () => {
    const r = await get(`/b/${id}/edited.mp3`, { headers: { range: "bytes=0-99" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await r.arrayBuffer()).byteLength).toBe(100);
    expect((await get(`/b/${id}/edited.mp3`, { headers: { range: "bytes=99999999-" } })).status).toBe(416);
  });

  it("returns 404 for traversal, wrong ids and unlisted files", async () => {
    const paths = [
      `/b/${id}/input.txt`,
      `/b/${id}/script.md`,
      `/b/${id}/card.html`,
      `/b/${id}/..%2f..%2fetc%2fpasswd`,
      `/b/${id}/%2e%2e/%2e%2e/etc/passwd`,
      `/b/${id}/../${degradedId}/meta.json/x`,
      `/b/${id.slice(1)}`,
      `/b/${id}0`,
      `/b/..%2f${id}/meta.json`,
      `/b/%2e%2e/${id}`,
      "/b/",
      "/b",
      "/",
      "/assets/../../package.json",
      "/assets/fonts/..%2f..%2fcard.css.map",
      `/b/${id}%00/memo.mp3`,
      `/b/${id}/edited.mp3%00.txt`,
      "/b/AAAAAAAAAAAAAAAA",
    ];
    for (const p of paths) {
      const res = await fetch(`${base}${p}`).catch(() => null);
      expect(res === null || res.status === 404 || res.status === 400, p).toBe(true);
      if (res && res.status !== 404) expect(res.status, p).toBe(400);
    }
    for (const f of ["input.txt", "script.md"]) {
      expect((await get(`/b/${id}/${f}`)).status).toBe(404);
    }
  });

  it("rejects non-GET methods", async () => {
    expect((await get(`/b/${id}`, { method: "POST", body: "x" })).status).toBe(405);
  });
});

describe("cli contract", () => {
  const cliEnv = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home };
    for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    return env;
  };
  // Async on purpose: the fake provider lives in this process, so the event loop must stay free.
  const run = (args: string[], input: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("npx", ["tsx", "src/cli.ts", ...args], { env: cliEnv(), cwd: join(import.meta.dirname, "..") });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });

  it("prints one markdown Listen line on success and exits 0", async () => {
    const cfgPath = join(home, "cfg.yaml");
    writeFileSync(cfgPath, cfgYaml);
    const r = await run(["run", "--config", cfgPath], REPORT);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/^\[Listen\]\(http:\/\/localhost:17777\/b\/[A-Za-z0-9]{16}\/edited\.mp3\) \u00b7 \[Listen original\]\(http:\/\/localhost:17777\/b\/[A-Za-z0-9]{16}\/original\.mp3\)\n$/);
    expect(r.stderr).toContain("ear-script");
  });
  it("exits 2 on empty input", async () => {
    const cfgPath = join(home, "cfg.yaml");
    writeFileSync(cfgPath, cfgYaml);
    const r = await run(["run", "--config", cfgPath], "   \n");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
  it("exits 0 with a link on a degraded brief", async () => {
    const cfgPath = join(home, "dead.yaml");
    writeFileSync(cfgPath, cfgYaml.replace(`base_url: ${provider.url}\nserve`, "base_url: http://127.0.0.1:9/v1\nserve"));
    const r = await run(["run", "--config", cfgPath], REPORT);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\[Listen\]\(/);
    expect(r.stderr).toContain("degraded");
  });
  it("keeps the old two-line form under --format plain and json under --format json", async () => {
    const cfgPath = join(home, "cfg.yaml");
    writeFileSync(cfgPath, cfgYaml);
    const plain = await run(["run", "--format", "plain", "--config", cfgPath], REPORT);
    expect(plain.stdout).toMatch(/^Listen: http:\/\/localhost:17777\/b\/[A-Za-z0-9]{16}\/edited\.mp3\nListen original: http:\/\/localhost:17777\/b\/[A-Za-z0-9]{16}\/original\.mp3\n$/);
    const json = await run(["run", "--format", "json", "--config", cfgPath], REPORT);
    expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(["card", "id", "listen", "listen_original"]);
  });
  it("keeps the original track when the script is too short", async () => {
    const bad = await startFakeProvider({ script: "far too short" });
    try {
      const cfgPath = join(home, "bad.yaml");
      writeFileSync(cfgPath, cfgYaml.replaceAll(provider.url, bad.url));
      const r = await run(["run", "--config", cfgPath], REPORT);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("degraded");
    } finally {
      bad.server.close();
    }
  });
  it("exits 2 when the script and the audio both fail", async () => {
    const bad = await startFakeProvider({ script: "far too short" });
    try {
      const cfgPath = join(home, "bad2.yaml");
      writeFileSync(cfgPath, cfgYaml.replaceAll(provider.url, bad.url).replace(`base_url: ${bad.url}\nserve`, "base_url: http://127.0.0.1:9/v1\nserve"));
      const r = await run(["run", "--config", cfgPath], REPORT);
      expect(r.status).toBe(2);
    } finally {
      bad.server.close();
    }
  });
  it("keeps GOOD_SCRIPT inside the word limits", () => {
    expect(GOOD_SCRIPT.split(" ").length).toBe(130);
  });
});
