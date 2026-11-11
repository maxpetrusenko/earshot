import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir, failPending, readMeta, withBriefLock } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { applyTag, extractLastMessage, findTranscript, lastTurn, readTail } from "../src/extract/claude-code.js";
import { decide } from "../src/hook/claude-code.js";
import { HOOK_TOKEN, install, installHook, installSkill, uninstall, uninstallHook, uninstallSkill } from "../src/install/claude-code.js";
import { startFakeProvider } from "./helpers.js";
import { initialMeta, createBrief, writeBrief } from "../src/bundle.js";
import { newId } from "../src/lib/id.js";

const ROOT = join(import.meta.dirname, "..");
const T = (name: string) => join(ROOT, "test", "fixtures", "transcripts", `${name}.jsonl`);
const read = (name: string) => readFileSync(T(name), "utf8");

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-cc-"));
  process.env.EARSHOT_HOME = join(home, "earshot");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude-user");
  execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });
}, 60_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("transcript extractor (synthetic fixtures with the real JSONL structure)", () => {
  it("returns the plain reply for a one-entry turn", () => {
    expect(lastTurn(read("simple"))).toMatchObject({ text: "Hi there. This is the whole reply.", toolUses: 0, sawUser: true });
  });
  it("takes the final text run after the last tool call, skipping thinking, tool results, meta and noise", () => {
    const t = lastTurn(read("tool-turn"));
    expect(t.toolUses).toBe(3);
    expect(t.text).toBe("Done. fizzbuzz.py and its test are in place and the three tests pass.\n\nNext step: say the word and I will wire it into the CLI.");
    expect(t.text).not.toContain("I will start");
    expect(t.text).not.toContain("Injected skill");
  });
  it("never reaches back to an earlier turn or into a subagent sidechain", () => {
    const t = lastTurn(read("sidechain-and-old-turn"));
    expect(t.text).toBe("Second task finished cleanly.");
    expect(t.promptId).toBe("prompt-B");
  });
  it("returns null text when the new prompt has no assistant text yet", () => {
    expect(lastTurn(read("stale-new-prompt")).text).toBeNull();
    expect(lastTurn(read("tool-only")).text).toBeNull();
  });
  it("ignores a torn last line and handles array-content prompts", () => {
    expect(lastTurn(read("torn-last-line")).text).toBe("Complete answer here.");
    expect(lastTurn(read("user-blocks"))).toMatchObject({ text: "Read it. Nothing wrong.", toolUses: 1 });
  });
  it("fails instead of narrating stale text when the transcript never catches up", async () => {
    const sleeps: number[] = [];
    const r = await extractLastMessage(T("stale-new-prompt"), { waitMs: 250, intervalMs: 50, sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((x) => setTimeout(x, ms));
    } });
    expect(r).toBeNull();
    expect(sleeps.length).toBeGreaterThan(1);
  });
  it("retries and succeeds once the file is flushed", async () => {
    const f = join(home, "lagging.jsonl");
    writeFileSync(f, read("stale-new-prompt"));
    setTimeout(() => writeFileSync(f, read("sidechain-and-old-turn")), 150);
    const r = await extractLastMessage(f, { waitMs: 1000, intervalMs: 50 });
    expect(r?.text).toBe("Second task finished cleanly.");
  });
  it("rejects text from a different prompt than the one that stopped", async () => {
    const r = await extractLastMessage(T("sidechain-and-old-turn"), { waitMs: 100, intervalMs: 50, promptId: "prompt-NEW" });
    expect(r).toBeNull();
  });
  it("reads only the tail of a big file", () => {
    const f = join(home, "big.jsonl");
    writeFileSync(f, `${"x".repeat(3_000_000)}\n${read("simple")}`);
    expect(lastTurn(readTail(f, 100_000)!).text).toBe("Hi there. This is the whole reply.");
    expect(readTail(join(home, "missing.jsonl"))).toBeNull();
  });
  it("finds the transcript by cwd and session", () => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-work-demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc.jsonl"), read("simple"));
    expect(findTranscript("/work/demo", "abc")).toBe(join(dir, "abc.jsonl"));
    expect(findTranscript("/work/demo", "../abc")).toBeNull();
    expect(findTranscript("/work/demo", "x/../../abc")).toBeNull();
    expect(findTranscript("/work/other", "abc")).toBeNull();
  });
  it("handles the <narrate> tag", () => {
    expect(applyTag("plain", false)).toBe("plain");
    expect(applyTag("plain", true)).toBeNull();
    expect(applyTag("before <narrate>the memo text</narrate> after", true)).toBe("the memo text");
    expect(applyTag("<narrate>\nonly this\n</narrate>", false)).toBe("only this");
  });
});

describe("trigger gate", () => {
  const cfg = (trigger = "") => parseConfig(`llm:\n  type: openai-compatible\n  base_url: http://x/v1\n  model: m\n${trigger}`);
  const long = "Result sentence. ".repeat(40);
  it("prefers last_assistant_message and uses the transcript only for tool use", async () => {
    const d = await decide({ last_assistant_message: long, transcript_path: T("tool-turn") }, cfg());
    expect(d).toMatchObject({ narrate: true, toolUses: 3 });
    if (d.narrate) expect(d.text).toBe(long.trim());
  });
  it("skips short replies, no-tool turns, stop_hook_active and missing opt-in tag", async () => {
    expect((await decide({ last_assistant_message: "done", transcript_path: T("tool-turn") }, cfg())).narrate).toBe(false);
    expect((await decide({ last_assistant_message: long, transcript_path: T("simple") }, cfg())).narrate).toBe(false);
    expect((await decide({ last_assistant_message: long }, cfg())).narrate).toBe(false);
    expect((await decide({ stop_hook_active: true, last_assistant_message: long, transcript_path: T("tool-turn") }, cfg())).narrate).toBe(false);
    expect((await decide({ last_assistant_message: long, transcript_path: T("tool-turn") }, cfg("trigger:\n  opt_in_tag: true\n"))).narrate).toBe(false);
    expect((await decide({ last_assistant_message: `<narrate>${long}</narrate>`, transcript_path: T("tool-turn") }, cfg("trigger:\n  opt_in_tag: true\n"))).narrate).toBe(true);
  });
  it("skips a reply that already carries an earshot link (skill ran), in markdown or plain form", async () => {
    const md = `${long}\n[Listen](https://h.example/b/AbCdEfGhIjKlMnOp/edited.mp3) \u00b7 [Listen original](https://h.example/b/AbCdEfGhIjKlMnOp/original.mp3)`;
    const plain = `${long}\nListen: http://localhost:7777/b/AbCdEfGhIjKlMnOp/edited.mp3\nListen original: http://localhost:7777/b/AbCdEfGhIjKlMnOp/original.mp3`;
    for (const m of [md, plain]) {
      expect(await decide({ last_assistant_message: m, transcript_path: T("tool-turn") }, cfg())).toMatchObject({ narrate: false, reason: expect.stringMatching(/already has an earshot link/) });
    }
    expect((await decide({ last_assistant_message: `${long} see https://example.com/b/short/edited.mp3`, transcript_path: T("tool-turn") }, cfg())).narrate).toBe(true);
  });
  it("honors min_chars and require_tool_use settings", async () => {
    const c = cfg("trigger:\n  min_chars: 5\n  require_tool_use: false\n");
    expect((await decide({ last_assistant_message: "hello there", transcript_path: T("simple") }, c)).narrate).toBe(true);
  });
  it("falls back to the transcript when the payload has no message, and fails when it lags", async () => {
    const c = cfg("trigger:\n  min_chars: 10\n");
    const ok = await decide({ transcript_path: T("tool-turn") }, c, 100);
    expect(ok.narrate).toBe(true);
    const bad = await decide({ transcript_path: T("stale-new-prompt") }, c, 150);
    expect(bad).toMatchObject({ narrate: false });
  });
});

describe("Stop hook process", () => {
  const spawnHook = (env: NodeJS.ProcessEnv, payload: unknown) =>
    new Promise<{ out: string; ms: number }>((resolve) => {
      const t0 = performance.now();
      const child = spawn("node", [join(ROOT, "dist", "hook-entry.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve({ out, ms: performance.now() - t0 }));
      child.stdin.end(JSON.stringify(payload));
    });

  it("returns fast and detached while the LLM takes 30 s, supersedes the older job, never leaves pending", async () => {
    const p = await startFakeProvider({ chatDelayMs: 30_000 });
    const cfgPath = join(home, "hook.yaml");
    writeFileSync(cfgPath, `llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\n  timeout_s: 60\ntts:\n  base_url: ${p.url}\nserve:\n  mode: loopback\n  port: 17788\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, EARSHOT_CONFIG: cfgPath };
    delete env.NODE_USE_ENV_PROXY;
    const payload = { session_id: "sess-queue", transcript_path: T("tool-turn"), cwd: "/work/demo", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Everything works. ".repeat(40) };
    let first: string | undefined;
    try {
      const a = await spawnHook(env, payload);
      expect(a.ms).toBeLessThan(2000);
      const msg = JSON.parse(a.out).systemMessage as string;
      expect(msg).toMatch(/^\[Listen\]\(http:\/\/localhost:17788\/b\/[A-Za-z0-9]{16}\/edited\.mp3\) \u00b7 \[Listen original\]\(http:\/\/localhost:17788\/b\/[A-Za-z0-9]{16}\/original\.mp3\)$/);
      first = msg.split("/b/")[1]!.split("/")[0]!;
      const meta1 = JSON.parse(readFileSync(join(briefDir(first), "meta.json"), "utf8"));
      expect(meta1.status).toBe("pending");
      expect(meta1.source).toMatchObject({ from: "claude-code", session: "sess-queue" });
      expect(existsSync(join(process.env.EARSHOT_HOME!, "logs", `${first}.log`))).toBe(true);

      const b = await spawnHook(env, payload);
      const second = (JSON.parse(b.out).systemMessage as string).split("/b/")[1]!.split("/")[0]!;
      expect(second).not.toBe(first);
      const meta1b = JSON.parse(readFileSync(join(briefDir(first), "meta.json"), "utf8"));
      expect(meta1b).toMatchObject({ status: "failed", error: "superseded" });
      await new Promise((r) => setTimeout(r, 800));
      expect(JSON.parse(readFileSync(join(briefDir(first), "meta.json"), "utf8")).error).toBe("superseded");
      expect(JSON.parse(readFileSync(join(briefDir(second), "meta.json"), "utf8")).status).toBe("pending");
      const q = JSON.parse(readFileSync(join(process.env.EARSHOT_HOME!, "queue", "sess-queue.json"), "utf8"));
      if (q.pid) process.kill(q.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 800));
      expect(JSON.parse(readFileSync(join(briefDir(second), "meta.json"), "utf8")).status).toBe("failed");
    } finally {
      p.server.close();
    }
  }, 30_000);

  it("prints {} for a payload the gate skips and for garbage", async () => {
    const env = { ...process.env, EARSHOT_CONFIG: join(home, "hook.yaml") };
    expect(JSON.parse((await spawnHook(env, { stop_hook_active: true })).out)).toEqual({});
    expect(JSON.parse((await spawnHook(env, { last_assistant_message: "ok", transcript_path: T("tool-turn") })).out)).toEqual({});
  });

  it("the checkout shim runs the same entry point", () => {
    const out = execFileSync("node", [join(ROOT, "integrations", "claude-code", "hooks", "stop.mjs")], { input: JSON.stringify({ stop_hook_active: true }), env: { ...process.env, EARSHOT_CONFIG: join(home, "hook.yaml") } });
    expect(JSON.parse(out.toString())).toEqual({});
  });
});

describe("install and uninstall", () => {
  const fresh = () => mkdtempSync(join(home, "proj-"));
  it("installs the skill at project scope with the invocation substituted, idempotently", () => {
    const cwd = fresh();
    install({ mode: "skill", scope: "project", cwd, bin: "earshot" });
    const f = join(cwd, ".claude", "skills", "earshot", "SKILL.md");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("allowed-tools: Bash(earshot run *)");
    expect(text).not.toContain("{{EARSHOT}}");
    expect(install({ mode: "skill", scope: "project", cwd, bin: "earshot" })[0]!.changed).toBe(false);
    expect(uninstallSkill(join(cwd, ".claude", "skills", "earshot")).changed).toBe(true);
    expect(existsSync(join(cwd, ".claude", "skills", "earshot"))).toBe(false);
  });
  it("refuses to overwrite a skill it did not install", () => {
    const cwd = fresh();
    mkdirSync(join(cwd, ".claude", "skills", "earshot"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "earshot", "SKILL.md"), "mine");
    expect(() => installSkill(join(cwd, ".claude", "skills", "earshot"), "earshot")).toThrow(/not installed by earshot/);
    expect(readFileSync(join(cwd, ".claude", "skills", "earshot", "SKILL.md"), "utf8")).toBe("mine");
  });
  it("merges the hook next to existing hooks, backs up first, is idempotent, and removes only its own entry", () => {
    const cwd = fresh();
    const settings = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const original = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
      },
    };
    writeFileSync(settings, JSON.stringify(original, null, 2));
    const r = installHook(settings, "EARSHOT_HOOK=1 node /x/dist/hook-entry.js");
    expect(r.changed).toBe(true);
    expect(r.backup && JSON.parse(readFileSync(r.backup, "utf8"))).toEqual(original);
    const merged = JSON.parse(readFileSync(settings, "utf8"));
    expect(merged.permissions).toEqual(original.permissions);
    expect(merged.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(installHook(settings, "EARSHOT_HOOK=1 node /x/dist/hook-entry.js").changed).toBe(false);
    expect(installHook(settings, "EARSHOT_HOOK=1 node /y/dist/hook-entry.js").note).toMatch(/updated/);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks.Stop).toHaveLength(2);
    expect(uninstallHook(settings).changed).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original);
    expect(uninstallHook(settings).changed).toBe(false);
  });
  it("creates settings when missing, prunes what it added on uninstall, and refuses invalid JSON", () => {
    const cwd = fresh();
    const settings = join(cwd, ".claude", "settings.json");
    installHook(settings, "EARSHOT_HOOK=1 node /x/dist/hook-entry.js");
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks.Stop[0].hooks[0]).toMatchObject({ type: "command", timeout: 10 });
    uninstallHook(settings);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
    const backups = () => readdirSync(join(cwd, ".claude")).filter((f) => f.includes("earshot-bak")).length;
    const before = backups();
    writeFileSync(settings, "{ not json");
    expect(() => installHook(settings, "x")).toThrow(/not valid JSON/);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
    expect(backups()).toBe(before);
  });
  it("uninstall removes both at project scope and never touches user scope", () => {
    const cwd = fresh();
    install({ mode: "skill", scope: "project", cwd, bin: "earshot" });
    install({ mode: "hook", scope: "project", cwd, bin: "earshot-hook" });
    const results = uninstall({ scope: "project", cwd });
    expect(results.every((r) => r.changed)).toBe(true);
    expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"))).toBe(false);
  });
});

describe("review 2 regressions", () => {
  const fresh = () => mkdtempSync(join(home, "rev-"));
  const ours = `${HOOK_TOKEN} node /x/dist/hook-entry.js`;

  it("never touches another tool's hook-entry.js Stop hook, byte for byte", () => {
    const dir = fresh();
    const settings = join(dir, "settings.json");
    const original = `{\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "node ~/tools/othertool/hook-entry.js" } ] }\n    ]\n  }\n}\n`;
    writeFileSync(settings, original);
    installHook(settings, ours);
    const merged = JSON.parse(readFileSync(settings, "utf8"));
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("node ~/tools/othertool/hook-entry.js");
    uninstallHook(settings);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(JSON.parse(original));
    // a foreign-only file is not even rewritten
    writeFileSync(settings, original);
    expect(uninstallHook(settings).changed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(original);
  });

  it("keeps a symlinked settings.json a symlink and writes the target", () => {
    const dir = fresh();
    const real = join(dir, "real-settings.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, link);
    installHook(link, ours);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).hooks.Stop[0].hooks[0].command).toBe(ours);
    uninstallHook(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("keeps a 0600 settings file 0600, backup included", () => {
    const dir = fresh();
    const f = join(dir, "settings.json");
    writeFileSync(f, "{}\n");
    chmodSync(f, 0o600);
    const r = installHook(f, ours);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    uninstallHook(f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("raises a clear error for a null or malformed Stop entry and leaves the file alone", () => {
    const dir = fresh();
    const f = join(dir, "settings.json");
    for (const bad of [`{"hooks":{"Stop":[null]}}`, `{"hooks":{"Stop":[{"hooks":[null]}]}}`, `{"hooks":{"Stop":[{"hooks":"x"}]}}`, `{"hooks":{"Stop":["x"]}}`]) {
      writeFileSync(f, bad);
      expect(() => installHook(f, ours), bad).toThrow(/hooks\.Stop\[0\]/);
      expect(() => uninstallHook(f), bad).toThrow(/hooks\.Stop\[0\]/);
      expect(readFileSync(f, "utf8")).toBe(bad);
    }
  });

  it("run --from claude-code needs --session or --transcript, and rejects unsafe session ids", () => {
    const run = (args: string[]) => {
      try {
        execFileSync("node", [join(ROOT, "dist", "cli.js"), "run", ...args], { env: { ...process.env, EARSHOT_CONFIG: join(home, "hook.yaml") }, stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, err: "" };
      } catch (e) {
        const x = e as { status: number; stderr: Buffer };
        return { code: x.status, err: x.stderr.toString() };
      }
    };
    expect(run(["--from", "claude-code"])).toMatchObject({ code: 2 });
    expect(run(["--from", "claude-code"]).err).toMatch(/needs --session/);
    for (const bad of ["../x", "a/b", "a b", ".."]) expect(run(["--from", "claude-code", "--session", bad]), bad).toMatchObject({ code: 2 });
    expect(run(["--from", "claude-code", "--session", "../x"]).err).toMatch(/letters, digits/);
  });

  it("a superseded brief can never end up ready, in either order", () => {
    const mk = () => {
      const meta = initialMeta(newId(), { from: "claude-code", chars: 1, redacted: 0, truncated: false }, "v");
      createBrief(meta, "x");
      return meta;
    };
    const a = mk();
    expect(failPending(a.id, "superseded")).toBe(true);
    // a late finish must see the verdict under the lock and not overwrite it
    withBriefLock(a.id, () => {
      const onDisk = readMeta(a.id)!;
      expect(onDisk).toMatchObject({ status: "failed", error: "superseded" });
    });
    const b = mk();
    b.status = "ready";
    writeBrief(b, null);
    expect(failPending(b.id, "superseded")).toBe(false);
    expect(readMeta(b.id)!.status).toBe("ready");
  });

  it("the brief lock excludes other processes", () => {
    const m = initialMeta(newId(), { from: "t", chars: 1, redacted: 0, truncated: false }, "v");
    createBrief(m, "x");
    const holder = spawn("node", ["-e", `const fs=require("fs");const p=${JSON.stringify(join(briefDir(m.id), ".lock"))};fs.mkdirSync(p);process.stdout.write("held");setTimeout(()=>{fs.rmdirSync(p)},400)`], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => {
        const t0 = performance.now();
        try {
          withBriefLock(m.id, () => undefined);
          expect(performance.now() - t0).toBeGreaterThan(250);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
