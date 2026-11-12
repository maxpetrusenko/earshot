import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide } from "../src/hook/claude-code.js";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";
import { escapeHtml, fitOrcaPage, hasOrcaLine, orcaDir, orcaLine, predictPageBytes, renderPlayerHtml, ORCA_BUDGET_BYTES, type Reencode } from "../src/orca.js";
import { fakeMp3, startFakeProvider } from "./helpers.js";

const fakeEnc: Reencode = async (mp3, kbps) => Buffer.alloc(Math.round((mp3.length * kbps) / 128), 1);
const src = (n: number) => Buffer.alloc(n * 1000, 2);

describe("renderPlayerHtml", () => {
  const html = renderPlayerHtml({ edited: "AAAA", original: "BBBB" });
  it("uses Web Audio and no audio element or media data URL", () => {
    expect(html).not.toMatch(/<audio/i);
    expect(html).not.toContain("data:audio");
    expect(html).toContain("decodeAudioData");
    expect(html).toContain("createBufferSource");
    expect(html).toContain('{e:"AAAA",o:"BBBB"}');
  });
  it("is the control bar only: no title, no image", () => {
    for (const id of ["be", "bo", "sk", "bk", "fw", "sp", "tm", "st"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("font-size:13px;padding:6px 12px");
    expect(html).not.toContain('class="ti"');
    expect(html).not.toContain('class="sk"');
    expect(html).not.toContain("<svg");
  });
  it("detects iOS and iPadOS and collapses to nothing there", () => {
    expect(html).toContain("iPhone|iPad|iPod");
    expect(html).toContain("maxTouchPoints>1");
    expect(html).toContain("html.ios,html.ios body{display:none;height:0");
    expect(html.indexOf("maxTouchPoints")).toBeLessThan(html.indexOf("<body"));
    expect(html).toContain("if(document.documentElement.className!=='ios'){const A=");
  });
  it("reads theme tokens with fallbacks and never redefines one", () => {
    const vars = html.match(/var\(--[a-z-]+[^)]*\)/g) ?? [];
    expect(vars.length).toBeGreaterThan(6);
    for (const v of vars) expect(v).toMatch(/,/);
    expect(html).not.toMatch(/(^|[;{\s])--[a-z-]+\s*:/m);
    expect(html).not.toContain(":root");
  });
  it("uses no 100vh, no emoji and makes no network request", () => {
    expect(html).not.toMatch(/100\s*vh/);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it("omits Original and shows the note when the original is dropped; escapes the note", () => {
    const h = renderPlayerHtml({ edited: "AAAA", original: null, note: "<img src=x onerror=1> & more" });
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img src=x onerror=1&gt; &amp; more");
    expect(h).not.toContain('id="bo"');
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("fitOrcaPage", () => {
  it("picks 24k when the page fits", async () => {
    const f = await fitOrcaPage(src(100), src(100), { reencode: fakeEnc });
    expect(f.kbps).toBe(24);
    expect(f.droppedOriginal).toBe(false);
    expect(f.bytes).toBeLessThanOrEqual(ORCA_BUDGET_BYTES);
  });
  it("steps down to a lower bitrate until the page fits", async () => {
    // With the fake encoder a track is n * kbps / 128 bytes: at n=1200 neither 24k nor 20k fits, 16k does; at n=1000 20k fits.
    const f = await fitOrcaPage(src(1200), src(1200), { reencode: fakeEnc });
    expect(f.kbps).toBe(16);
    expect(f.bytes).toBeLessThanOrEqual(ORCA_BUDGET_BYTES);
    const mid = await fitOrcaPage(src(1000), src(1000), { reencode: fakeEnc });
    expect(mid.kbps).toBe(20);
  });
  it("drops the original and says so when 16k still does not fit", async () => {
    const f = await fitOrcaPage(src(1500), src(1500), { reencode: fakeEnc });
    expect(f.droppedOriginal).toBe(true);
    expect(f.html).toContain("did not fit");
    expect(f.html).not.toContain('id="bo"');
    expect(f.bytes).toBeLessThanOrEqual(ORCA_BUDGET_BYTES);
  });
  it("throws when the edited track alone is over budget", async () => {
    await expect(fitOrcaPage(src(5000), null, { reencode: fakeEnc })).rejects.toThrow(/over the/);
  });
  it("starts from the predicted bitrate and encodes once when the duration is known", async () => {
    let calls = 0;
    const counting: Reencode = (m, k) => (calls++, fakeEnc(m, k));
    const f = await fitOrcaPage(src(10), src(10), { reencode: counting, editedSeconds: 90, originalSeconds: 80 });
    expect(f.kbps).toBe(predictPageBytes(170, 24) <= ORCA_BUDGET_BYTES ? 24 : predictPageBytes(170, 20) <= ORCA_BUDGET_BYTES ? 20 : 16);
    expect(calls).toBe(2);
  });
  it("encodes real audio under the budget with ffmpeg", async () => {
    const f = await fitOrcaPage(fakeMp3(200), fakeMp3(200));
    expect(f.bytes).toBeLessThan(ORCA_BUDGET_BYTES);
    expect(f.html).not.toContain("<audio");
  });
});

describe("orca helpers", () => {
  it("orcaDir needs a writable directory", () => {
    const d = mkdtempSync(join(tmpdir(), "orca-dir-"));
    expect(orcaDir(undefined, {})).toBeNull();
    expect(orcaDir(undefined, { ORCA_CHAT_SCRATCH_DIR: join(d, "missing") })).toBeNull();
    expect(orcaDir(undefined, { ORCA_CHAT_SCRATCH_DIR: d })).toBe(d);
    expect(orcaDir(d, {})).toBe(d);
    rmSync(d, { recursive: true });
  });
  it("prints the one line Orca expects and recognises it", () => {
    const line = orcaLine("earshot-AbC123-player.html");
    expect(line).toBe('::orca-visual{file="earshot-AbC123-player.html" title="Listen"}');
    expect(hasOrcaLine(`text\n${line}`)).toBe(true);
    expect(hasOrcaLine('::orca-visual{file="earshot-AbC123.html" title="Listen"}')).toBe(true);
    expect(hasOrcaLine('::orca-visual{file="chart.html" title="x"}')).toBe(false);
    expect(hasOrcaLine("")).toBe(false);
  });
  it("config accepts tts.original_base_url", () => {
    expect(parseConfig("tts:\n  original_base_url: http://x/v1\n")).toMatchObject({ tts: { original_base_url: "http://x/v1" } });
  });
  it("the Stop hook treats either line as already narrated", async () => {
    const long = "word ".repeat(120);
    const visual = `${long}\n${orcaLine("earshot-AbC123-player.html")}`;
    expect(await decide({ last_assistant_message: visual }, parseConfig(""))).toMatchObject({ narrate: false, reason: expect.stringMatching(/Orca player line/) });
    const links = `${long}\n[Listen](http://h/b/AbC123AbC123AbC1/edited.mp3) \u00b7 [Original](http://h/b/AbC123AbC123AbC1/original.mp3)`;
    expect(await decide({ last_assistant_message: links }, parseConfig(""))).toMatchObject({ narrate: false, reason: expect.stringMatching(/earshot link/) });
  });
});

describe("earshot run --format orca", () => {
  let home: string;
  let dir: string;
  let provider: Awaited<ReturnType<typeof startFakeProvider>>;
  let cfgPath: string;
  const report = "Fixed the flaky webhook retries. The counter reset on every 5xx. Now it stops after five attempts. 212 tests pass. ".repeat(6);
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "earshot-orca-"));
    dir = mkdtempSync(join(tmpdir(), "earshot-orca-dir-"));
    provider = await startFakeProvider();
    cfgPath = join(home, "cfg.yaml");
    writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${provider.url}\n  model: fake\ntts:\n  base_url: ${provider.url}\nserve:\n  mode: loopback\n  port: 17778\n`);
  });
  afterAll(() => {
    provider.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ...env };
      for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
      if (!("ORCA_CHAT_SCRATCH_DIR" in env)) delete e.ORCA_CHAT_SCRATCH_DIR;
      const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfgPath, ...args], { env: e, cwd: join(import.meta.dirname, "..") });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(report);
    });

  it("waits for the audio, writes an inline page under 512 KB and prints the visual line then the links", async () => {
    const r = await run(["--format", "orca"], { ORCA_CHAT_SCRATCH_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^::orca-visual\{file="earshot-[A-Za-z0-9]{16}-player\.html" title="Listen"\}\n\[Listen\]\(http:\/\/localhost:17778\/b\/[A-Za-z0-9]{16}\/edited\.mp3\) \u00b7 \[Original\]\(\S+\/original\.mp3\)\n$/);
    expect(readdirSync(dir).filter((f) => f.endsWith("-explain.html"))).toEqual([]);
    const file = readdirSync(dir).find((f) => f.endsWith("-player.html"))!;
    expect(statSync(join(dir, file)).size).toBeLessThan(ORCA_BUDGET_BYTES);
    const html = readFileSync(join(dir, file), "utf8");
    expect(html).not.toContain("<audio");
    expect(html).toContain("decodeAudioData");
    expect(r.stderr).toMatch(/ms from start to line/);
  });
  it("auto prints both lines in Orca and only the links outside it", async () => {
    const inOrca = await run(["--format", "auto"], { ORCA_CHAT_SCRATCH_DIR: dir });
    expect(inOrca.stdout.split("\n").filter(Boolean)).toHaveLength(2); // explain none: player line and links
    expect(inOrca.stdout).toMatch(/^::orca-visual/);
    const outside = await run(["--format", "auto"]);
    expect(outside.stdout.trim().split("\n")).toHaveLength(1);
    expect(outside.stdout).toMatch(/^\[Listen\]\(/);
  });
  it("falls back to the markdown Listen line when ORCA_CHAT_SCRATCH_DIR is unset", async () => {
    const r = await run(["--format", "orca"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\[Listen\]\(http:\/\/localhost:17778\/b\/[A-Za-z0-9]{16}\/edited\.mp3\) · \[Original\]/);
  });
  it("falls back when the directory is not writable", async () => {
    const r = await run(["--format", "orca"], { ORCA_CHAT_SCRATCH_DIR: join(dir, "nope") });
    expect(r.stdout).toMatch(/^\[Listen\]\(/);
  });
  it("refuses --detach with --format orca", async () => {
    const r = await run(["--format", "orca", "--detach"]);
    expect(r.status).toBe(2);
  });
  it("a change worth a picture adds an explain page: player line, explain line, then the links last", async () => {
    const p = await startFakeProvider({ explain: EXPLAIN_SPEC });
    const cfg2 = join(home, "cfg2.yaml");
    writeFileSync(cfg2, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n  port: 17778\n`);
    const d2 = mkdtempSync(join(tmpdir(), "earshot-orca-explain-"));
    try {
      const r = await new Promise<string>((resolve) => {
        const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ORCA_CHAT_SCRATCH_DIR: d2 };
        for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
        const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfg2, "--format", "auto"], { env: e, cwd: join(import.meta.dirname, "..") });
        let out = "";
        child.stdout.on("data", (x) => (out += x));
        child.on("close", () => resolve(out));
        child.stdin.end(report);
      });
      const lines = r.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/-player\.html" title="Listen"/);
      expect(lines[1]).toMatch(/-explain\.html" title="Retries now stop at five"/);
      expect(lines[2]).toMatch(/^\[Listen\]\(/);
      const page = readFileSync(join(d2, readdirSync(d2).find((f) => f.endsWith("-explain.html"))!), "utf8");
      expect(page).toContain("Retries now stop at five");
      expect(page).not.toContain("decodeAudioData");
      expect(page).not.toContain("html.ios");
      const player = readFileSync(join(d2, readdirSync(d2).find((f) => f.endsWith("-player.html"))!), "utf8");
      expect(player).not.toContain("Retries now stop at five");
    } finally {
      p.server.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
