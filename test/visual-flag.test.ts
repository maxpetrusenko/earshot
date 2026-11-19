import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";
import { startFakeProvider } from "./helpers.js";

const rd = (f: string): string => (existsSync(f) ? readFileSync(f, "utf8") : "");
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
    expect(await until(() => rd(r.explainFile).includes("Retries now stop at five"))).toBe(true);
    expect(rd(r.explainFile)).not.toContain("Drawing the picture.");
    expect(await until(() => existsSync(join(r.bundle, "explain.director.txt")))).toBe(true);
    const saved = readFileSync(join(r.bundle, "explain.director.txt"), "utf8");
    expect(saved.split("\n").filter(Boolean)).toHaveLength(5);
    expect(saved).toMatch(/^intent: /);
    expect(rd(r.explainFile)).not.toContain("intent:");
  }, 60000);

  it("three visuals: still one Explain line, and that page stacks all three, never an empty card", async () => {
    const two = { ...EXPLAIN_SPEC, title: "Second visual headline" };
    const three = { ...EXPLAIN_SPEC, title: "Third visual headline" };
    const r = await run(["--visual"], { explain: { visuals: [EXPLAIN_SPEC, two, three] }, port: 17797 });
    expect(r.lines).toHaveLength(3);
    expect(r.lines.filter((l) => l.includes("-explain"))).toHaveLength(1);
    expect(await until(() => rd(r.explainFile).includes("Third visual headline"))).toBe(true);
    const page = rd(r.explainFile);
    for (const t of ["Retries now stop at five", "Second visual headline", "Third visual headline"]) expect(page).toContain(t);
    expect(page).not.toContain("Drawing the picture.");
    expect(readdirSync(r.scratch).filter((f) => f.includes("-explain")).sort()).toEqual([`earshot-${r.id}-explain.html`]);
    expect(existsSync(join(r.bundle, "explain3.html"))).toBe(true); // the card page still has each visual on its own
  }, 60000);

  it("writes the fallback card when the model says NO_IMAGE: never an empty page", async () => {
    const r = await run(["--visual"], { port: 17792 });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1]).toMatch(/-explain\.html" title="Explain"/);
    expect(await until(() => rd(r.explainFile).includes("WHAT CHANGED"))).toBe(true);
    const page = rd(r.explainFile);
    expect(page).toContain("<h1>Retries stop at five.</h1>");
    expect(page).toContain("<span>Dead letter after five tries</span>");
    expect(page).not.toContain("Drawing the picture.");
    expect(await until(() => existsSync(join(r.bundle, "explain.html")))).toBe(true);
  }, 60000);

  it("writes the fallback card when the gate rejects the model's image twice", async () => {
    const bad = { ...EXPLAIN_SPEC, director: undefined };
    const r = await run(["--visual"], { explain: bad, port: 17793 });
    expect(await until(() => rd(r.explainFile).includes("WHAT CHANGED"))).toBe(true);
  }, 60000);

  it("a one-line reply still gets a fallback card, not an empty one", async () => {
    const r = await run(["--visual"], { reply: "Done.", port: 17794 });
    expect(await until(() => rd(r.explainFile).includes("WHAT CHANGED"))).toBe(true);
    expect(rd(r.explainFile)).toMatch(/<li><i><\/i><span>\S/);
  }, 60000);

  it("--no-visual forces the picture off even for a reply that would get one, and no explain page is written to the chat dir", async () => {
    const r = await run(["--no-visual"], { explain: EXPLAIN_SPEC, reply: REPLY.repeat(4), port: 17795 }); // long enough that the stage runs
    expect(r.lines).toHaveLength(2);
    expect(r.lines.join("\n")).not.toMatch(/explain/i);
    expect(await until(() => existsSync(join(r.bundle, "explain.html")))).toBe(true);
    expect(readdirSync(r.scratch).filter((f) => f.includes("-explain"))).toEqual([]);
  }, 60000);

  it("automatic: a long reply with a named root cause and fix gets the Explain line with no flag; a long status reply and a short reply do not", async () => {
    const reply = `Retries now stop at five, the retry bug is fixed.\n\n**Root cause:** the counter reset on every 5xx, so a failing job retried forever.\n\n**Fix:** the counter keeps its value and the job moves to the dead letter queue after five tries.\n\n${"The retry handler logs each attempt with the job id and the status code it saw. ".repeat(14)}`;
    const auto = await run([], { explain: EXPLAIN_SPEC, reply, port: 17798 });
    expect(auto.lines).toHaveLength(3);
    expect(auto.lines[1]).toMatch(/-explain\.html" title="Explain"/);
    expect(await until(() => rd(auto.explainFile).includes("Retries now stop at five"))).toBe(true);
    const status = await run([], { explain: EXPLAIN_SPEC, reply: `Ran the full gate on the branch. ${"All 212 tests pass and lint is clean, typecheck passes, build passes. ".repeat(10)}`, port: 17799 });
    expect(status.lines).toHaveLength(2);
    const short = await run([], { explain: EXPLAIN_SPEC, reply: "Fixed the root cause of the retry bug.", port: 17800 });
    expect(short.lines).toHaveLength(2);
    const forcedOff = await run(["--no-visual"], { explain: EXPLAIN_SPEC, reply, port: 17804 });
    expect(forcedOff.lines).toHaveLength(2);
  }, 90000);

  it("--visual with --no-explain prints no Explain line", async () => {
    const r = await run(["--visual", "--no-explain"], { explain: EXPLAIN_SPEC, port: 17796 });
    expect(r.lines).toHaveLength(2);
  }, 60000);

  it("the user's message decides: an ask via --prompt-file prints the Explain line, no ask prints none", async () => {
    const pf = join(home, "asked.txt");
    writeFileSync(pf, "can you draw me a diagram of the retry logic");
    const asked = await run(["--prompt-file", pf], { explain: EXPLAIN_SPEC, port: 17811 });
    expect(asked.lines).toHaveLength(3);
    expect(asked.lines[1]).toContain("-explain.html");
    const plain = join(home, "plain.txt");
    writeFileSync(plain, "fix the retry counter");
    const none = await run(["--prompt-file", plain], { explain: EXPLAIN_SPEC, port: 17812 });
    expect(none.lines).toHaveLength(2);
    const off = await run(["--prompt-file", pf, "--no-visual"], { explain: EXPLAIN_SPEC, port: 17813 });
    expect(off.lines).toHaveLength(2);
  }, 90000);

});
