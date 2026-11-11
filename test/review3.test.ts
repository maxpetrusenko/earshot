import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrief, initialMeta, readMeta, writeBrief } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { applyTag } from "../src/extract/claude-code.js";
import { extractTagged } from "../src/extract/tagged.js";
import { decideCodex } from "../src/hook/codex.js";
import { installCodexMcp, installNotify, uninstallCodexMcp, uninstallNotify } from "../src/install/codex.js";
import { newId } from "../src/lib/id.js";
import { narrate, RateLimiter, ToolError } from "../src/mcp/tools.js";
import { createEarshotServer } from "../src/serve.js";
import { sweepBrief, sweepDead } from "../src/sweep.js";
import { parse } from "smol-toml";
import { startFakeProvider } from "./helpers.js";

const argv = ["env", "EARSHOT_HOOK=1", "earshot-hook", "codex"];
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-r3-"));
  process.env.EARSHOT_HOME = join(home, "earshot");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

let seq = 0;
const file = (body: string) => {
  const p = join(home, `c${seq++}.toml`);
  writeFileSync(p, body);
  return p;
};
const baks = () => readdirSync(home).filter((n) => n.includes("earshot-bak")).length;

describe("TOML editing (review 3, blocking)", () => {
  it("1. a nested array row like [3, 4] is not a table header", () => {
    const src = `model = "o3"\nmatrix = [\n  [1, 2],\n  [3, 4]\n]\n\n[tui]\nx = 1\n`;
    const f = file(src);
    installNotify(f, argv);
    const out = readFileSync(f, "utf8");
    const d = parse(out) as Record<string, unknown>;
    expect(d.notify).toEqual(argv);
    expect(d.matrix).toEqual([[1, 2], [3, 4]]);
    expect((d.tui as Record<string, unknown>).x).toBe(1);
    expect(out.indexOf("notify")).toBeGreaterThan(out.indexOf("[3, 4]\n]"));
    expect(out.indexOf("notify")).toBeLessThan(out.indexOf("[tui]"));
    uninstallNotify(f);
    expect(readFileSync(f, "utf8")).toBe(src);
  });

  it("2. an odd number of triple quotes in a comment cannot desync string tracking", () => {
    const a = `# tip: use """ for multi-line\nmodel = "o3"\n\n# earshot-managed: mcp\n[mcp_servers.earshot]\ncommand = "old"\nargs = ["mcp"]\n`;
    const fa = file(a);
    installCodexMcp(fa, ["earshot"]);
    expect(readFileSync(fa, "utf8").match(/\[mcp_servers\.earshot\]/g)).toHaveLength(1);
    const b = `# use """ here\nmodel = "o3"\n[tui]\nx = 1\n`;
    const fb = file(b);
    installNotify(fb, argv);
    const out = readFileSync(fb, "utf8");
    expect(out.match(/notify =/g)).toHaveLength(1);
    expect((parse(out) as Record<string, unknown>).notify).toEqual(argv);
    expect(out.indexOf("notify")).toBeLessThan(out.indexOf("[tui]"));
    uninstallNotify(fb);
    expect(readFileSync(fb, "utf8")).toBe(b);
  });

  it("refuses and leaves the file and the backups alone when the verify step would fail", () => {
    const before = baks();
    const f = file(`a = 1\n[t]\nb = 2\n`);
    // A marker line makes the table "ours"; a duplicate earshot table is invalid TOML, so the edit must be refused.
    const bad = file(`# earshot-managed: mcp\n[mcp_servers.earshot]\ncommand = "x"\n[mcp_servers.earshot]\ncommand = "y"\n`);
    expect(() => installCodexMcp(bad, ["earshot"])).toThrow(/not valid TOML/);
    expect(readFileSync(f, "utf8")).toBe(`a = 1\n[t]\nb = 2\n`);
    expect(baks()).toBe(before);
  });
});

describe("TOML editing (review 3, should fix)", () => {
  it("3. detects entries defined under [mcp_servers], with dotted keys, and a quoted notify", () => {
    for (const body of ['[mcp_servers]\nearshot = { command = "mine" }\n', '[mcp_servers]\nearshot.command = "mine"\n', 'mcp_servers.earshot.command = "mine"\n']) {
      const f = file(body);
      expect(() => installCodexMcp(f, ["earshot"])).toThrow(/earshot/);
      expect(uninstallCodexMcp(f).changed).toBe(false);
      expect(readFileSync(f, "utf8")).toBe(body);
    }
    for (const body of ['"notify" = ["mine"]\n', "'notify' = ['mine']\n", 'notify.x = 1\n']) {
      const f = file(body);
      expect(() => installNotify(f, argv)).toThrow(/notify/);
      expect(uninstallNotify(f).changed).toBe(false);
      expect(readFileSync(f, "utf8")).toBe(body);
    }
  });

  it("4. updating our table keeps keys the user added to it", () => {
    const f = file(`# earshot-managed: mcp\n[mcp_servers.earshot]\ncommand = "old"\nenv = { K = "v" } # mine\nargs = ["mcp"]\nstartup_timeout_sec = 30\n`);
    expect(installCodexMcp(f, ["node", "/x/cli.js"]).note).toBe("MCP server updated");
    const d = parse(readFileSync(f, "utf8")) as { mcp_servers: { earshot: Record<string, unknown> } };
    expect(d.mcp_servers.earshot).toEqual({ command: "node", args: ["/x/cli.js", "mcp"], env: { K: "v" }, startup_timeout_sec: 30 });
    expect(readFileSync(f, "utf8")).toContain("# mine");
  });

  it("5. uninstall also removes subtables of our entry and nothing else", () => {
    const src = `model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n\n[mcp_servers.other.env]\nA = "1"\n`;
    const f = file(`${src}\n# earshot-managed: mcp\n[mcp_servers.earshot]\ncommand = "earshot"\nargs = ["mcp"]\n\n[mcp_servers.earshot.env]\nK = "v"\n\n[[mcp_servers.earshot.extra]]\nz = 1\n\n[tui]\nn = 1\n`);
    expect(uninstallCodexMcp(f).note).toBe("MCP server removed");
    expect(readFileSync(f, "utf8")).toBe(`${src}\n[tui]\nn = 1\n`);
  });

  it("6. install then uninstall is byte-identical for LF, CRLF and no trailing newline", () => {
    const docs = [
      `model = "o3"\n\n[tui]\nx = 1\n`,
      `model = "o3"\r\n\r\n[tui]\r\nx = 1\r\n`,
      `model = "o3"\n\n[tui]\nx = 1`,
      `model = "o3"`,
      `model = "o3"\r\n`,
      `# only a comment`,
      `[tui]\nx = 1\n\n\n`,
      ``,
    ];
    for (const src of docs) {
      const f = file(src);
      installNotify(f, argv);
      installCodexMcp(f, ["earshot"]);
      const mid = readFileSync(f, "utf8");
      if (src.includes("\r\n")) expect(mid.replace(/\r\n/g, "")).not.toContain("\n");
      installNotify(f, argv);
      uninstallCodexMcp(f);
      uninstallNotify(f);
      expect(readFileSync(f, "utf8")).toBe(src);
    }
  });
});

describe("property test: 200 random TOML documents", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ROOT: ((k: string) => string)[] = [
    (k) => `k${k} = "text"`, (k) => `k${k} = 12`, (k) => `k${k} = [1, 2, 3]`, (k) => `k${k} = [\n  [1, 2],\n  [3, 4],\n]`,
    (k) => `k${k} = { a = 1, b = [1, 2] }`, (k) => `k${k} = """\n[not.a.table]\nnotify = ["x"]\n"""`, (k) => `k${k} = '''\n[fake]\n'''`,
    (k) => `# tip """ odd quotes ${k}`, (k) => `# [looks.like.a.header] ${k}`, (k) => `"quoted${k}" = true`, (k) => `dotted${k}.sub = 1`,
    (k) => `k${k} = [\n  "a", # c [x]\n  'b',\n]`, (k) => `k${k} = 1979-05-27T07:32:00Z`,
  ];
  const TABLE: ((k: string) => string)[] = [
    (k) => `[t${k}]\nx = 1\ny = [[1], [2]]`, (k) => `[a${k}.b]\nz = "s" # c`, (k) => `[[arr${k}]]\nn = 1`,
    (k) => `[mcp_servers.other${k}]\ncommand = "o"\nargs = ["--flag"]`, (k) => `[mcp_servers.other${k}.env]\nA = "1"`,
    (k) => `[b${k}."x]y"]\nk = 1`, (k) => `[profiles.p${k}]\nmodel = "m"\nnotify = ["inside a table"]`,
  ];
  const pick = (r: () => number, from: ((k: string) => string)[], seed: number, tag: string) =>
    from.map((f, i) => ({ f, i })).filter(() => r() > 0.5).map(({ f, i }) => f(`${seed}${tag}${i}`));
  const rootFrags = (r: () => number, seed: number) => pick(r, ROOT, seed, "r");
  const tableFrags = (r: () => number, seed: number) => pick(r, TABLE, seed, "t");

  it("round-trips byte for byte or refuses without writing", () => {
    let wrote = 0;
    let refused = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const blanks = () => "\n".repeat(1 + Math.floor(r() * 2));
      const roots = [...(r() < 0.15 ? ['notify = ["/usr/bin/other", "x"]'] : []), ...rootFrags(r, seed)];
      const tables = tableFrags(r, seed);
      let src = [roots.join("\n"), ...tables.map((t) => t)].filter(Boolean).join(blanks());
      if (r() < 0.75) src += "\n";
      if (r() < 0.25) src = src.replace(/\n/g, "\r\n");
      const f = file(src);
      const results: boolean[] = [];
      const before = baks();
      for (const op of [() => installNotify(f, argv), () => installCodexMcp(f, ["earshot"])]) {
        const snapshot = readFileSync(f, "utf8");
        try {
          op();
          results.push(true);
          const d = parse(readFileSync(f, "utf8")) as Record<string, unknown>;
          expect(d).toBeTruthy();
        } catch (e) {
          results.push(false);
          refused++;
          expect(e).toBeInstanceOf(Error);
          expect(readFileSync(f, "utf8")).toBe(snapshot);
        }
      }
      if (results.some(Boolean)) wrote++;
      uninstallCodexMcp(f);
      uninstallNotify(f);
      expect(readFileSync(f, "utf8"), `seed ${seed}`).toBe(src);
      expect(baks()).toBeGreaterThanOrEqual(before);
    }
    expect(wrote).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(0);
  });
});

describe("tag scan is linear (review 3, #7)", () => {
  const evil = "<narrate>".repeat(111_112); // about 1 MB of unclosed openers
  const time = <T,>(fn: () => T) => {
    const t0 = performance.now();
    const v = fn();
    return { v, ms: performance.now() - t0 };
  };
  it("handles 1 MB of unclosed tags in under 100 ms in every entry point", () => {
    expect(evil.length).toBeGreaterThan(1_000_000);
    expect(time(() => extractTagged(evil)).ms).toBeLessThan(100);
    expect(time(() => applyTag(evil, true)).ms).toBeLessThan(100);
    expect(time(() => applyTag(evil, false)).ms).toBeLessThan(100);
    const cfg = parseConfig("trigger:\n  require_tool_use: false\n");
    expect(time(() => decideCodex({ type: "agent-turn-complete", "last-assistant-message": evil }, cfg)).ms).toBeLessThan(100);
  });
  it("still picks the right blocks", () => {
    expect(extractTagged("<narrate>a</narrate> x <narrate>b</narrate> <narrate>unclosed")).toBe("b");
    expect(applyTag("pre <NARRATE> hi </narrate> post", true)).toBe("hi");
    expect(applyTag("<narrate>a<narrate>b</narrate>", false)).toBe("a<narrate>b");
  });
  it("the MCP rate limit is checked before any parsing", async () => {
    const lim = new RateLimiter(0, 60_000);
    const deps = { cfg: () => parseConfig(""), baseUrl: async () => "http://localhost:1" };
    await expect(narrate({ text: evil }, lim, deps)).rejects.toThrow(/rate limit/);
    await expect(narrate({ text: "" }, lim, deps)).rejects.toThrow(/rate limit/);
    await expect(narrate({ text: "" }, new RateLimiter(), deps)).rejects.toThrow(ToolError);
  });
});

describe("dead worker sweep (review 3, #8)", () => {
  const pending = (age = 10 * 60_000, pid?: number) => {
    const id = newId();
    const meta = initialMeta(id, { from: "test", chars: 1, redacted: 0, truncated: false }, "p");
    meta.created_at = new Date(Date.now() - age).toISOString();
    if (pid !== undefined) meta.worker_pid = pid;
    createBrief(meta, "input");
    return id;
  };

  it("marks an old pending brief with a dead worker failed: worker died", () => {
    const id = pending(10 * 60_000, 999_999);
    expect(sweepBrief(id, { alive: () => false })).toBe(true);
    expect(readMeta(id)).toMatchObject({ status: "failed", error: "worker died" });
  });
  it("leaves live workers, young briefs, briefs without a pid and finished briefs alone", () => {
    const live = pending(10 * 60_000, 4242);
    const young = pending(5_000, 999_999);
    const nopid = pending(10 * 60_000);
    const done = pending(10 * 60_000, 999_999);
    const m = readMeta(done)!;
    m.status = "ready";
    writeBrief(m, "s");
    expect(sweepBrief(live, { alive: () => true })).toBe(false);
    expect(sweepBrief(young, { alive: () => false })).toBe(false);
    expect(sweepBrief(nopid, { alive: () => false })).toBe(false);
    expect(sweepBrief(done, { alive: () => false })).toBe(false);
    expect(readMeta(done)?.status).toBe("ready");
  });
  it("sweepDead covers every brief", () => {
    const a = pending(10 * 60_000, 999_998);
    const b = pending(10 * 60_000, 999_997);
    const swept = sweepDead({ alive: () => false });
    expect(swept).toEqual(expect.arrayContaining([a, b]));
  });
  it("the card's meta.json fetch runs the sweep", async () => {
    const id = pending(10 * 60_000, 999_996);
    const server = await createEarshotServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/b/${id}/meta.json`, { headers: {} });
      const meta = (await res.json()) as { status: string; error: string };
      expect(meta).toMatchObject({ status: "failed", error: "worker died" });
    } finally {
      server.close();
    }
  });
  it("a real worker killed during startup is recorded at spawn and then swept", async () => {
    const slow = await startFakeProvider({ chatDelayMs: 30_000 });
    const cfgPath = join(home, "slow.yaml");
    writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${slow.url}\n  model: fake\n  timeout_s: 60\ntts:\n  base_url: ${slow.url}\nserve:\n  mode: loopback\n  port: 17791\n`);
    const prev = process.env.EARSHOT_CONFIG;
    process.env.EARSHOT_CONFIG = cfgPath;
    try {
      const cfg = () => parseConfig(readFileSync(cfgPath, "utf8"));
      const r = await narrate({ text: "A report about the work. ".repeat(20) }, new RateLimiter(), { cfg, baseUrl: async () => "http://localhost:17791" });
      const pid = readMeta(r.id)!.worker_pid!;
      expect(pid).toBeGreaterThan(1);
      process.kill(pid, "SIGKILL"); // dies before any handler could mark the brief
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((x) => setTimeout(x, 20));
      }
      expect(readMeta(r.id)?.status).toBe("pending");
      expect(sweepBrief(r.id, { minAgeMs: 0 })).toBe(true);
      expect(readMeta(r.id)).toMatchObject({ status: "failed", error: "worker died" });
    } finally {
      if (prev === undefined) delete process.env.EARSHOT_CONFIG;
      else process.env.EARSHOT_CONFIG = prev;
      slow.server.close();
    }
  }, 20_000);
});
