import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";
import { startFakeProvider } from "./helpers.js";

const until = async (fn: () => boolean, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const REPLY = "# Retries stop at five\n\nThe counter reset on every 5xx.\n\n- Counter keeps its value\n- Dead letter after five tries\n- 212 tests pass\n";

describe("earshot run --visual", () => {
  let home: string;
  const servers: { close: () => void }[] = [];
  const dirs: string[] = [];
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "earshot-visual-"));
  });
  afterAll(() => {
    servers.forEach((s) => s.close());
    for (const d of [home, ...dirs]) rmSync(d, { recursive: true, force: true });
  });
  async function run(extra: string[], opts: { explain?: unknown; reply?: string; port: number }) {
    const p = await startFakeProvider("explain" in opts ? { explain: opts.explain } : {});
    servers.push(p.server);
    const cfg = join(home, `cfg-${opts.port}.yaml`);
    writeFileSync(cfg, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n  port: ${opts.port}\n`);
    const scratch = mkdtempSync(join(tmpdir(), "earshot-visual-dir-"));
    dirs.push(scratch);
    const e: NodeJS.ProcessEnv = { ...process.env, EARSHOT_HOME: home, ORCA_CHAT_SCRATCH_DIR: scratch };
    for (const k of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn("npx", ["tsx", "src/cli.ts", "run", "--config", cfg, "--format", "auto", ...extra], { env: e, cwd: join(import.meta.dirname, "..") });
      let out = "";
      child.stdout.on("data", (x) => (out += x));
      child.on("close", () => resolve(out));
      child.stdin.end(opts.reply ?? REPLY);
    });
    const lines = stdout.trim().split("\n");
    const id = /earshot-([A-Za-z0-9]+)-player/.exec(lines[0]!)![1]!;
    return { lines, id, scratch, explainFile: join(scratch, `earshot-${id}-explain.html`), bundle: join(home, "briefs", id) };
  }

  it("prints the Explain line at once with a placeholder, then the model's image replaces it, with the director saved", async () => {
    const r = await run(["--visual"], { explain: EXPLAIN_SPEC, port: 17791 });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1]).toBe(`::orca-visual{file="earshot-${r.id}-explain.html" title="Explain"}`);
    expect(existsSync(r.explainFile)).toBe(true); // the placeholder is on disk before the line is printed
    expect(await until(() => readFileSync(r.explainFile, "utf8").includes("Retries now stop at five"))).toBe(true);
    expect(readFileSync(r.explainFile, "utf8")).not.toContain("Drawing the picture.");
    expect(await until(() => existsSync(join(r.bundle, "explain.director.txt")))).toBe(true);
    const saved = readFileSync(join(r.bundle, "explain.director.txt"), "utf8");
    expect(saved.split("\n").filter(Boolean)).toHaveLength(5);
    expect(saved).toMatch(/^intent: /);
    expect(readFileSync(r.explainFile, "utf8")).not.toContain("intent:");
  }, 60000);

  it("writes the fallback card when the model says NO_IMAGE: never an empty page", async () => {
    const r = await run(["--visual"], { port: 17792 });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1]).toMatch(/-explain\.html" title="Explain"/);
    expect(await until(() => readFileSync(r.explainFile, "utf8").includes("WHAT CHANGED"))).toBe(true);
    const page = readFileSync(r.explainFile, "utf8");
    expect(page).toContain("<h1>Retries stop at five.</h1>");
    expect(page).toContain("<span>Dead letter after five tries</span>");
    expect(page).not.toContain("Drawing the picture.");
    expect(await until(() => existsSync(join(r.bundle, "explain.html")))).toBe(true);
  }, 60000);

  it("writes the fallback card when the gate rejects the model's image twice", async () => {
    const bad = { ...EXPLAIN_SPEC, director: undefined };
    const r = await run(["--visual"], { explain: bad, port: 17793 });
    expect(await until(() => readFileSync(r.explainFile, "utf8").includes("WHAT CHANGED"))).toBe(true);
  }, 60000);

  it("a one-line reply still gets a fallback card, not an empty one", async () => {
    const r = await run(["--visual"], { reply: "Done.", port: 17794 });
    expect(await until(() => readFileSync(r.explainFile, "utf8").includes("WHAT CHANGED"))).toBe(true);
    expect(readFileSync(r.explainFile, "utf8")).toMatch(/<li><i><\/i><span>\S/);
  }, 60000);

  it("without the flag no Explain line is printed and no explain page is written to the chat dir", async () => {
    const r = await run([], { explain: EXPLAIN_SPEC, reply: REPLY.repeat(4), port: 17795 }); // long enough that the stage runs
    expect(r.lines).toHaveLength(2);
    expect(r.lines.join("\n")).not.toMatch(/explain/i);
    expect(await until(() => existsSync(join(r.bundle, "explain.html")))).toBe(true);
    expect(readdirSync(r.scratch).filter((f) => f.includes("-explain"))).toEqual([]);
  }, 60000);

  it("--visual with --no-explain prints no Explain line", async () => {
    const r = await run(["--visual", "--no-explain"], { explain: EXPLAIN_SPEC, port: 17796 });
    expect(r.lines).toHaveLength(2);
  }, 60000);
});
