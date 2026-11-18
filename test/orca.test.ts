import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide } from "../src/hook/claude-code.js";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";
import { escapeHtml, fitOrcaPage, hasOrcaLine, orcaDir, orcaLine, predictPageBytes, renderPendingHtml, renderPlayerHtml, writeOrcaPage, ORCA_BUDGET_BYTES, type Reencode } from "../src/orca.js";
import { orcaLines } from "../src/orca-output.js";
import { fakeMp3, startFakeProvider } from "./helpers.js";

const fakeEnc: Reencode = async (mp3, kbps) => Buffer.alloc(Math.round((mp3.length * kbps) / 128), 1);
const src = (n: number) => Buffer.alloc(n * 1000, 2);
const until = async (fn: () => boolean, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const playerOf = (dir: string) => join(dir, readdirSync(dir).find((f) => f.endsWith("-player.html"))!);

describe("pending pages", () => {
  it("the player stand-in says it is preparing, reloads for a bounded time and collapses on iOS", () => {
    const html = renderPendingHtml("player", { madeAt: 1000 });
    expect(html).toContain("Preparing audio");
    expect(html).toContain("location.reload()");
    expect(html).toContain("1000<120000");
    expect(html).toContain("html.ios");
    expect(html).not.toContain("decodeAudioData");
  });
  it("a final note does not reload", () => {
    const html = renderPendingHtml("player", { reload: false, note: "Audio <failed>" });
    expect(html).not.toContain("reload");
    expect(html).toContain("Audio &lt;failed&gt;");
  });
  it("the explain stand-in shows nothing", () => {
    expect(renderPendingHtml("explain", { reload: false })).toContain("display:none");
  });
  it("orcaLines prints the player line and the links, and never an Explain line", () => {
    expect(orcaLines("abc", "http://h").split("\n")).toEqual(['::orca-visual{file="earshot-abc-player.html" title="Listen"}', "[Listen](http://h/b/abc/edited.mp3) \u00b7 [Original](http://h/b/abc/original.mp3)"]);
  });
  it("writeOrcaPage replaces a file in place and leaves no temp file", () => {
    const d = mkdtempSync(join(tmpdir(), "earshot-orca-w-"));
    try {
      const f = writeOrcaPage(d, "id1", "one");
      writeOrcaPage(d, "id1", "two");
      expect(readFileSync(join(d, f), "utf8")).toBe("two");
      expect(readdirSync(d)).toEqual([f]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("renderPlayerHtml", () => {
  const html = renderPlayerHtml({ edited: "AAAA", original: "BBBB" });
  it("uses Web Audio and no audio element or media data URL", () => {
    expect(html).not.toMatch(/<audio/i);
    expect(html).not.toContain("data:audio");
    expect(html).toContain("decodeAudioData");
    expect(html).toContain("createBufferSource");
    expect(html).toContain('{e:"AAAA",o:"BBBB"}');
  });
  it("is one compact row: play or pause, a Listen / Original toggle, elapsed and total time", () => {
    for (const id of ["pp", "be", "bo", "tm", "st"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain(">Listen</button>");
    expect(html).toContain(">Original</button>");
    expect(html).toContain("font-size:13px;padding:6px 12px");
    expect(html).not.toContain('class="ti"');
    expect(html).not.toContain("<svg");
  });
  it("has no seek bar, no 10 second skip and no speed control", () => {
    for (const id of ["sk", "bk", "fw", "sp"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("playbackRate");
    expect(html).not.toContain("rates");
  });
  it("detects iOS and iPadOS and collapses to nothing there", () => {
    expect(html).toContain("iPhone|iPad|iPod");
    expect(html).toContain("maxTouchPoints>1");
    expect(html).toContain("html.ios body{height:1px;visibility:hidden}");
    expect(html).toContain("html.ios .bar{display:none}");
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
  it("auto returns at once inside Orca: placeholders and lines now, the real player when the worker is done", async () => {
    const d = mkdtempSync(join(tmpdir(), "earshot-orca-auto-"));
    try {
      const t0 = Date.now();
      const inOrca = await run(["--format", "auto"], { ORCA_CHAT_SCRATCH_DIR: d });
      const elapsed = Date.now() - t0;
      expect(inOrca.status).toBe(0);
      const lines = inOrca.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2); // long reply, but no Explain line: an image may or may not come
      expect(lines[0]).toMatch(/-player\.html" title="Listen"/);
      expect(lines[1]).toMatch(/^\[Listen\]\(/);
      expect(inOrca.stdout).not.toMatch(/explain/i);
      expect(inOrca.stderr).not.toMatch(/orca encode/); // it did not wait for the audio
      expect(elapsed).toBeLessThan(15000);
      // the worker then replaces the stand-in with the finished player
      expect(await until(() => readdirSync(d).some((f) => f.endsWith("-player.html")) && readFileSync(playerOf(d), "utf8").includes("decodeAudioData"))).toBe(true);
      const player = readFileSync(playerOf(d), "utf8");
      expect(player).not.toContain("Preparing audio");
      expect(statSync(playerOf(d)).size).toBeLessThan(ORCA_BUDGET_BYTES);
      expect(readdirSync(d).filter((f) => f.includes("-explain"))).toEqual([]); // no explain file in the chat scratch dir, ever
      const id = /earshot-([A-Za-z0-9]+)-player/.exec(lines[0]!)![1]!;
      expect(await until(() => existsSync(join(home, "briefs", id, "meta.json")) && JSON.parse(readFileSync(join(home, "briefs", id, "meta.json"), "utf8")).status === "ready")).toBe(true);
      expect(readFileSync(join(home, "briefs", id, "card.html"), "utf8")).not.toContain("What changed"); // NO_IMAGE: no empty section either
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      rmSync(d, { recursive: true, force: true });
    }
  }, 60000);
  it("auto does not print an explain line for a short reply", async () => {
    const d = mkdtempSync(join(tmpdir(), "earshot-orca-short-"));
    try {
      const short = await new Promise<string>((resolve) => {
        const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ORCA_CHAT_SCRATCH_DIR: d };
        for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
        const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfgPath, "--format", "auto"], { env: e, cwd: join(import.meta.dirname, "..") });
        let out = "";
        child.stdout.on("data", (x) => (out += x));
        child.on("close", () => resolve(out));
        child.stdin.end("Fixed the flaky webhook retries. 212 tests pass.");
      });
      expect(short.trim().split("\n")).toHaveLength(2);
      expect(await until(() => readFileSync(playerOf(d), "utf8").includes("decodeAudioData"))).toBe(true);
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("auto outside Orca prints only the links at once", async () => {
    const outside = await run(["--format", "auto"]);
    expect(outside.stdout.trim().split("\n")).toHaveLength(1);
    expect(outside.stdout).toMatch(/^\[Listen\]\(/);
  });
  it("auto in Orca leaves a final note, not a spinner, when the audio cannot be made", async () => {
    const slow = await startFakeProvider({ chatDelayMs: 100 }); // chat answers {}: no script, so no edited track
    const cfg3 = join(home, "cfg3.yaml");
    writeFileSync(cfg3, `llm:\n  type: openai-compatible\n  base_url: ${slow.url}\n  model: fake\ntts:\n  base_url: ${slow.url}\nserve:\n  mode: loopback\n  port: 17778\n`);
    const d = mkdtempSync(join(tmpdir(), "earshot-orca-fail-"));
    try {
      await new Promise<void>((resolve) => {
        const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ORCA_CHAT_SCRATCH_DIR: d };
        for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
        const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfg3, "--format", "auto"], { env: e, cwd: join(import.meta.dirname, "..") });
        child.on("close", () => resolve());
        child.stdin.end(report);
      });
      expect(await until(() => readFileSync(playerOf(d), "utf8").includes("could not be made"))).toBe(true);
      expect(readFileSync(playerOf(d), "utf8")).not.toContain("location.reload()");
    } finally {
      slow.server.close();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(d, { recursive: true, force: true });
    }
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
  it("a change worth a picture adds no chat line: the page goes on the card", async () => {
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
      expect(lines).toHaveLength(2); // player, links
      expect(lines[0]).toMatch(/-player\.html" title="Listen"/);
      expect(lines[1]).toMatch(/^\[Listen\]\(/);
      expect(await until(() => readFileSync(playerOf(d2), "utf8").includes("decodeAudioData"))).toBe(true);
      const id = /earshot-([A-Za-z0-9]+)-player/.exec(lines[0]!)![1]!;
      expect(await until(() => existsSync(join(home, "briefs", id, "explain.html")) && readFileSync(join(home, "briefs", id, "card.html"), "utf8").includes("/explain.html"))).toBe(true);
      const page = readFileSync(join(home, "briefs", id, "explain.html"), "utf8");
      expect(page).toContain("Retries now stop at five");
      const player = readFileSync(playerOf(d2), "utf8");
      expect(player).not.toContain("Retries now stop at five");
      expect(readdirSync(d2).filter((f) => f.includes("-explain"))).toEqual([]);
    } finally {
      p.server.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });
  it("three visuals become three explain pages on the card, none in chat", async () => {
    const titles = ["Retries now stop at five", "Customer names load together", "Dead letter after five tries"];
    const p = await startFakeProvider({ explain: { visuals: titles.map((title) => ({ ...EXPLAIN_SPEC, no_image: false, title })) } });
    const cfg3 = join(home, "cfg3.yaml");
    writeFileSync(cfg3, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n  port: 17779\n`);
    const d3 = mkdtempSync(join(tmpdir(), "earshot-orca-three-"));
    try {
      const r = await new Promise<string>((resolve) => {
        const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ORCA_CHAT_SCRATCH_DIR: d3 };
        for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
        const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfg3, "--format", "auto"], { env: e, cwd: join(import.meta.dirname, "..") });
        let out = "";
        child.stdout.on("data", (x) => (out += x));
        child.on("close", () => resolve(out));
        child.stdin.end(report);
      });
      const lines = r.trim().split("\n");
      expect(lines).toHaveLength(2);
      const id = /earshot-([A-Za-z0-9]+)-player/.exec(lines[0]!)![1]!;
      expect(await until(() => existsSync(join(home, "briefs", id, "explain3.html")) && readFileSync(join(home, "briefs", id, "card.html"), "utf8").includes("explain3.html"))).toBe(true);
      expect(readFileSync(join(home, "briefs", id, "explain3.html"), "utf8")).toContain("<h1>Dead letter after five tries</h1>");
      expect(readdirSync(d3).filter((f) => f.includes("-explain"))).toEqual([]);
    } finally {
      p.server.close();
      rmSync(d3, { recursive: true, force: true });
    }
  });
});
