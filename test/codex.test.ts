import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { extractCodexLast, findCodexSession, isSafeCodexId, lastCodexTurn } from "../src/extract/codex.js";
import { extractTagged } from "../src/extract/tagged.js";
import { decideCodex, parseNotifyArgv } from "../src/hook/codex.js";
import { installNotify, installCodexMcp, mcpBlock, notifyArgv, uninstallCodexMcp, uninstallNotify } from "../src/install/codex.js";
import { mcpInstall } from "../src/install/mcp.js";
import { startFakeProvider } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const F = (name: string) => join(ROOT, "test", "fixtures", "codex", name);
const S1 = "0000aaaa-0000-7000-8000-000000000001";
const S2 = "0000aaaa-0000-7000-8000-000000000002";
const S3 = "0000aaaa-0000-7000-8000-000000000003";
const rollout = (id: string) => readdirSync(join(ROOT, "test", "fixtures", "codex")).find((n) => n.endsWith(`-${id}.jsonl`))!;

let home: string;
let codexHome: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-codex-"));
  process.env.EARSHOT_HOME = join(home, "earshot");
  codexHome = join(home, "codex");
  process.env.CODEX_HOME = codexHome;
  const dir = join(codexHome, "sessions", "2026", "11", "10");
  mkdirSync(dir, { recursive: true });
  for (const id of [S1, S2, S3]) writeFileSync(join(dir, rollout(id)), readFileSync(F(rollout(id))));
  execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });
}, 60_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("codex session extractor (synthetic fixtures with the real rollout structure)", () => {
  it("takes the final_answer of the last turn, skipping commentary, tool items and a torn last line", () => {
    const t = lastCodexTurn(readFileSync(F(rollout(S1)), "utf8"));
    expect(t.text).toBe("Added the test and it passes: three cases.\n\nNext step: wire it into CI.");
    expect(t.toolUses).toBe(2);
    expect(t.text).not.toContain("Running the tests");
  });
  it("never reaches back to an earlier turn when the last turn has no answer (usage limit)", () => {
    const t = lastCodexTurn(readFileSync(F(rollout(S2)), "utf8"));
    expect(t.text).toBeNull();
    expect(t.sawTurn).toBe(true);
  });
  it("reads the older shape: no phase field, ordinal wrapper", () => {
    expect(lastCodexTurn(readFileSync(F(rollout(S3)), "utf8"))).toMatchObject({ text: "Older log without a phase field: the answer.", toolUses: 1 });
  });
  it("finds a session by exact id only", () => {
    expect(findCodexSession(S1)).toMatch(new RegExp(`${S1}\\.jsonl$`));
    expect(findCodexSession("0000aaaa-0000-7000-8000-00000000ffff")).toBeNull();
    expect(findCodexSession("../../etc/passwd")).toBeNull();
    expect(findCodexSession("0000aaaa")).toBeNull(); // a prefix is not an id
    expect(isSafeCodexId("a/b")).toBe(false);
  });
  it("falls back to archived_sessions", () => {
    mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
    const id = "0000bbbb-0000-7000-8000-000000000009";
    writeFileSync(join(codexHome, "archived_sessions", `rollout-2026-11-10T09-00-00-${id}.jsonl`), "{}\n");
    expect(findCodexSession(id)).toContain("archived_sessions");
  });
  it("retries while the file lags, then gives up with null", async () => {
    const f = join(home, "lag.jsonl");
    writeFileSync(f, readFileSync(F(rollout(S2)), "utf8"));
    setTimeout(() => writeFileSync(f, readFileSync(F(rollout(S1)), "utf8")), 150);
    expect((await extractCodexLast(f, { waitMs: 1000, intervalMs: 50 }))?.text).toContain("Added the test");
    expect(await extractCodexLast(F(rollout(S2)), { waitMs: 120, intervalMs: 40 })).toBeNull();
    expect(await extractCodexLast(join(home, "missing.jsonl"), { waitMs: 50, intervalMs: 20 })).toBeNull();
  });
});

describe("tagged extractor", () => {
  it("returns the last non-empty block", () => {
    expect(extractTagged("a <narrate>first</narrate> b <NARRATE>\n second one \n</NARRATE> tail")).toBe("second one");
    expect(extractTagged("<narrate>real</narrate> then <narrate>  </narrate>")).toBe("real");
  });
  it("returns null with no block or an unclosed one", () => {
    expect(extractTagged("plain text")).toBeNull();
    expect(extractTagged("<narrate>never closed")).toBeNull();
  });
});

describe("notify payload and gate", () => {
  const cfg = parseConfig("");
  const payload = JSON.parse(readFileSync(F("notify-payload.json"), "utf8"));
  const find = (id: string) => findCodexSession(id);
  it("parses the JSON argument Codex appends", () => {
    expect(parseNotifyArgv(["codex", JSON.stringify(payload)])?.["thread-id"]).toBe(S1);
    expect(parseNotifyArgv(["codex"])).toBeNull();
    expect(parseNotifyArgv(["codex", "not json"])).toBeNull();
    expect(parseNotifyArgv(["codex", "[1]"])).toBeNull();
  });
  it("narrates a long turn with tool use, counted from the session log", () => {
    expect(decideCodex(payload, cfg, find)).toMatchObject({ narrate: true, toolUses: 2 });
  });
  it("skips other events, short messages, missing logs and the opt-in tag", () => {
    expect(decideCodex({ ...payload, type: "approval-requested" }, cfg, find)).toMatchObject({ narrate: false });
    expect(decideCodex({ ...payload, "last-assistant-message": "ok" }, cfg, find)).toMatchObject({ narrate: false, reason: expect.stringContaining("min_chars") });
    expect(decideCodex({ ...payload, "thread-id": "0000aaaa-0000-7000-8000-00000000ffff" }, cfg, find)).toMatchObject({ narrate: false, reason: expect.stringContaining("no tool use") });
    expect(decideCodex(payload, parseConfig("trigger:\n  opt_in_tag: true\n"), find)).toMatchObject({ narrate: false });
    expect(decideCodex({ ...payload, "last-assistant-message": `<narrate>${"x ".repeat(300)}</narrate> ${"y ".repeat(300)}` }, parseConfig("trigger:\n  opt_in_tag: true\n"), find)).toMatchObject({ narrate: true });
    expect(decideCodex({ ...payload, "thread-id": "../x" }, parseConfig("trigger:\n  require_tool_use: false\n"), find)).toMatchObject({ narrate: true, toolUses: 0 });
  });
});

describe("hook codex process", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<{ out: string; ms: number }>((resolve) => {
      const t0 = performance.now();
      const child = spawn("node", [join(ROOT, "dist", "hook-entry.js"), "codex", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve({ out, ms: performance.now() - t0 }));
    });

  it("exits fast with a link while the LLM takes 30 s, records the codex source, and prints {} for junk", async () => {
    const p = await startFakeProvider({ chatDelayMs: 30_000 });
    const cfgPath = join(home, "codex-hook.yaml");
    writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\n  timeout_s: 60\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n  port: 17789\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, EARSHOT_CONFIG: cfgPath };
    delete env.NODE_USE_ENV_PROXY;
    try {
      const a = await run([readFileSync(F("notify-payload.json"), "utf8")], env);
      expect(a.ms).toBeLessThan(2000);
      const out = JSON.parse(a.out) as { url: string; id: string };
      expect(out.url).toMatch(/^http:\/\/localhost:17789\/b\/[A-Za-z0-9]{16}$/);
      const meta = JSON.parse(readFileSync(join(briefDir(out.id), "meta.json"), "utf8"));
      expect(meta.status).toBe("pending");
      expect(meta.source).toMatchObject({ from: "codex", session: S1 });
      const q = JSON.parse(readFileSync(join(process.env.EARSHOT_HOME!, "queue", `${S1}.json`), "utf8"));
      await new Promise((r) => setTimeout(r, 1500)); // let the worker install its signal handlers
      if (q.pid) process.kill(q.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 800));
      expect(JSON.parse(readFileSync(join(briefDir(out.id), "meta.json"), "utf8")).status).toBe("failed");
      expect(JSON.parse((await run(["garbage"], env)).out)).toEqual({});
      expect(JSON.parse((await run([JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "ok" })], env)).out)).toEqual({});
    } finally {
      p.server.close();
    }
  }, 30_000);
});

describe("codex installer (temp CODEX_HOME only)", () => {
  const argv = ["env", "EARSHOT_HOOK=1", "earshot-hook", "codex"];
  const cfgFile = (name: string) => join(home, `${name}.toml`);
  const ORIGINAL = `# my settings\nmodel = "gpt-x"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--flag"]\n\n[tui]\nnotifications = true\n`;

  it("adds notify at the root, before the first table, backs up, and is idempotent", () => {
    const f = cfgFile("a");
    writeFileSync(f, ORIGINAL);
    const r = installNotify(f, argv);
    expect(r).toMatchObject({ changed: true, note: "notify installed" });
    expect(readFileSync(r.backup!, "utf8")).toBe(ORIGINAL);
    const text = readFileSync(f, "utf8");
    expect(text).toBe(`# my settings\nmodel = "gpt-x"\n# earshot-managed: notify\nnotify = ["env", "EARSHOT_HOOK=1", "earshot-hook", "codex"]\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--flag"]\n\n[tui]\nnotifications = true\n`);
    expect(installNotify(f, argv)).toMatchObject({ changed: false });
    expect(readdirSync(home).filter((n) => n.startsWith("a.toml.earshot-bak")).length).toBe(1);
  });
  it("updates its own notify in place when the command changes", () => {
    const f = cfgFile("b");
    writeFileSync(f, ORIGINAL);
    installNotify(f, argv);
    const r = installNotify(f, ["env", "EARSHOT_HOOK=1", "node", "/new/path/hook-entry.js", "codex"]);
    expect(r.note).toBe("notify updated");
    const text = readFileSync(f, "utf8");
    expect(text.match(/notify = /g)).toHaveLength(1);
    expect(text.match(/earshot-managed: notify/g)).toHaveLength(1);
    expect(text).toContain('"/new/path/hook-entry.js"');
  });
  it("never overwrites another notify program, single or multi-line, and says what to do", () => {
    for (const [name, line] of [
      ["c", 'notify = ["/usr/bin/other", "turn-ended"]'],
      ["d", 'notify = [\n  "python3",\n  "/p/notify.py", # mine\n]'],
    ] as const) {
      const f = cfgFile(name);
      const body = `${line}\n\n[tui]\nx = 1\n`;
      writeFileSync(f, body);
      expect(() => installNotify(f, argv)).toThrow(/already sets notify to another program/);
      expect(readFileSync(f, "utf8")).toBe(body);
      expect(readdirSync(home).some((n) => n.startsWith(`${name}.toml.earshot-bak`))).toBe(false);
      expect(uninstallNotify(f).note).toMatch(/another program/);
      expect(readFileSync(f, "utf8")).toBe(body);
    }
  });
  it("ignores notify-looking text inside tables and multi-line strings", () => {
    const f = cfgFile("e");
    writeFileSync(f, `[profiles.x]\nnotify = ["other"]\n\n[notes]\ntext = """\nnotify = ["a"]\n[fake]\n"""\n`);
    installNotify(f, argv);
    const t = readFileSync(f, "utf8");
    expect(t.startsWith('# earshot-managed: notify\nnotify = ["env"')).toBe(true);
    expect(t).toContain('[profiles.x]\nnotify = ["other"]');
  });
  it("creates the file when missing, and uninstall restores the original bytes", () => {
    const f = cfgFile("g");
    installNotify(f, argv);
    expect(readFileSync(f, "utf8")).toBe('# earshot-managed: notify\nnotify = ["env", "EARSHOT_HOOK=1", "earshot-hook", "codex"]\n');
    uninstallNotify(f);
    expect(readFileSync(f, "utf8")).toBe("");
    const h = cfgFile("h");
    writeFileSync(h, ORIGINAL);
    installNotify(h, argv);
    uninstallNotify(h);
    expect(readFileSync(h, "utf8")).toBe(ORIGINAL.replace('model = "gpt-x"\n\n', 'model = "gpt-x"\n\n'));
  });
  it("keeps a symlinked config a symlink and a 0600 file 0600 (backup included)", () => {
    const real = cfgFile("real");
    writeFileSync(real, ORIGINAL);
    chmodSync(real, 0o600);
    const link = cfgFile("link");
    symlinkSync(real, link);
    const r = installNotify(link, argv);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("earshot-managed: notify");
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
  });
  it("adds the MCP table at the end without touching other tables, idempotently, and removes only its own", () => {
    const f = cfgFile("m");
    writeFileSync(f, ORIGINAL);
    const r = installCodexMcp(f, ["earshot"]);
    expect(r.changed).toBe(true);
    const text = readFileSync(f, "utf8");
    expect(text.startsWith(ORIGINAL)).toBe(true);
    expect(text).toContain('# earshot-managed: mcp\n[mcp_servers.earshot]\ncommand = "earshot"\nargs = ["mcp"]\n');
    expect(installCodexMcp(f, ["earshot"])).toMatchObject({ changed: false });
    expect(installCodexMcp(f, ["node", "/x/cli.js"]).note).toBe("MCP server updated");
    expect(readFileSync(f, "utf8").match(/\[mcp_servers\.earshot\]/g)).toHaveLength(1);
    uninstallCodexMcp(f);
    expect(readFileSync(f, "utf8")).toBe(ORIGINAL);
  });
  it("refuses a user-written earshot table and exotic forms", () => {
    for (const body of ['[mcp_servers.earshot]\ncommand = "mine"\n', '[mcp_servers."earshot"]\ncommand = "mine"\n', 'mcp_servers.earshot.command = "mine"\n', '[mcp_servers.earshot.env]\nA = "1"\n', 'mcp_servers = { earshot = { command = "mine" } }\n']) {
      const f = cfgFile("u");
      writeFileSync(f, body);
      expect(() => installCodexMcp(f, ["earshot"])).toThrow(/earshot/);
      expect(readFileSync(f, "utf8")).toBe(body);
      expect(uninstallCodexMcp(f).changed).toBe(false);
    }
  });
  it("print mode writes nothing; --write merges; claude-code prints the claude mcp add command", () => {
    const f = cfgFile("p");
    expect(mcpInstall({ client: "codex", bin: "earshot", path: f }).print).toBe(mcpBlock(["earshot"]).slice(1).join("\n"));
    expect(existsSync(f)).toBe(false);
    mcpInstall({ client: "codex", bin: "earshot", path: f, write: true });
    expect(readFileSync(f, "utf8")).toContain("[mcp_servers.earshot]");
    expect(mcpInstall({ client: "claude-code", bin: "earshot", scope: "project" }).print).toBe("claude mcp add --scope project earshot -- earshot mcp");
    expect(() => mcpInstall({ client: "claude-code", bin: "earshot", scope: "evil; rm" })).toThrow(/--scope/);
    expect(JSON.parse(mcpInstall({ client: "generic", bin: "earshot" }).print)).toEqual({ mcpServers: { earshot: { command: "earshot", args: ["mcp"] } } });
  });
  it("notifyArgv starts with the ownership marker", () => {
    expect(notifyArgv("earshot-hook").slice(0, 2)).toEqual(["env", "EARSHOT_HOOK=1"]);
    expect(notifyArgv("earshot-hook").at(-1)).toBe("codex");
  });
});

describe("run --from codex / tagged through the CLI", () => {
  const cli = (args: string[], input?: string, cfg?: string) =>
    spawnSync("node", [join(ROOT, "dist", "cli.js"), ...args, ...(cfg ? ["--config", cfg] : [])], { input, encoding: "utf8", env: { ...process.env, NODE_USE_ENV_PROXY: "" } });

  it("needs an explicit session id and rejects unsafe ones", () => {
    const a = cli(["run", "--from", "codex"], "");
    expect(a.status).toBe(2);
    expect(a.stderr).toContain("--from codex needs --session");
    const b = cli(["run", "--from", "codex", "--session", "../../x"]);
    expect(b.status).toBe(2);
    expect(cli(["run", "--from", "nope"], "x").stderr).toContain("--from must be one of");
  });
  it("dry-runs the last assistant message of a named session and the last <narrate> block", async () => {
    const p = await startFakeProvider({ title: "Fake codex title" });
    const cfg = join(home, "run.yaml");
    writeFileSync(cfg, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\n`);
    try {
      const a = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const c = spawn("node", [join(ROOT, "dist", "cli.js"), "run", "--from", "codex", "--session", S1, "--dry-run", "--config", cfg], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
        let stdout = "";
        c.stdout.on("data", (d) => (stdout += d));
        c.on("close", (status) => resolve({ status, stdout }));
      });
      expect(a.status).toBe(0);
      expect(a.stdout).toContain("Fake codex title");
      const b = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const c = spawn("node", [join(ROOT, "dist", "cli.js"), "run", "--from", "tagged", "--dry-run", "--config", cfg], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
        let stdout = "";
        c.stdout.on("data", (d) => (stdout += d));
        c.on("close", (status) => resolve({ status, stdout }));
        c.stdin.end("noise <narrate>the real result</narrate> more noise");
      });
      expect(b.status).toBe(0);
      expect(b.stdout).toContain("Fake codex title");
      const none = cli(["run", "--from", "tagged"], "no tags here");
      expect(none.status).toBe(2);
      expect(none.stderr).toContain("no <narrate>");
    } finally {
      p.server.close();
    }
  }, 20_000);
});
