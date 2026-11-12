#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { cachedBaseUrl } from "./baseurl.js";
import { ConfigError, defaultConfigPath, loadConfig } from "./config.js";
import { startDetached } from "./detach.js";
import { briefLinks, listenLines, listenMarkdown } from "./links.js";
import { prepareBrief } from "./prepare.js";
import { extractLastMessage, findTranscript, isSafeSessionId } from "./extract/claude-code.js";
import { extractCodexLast, findCodexSession, isSafeCodexId } from "./extract/codex.js";
import { extractStdin, normalizeInput } from "./extract/stdin.js";
import { extractTagged } from "./extract/tagged.js";
import { handleStop, type StopPayload } from "./hook/claude-code.js";
import { handleNotify, parseNotifyArgv } from "./hook/codex.js";
import { touchLock } from "./hook/state.js";
import { install, InstallError, uninstall, type Mode, type Scope } from "./install/claude-code.js";
import { ForeignNotifyError, installCodex, uninstallCodex } from "./install/codex.js";
import { mcpInstall, mcpUninstall, MCP_CLIENTS, type McpClient } from "./install/mcp.js";
import { netFetch } from "./lib/net.js";
import { createLlm } from "./llm.js";
import { fitOrcaPage, orcaDir, orcaLine, writeOrcaPage } from "./orca.js";
import { explainPng } from "./explain-png.js";
import { readFileInBundle, readMeta } from "./bundle.js";
import { flushTracing } from "./lib/llm-tracing.js";
import { dryRun, executeBrief, loadPrepared, NothingUsableError } from "./run.js";
import { startServe } from "./serve-cmd.js";

const err = (line: string) => process.stderr.write(`${line}\n`);
const log = (line: string) => err(`[earshot] ${line}`);

async function healthCheck(base: string): Promise<void> {
  try {
    const res = await netFetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    log(`warning: ${base}/healthz is not reachable (${(e as Error).message}). Start it with: earshot serve`);
  }
}

/** Raw input. Truncation happens in the pipeline so meta can record it. */
async function readInput(flags: RunFlags, maxChars: number): Promise<{ text: string; from: string }> {
  const label = flags.from ?? "";
  if (label && !FROM_VALUES.includes(label)) throw new UsageError(`--from must be one of ${FROM_VALUES.join(", ")}, got "${label}"`);
  if (flags.file) return { text: tagOrRaw(label, normalizeInput(readFileSync(flags.file, "utf8"))), from: label || "file" };
  if (!process.stdin.isTTY) {
    const text = tagOrRaw(label, (await extractStdin(process.stdin, maxChars)).text);
    if (text || (label !== "claude-code" && label !== "codex")) return { text, from: label || "stdin" };
  }
  if (label === "claude-code") {
    if (!flags.transcript && !flags.session) throw new UsageError("--from claude-code needs --session <id> or --transcript <path> when nothing is piped");
    const path = flags.transcript ?? findTranscript(process.cwd(), flags.session!);
    const turn = path ? await extractLastMessage(path) : null;
    return { text: turn?.text ?? "", from: label };
  }
  if (label === "codex") {
    if (!flags.transcript && !flags.session) throw new UsageError("--from codex needs --session <id> (or --transcript <rollout file>) when nothing is piped");
    const path = flags.transcript ?? findCodexSession(flags.session!);
    const turn = path ? await extractCodexLast(path) : null;
    return { text: turn?.text ?? "", from: label };
  }
  return { text: "", from: label || "stdin" };
}

const FROM_VALUES = ["stdin", "claude-code", "codex", "tagged"];

/** --from tagged keeps only the last <narrate> block; other sources pass through unchanged. */
const tagOrRaw = (label: string, text: string) => (label === "tagged" ? (extractTagged(text) ?? "") : text);

interface RunFlags {
  file?: string;
  from?: string;
  session?: string;
  transcript?: string;
  detach?: boolean;
  title?: string;
  voice?: string;
  sketch: boolean;
  explain: boolean;
  explainPng?: boolean;
  audio: boolean;
  json?: boolean;
  format?: string;
  orcaDir?: string;
    dryRun?: boolean;
  config?: string;
}

class UsageError extends Error {}

async function runCommand(flags: RunFlags): Promise<number> {
  const runStart = performance.now();
  if (flags.session !== undefined && !(flags.from === "codex" ? isSafeCodexId(flags.session) : isSafeSessionId(flags.session))) {
    err("earshot: --session may contain only letters, digits, - and _ (max 80 characters)");
    return 2;
  }
  const cfg = loadConfig(flags.config);
  const input = await readInput(flags, cfg.privacy.max_input_chars);
  if (!input.text) {
    err(flags.from === "tagged" ? "earshot: no <narrate>...</narrate> block in the input." : "earshot: no input. Pipe the agent's output in, or pass --file.");
    return 2;
  }
  if (flags.session) touchLock(flags.session);
  if (flags.format !== undefined && flags.format !== "text" && flags.format !== "plain" && flags.format !== "json" && flags.format !== "orca" && flags.format !== "auto") throw new UsageError(`--format must be text, plain, json, orca or auto, got "${flags.format}"`);
  // auto: the Orca player plus the links when the Orca scratch dir is writable, else the links at once with a background memo.
  const auto = flags.format === "auto";
  const orca = flags.format === "orca" || (auto && orcaDir(flags.orcaDir) !== null);
  if (auto && !orca) flags.detach = true;
  if (flags.format === "orca" && flags.detach) throw new UsageError("--format orca waits for the finished audio, so it cannot be combined with --detach");
  const asJson = flags.json || flags.format === "json";
  const out = (base: string, id: string) => {
    const l = briefLinks(base, id);
    process.stdout.write(asJson ? `${JSON.stringify({ listen: l.listen, listen_original: l.listen_original, card: l.card, id: l.id })}\n` : `${flags.format === "plain" ? listenLines(l) : listenMarkdown(l)}\n`);
  };
  if (flags.detach) {
    const job = startDetached(cfg, input.text, { from: input.from, session: flags.session, configPath: flags.config ? resolve(flags.config) : undefined, log });
    log(`worker pid ${job.pid}, log ${job.log}`);
    out(await cachedBaseUrl(cfg.serve), job.prepared.meta.id);
    return 0;
  }
  const llm = createLlm(cfg.llm);
  if (flags.dryRun) {
    const ear = await dryRun(cfg, llm, input.text, log);
    process.stdout.write(`${ear.title}\n\n${ear.script}\n\n${ear.mermaid || "no diagram"}\n`);
    log(`${ear.words} words, ${ear.retries} retries`);
    return 0;
  }
  const prep = prepareBrief(cfg, input.text, { from: input.from, session: flags.session, log });
  const base = await cachedBaseUrl(cfg.serve);
  // The links go out before any work: the server streams each track while it is still being made.
  // Orca mode prints one line after the audio is complete instead.
  if (!orca) out(base, prep.meta.id);
  let result;
  try {
    result = await executeBrief(cfg, llm, prep, { from: input.from, session: flags.session, title: flags.title, voice: flags.voice, noSketch: !flags.sketch || !flags.explain, explain: orca, noAudio: !flags.audio, waitForAudio: orca, log });
  } catch (e) {
    if (e instanceof NothingUsableError) {
      err(`earshot: nothing usable was produced: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const { meta, dir } = result;
  const timings = meta.stages.map((s) => `${s.name}=${s.ms}ms`).join(" ");
  const first = (["edited", "original"] as const).map((t) => `${t}=${meta.tracks?.[t]?.first_audio_ms ?? "n/a"}ms`).join(" ");
  log(`${meta.status} in ${meta.total_ms}ms (${timings}); bundle ${dir}`);
  log(`time to first audio: ${first}`);
  if (orca) {
    const line = await orcaOutput(flags.orcaDir, meta.id, base, runStart, flags.explainPng === true);
    process.stdout.write(`${line}\n`);
  }
  await healthCheck(base);
  return 0;
}

/** Orca mode: the inline player line, then the markdown links for the phone. Links only when a page cannot be made. */
async function orcaOutput(orcaFlag: string | undefined, id: string, base: string, runStart: number, png: boolean): Promise<string> {
  const links = briefLinks(base, id);
  const fallback = (why: string) => {
    log(`orca: ${why}; printing the markdown Listen line`);
    return listenMarkdown(links);
  };
  const dir = orcaDir(orcaFlag);
  if (!dir) return fallback("ORCA_CHAT_SCRATCH_DIR is unset or not a writable directory");
  const meta = readMeta(id);
  const edited = meta?.tracks?.edited.status === "ready" ? readFileInBundle(id, "edited.mp3") : null;
  if (!edited) return fallback("the edited track is not ready");
  const original = meta?.tracks?.original.status === "ready" ? readFileInBundle(id, "original.mp3") : null;
  try {
    const t = performance.now();
    const explainHtml = readFileInBundle(id, "explain.html")?.toString("utf8") ?? null;
    const fit = await fitOrcaPage(edited, original, { editedSeconds: meta?.tracks?.edited.duration_s ?? undefined, originalSeconds: meta?.tracks?.original.duration_s ?? undefined });
    log(`orca encode ${Math.round(performance.now() - t)}ms`);
    const file = writeOrcaPage(dir, id, fit.html, "player");
    // The explain page is its own display-only visual, and only a change worth a picture has one.
    const explain = explainHtml ? writeOrcaPage(dir, id, explainHtml, "explain") : null;
    log(`orca page ${file}: ${fit.bytes} bytes at ${fit.kbps}k${fit.droppedOriginal ? ", original dropped" : ""}; explain ${explain ?? "none"}; ${Math.round(performance.now() - runStart)}ms from start to line`);
    if (explain && png) {
      try {
        log(`explain png ${await explainPng(explainHtml!, join(dir, explain.replace(/\.html$/, ".png")))}`);
      } catch (e) {
        log(`explain png failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return [orcaLine(file), ...(explain ? [orcaLine(explain, "Explain")] : []), listenMarkdown(links)].join("\n");
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

const program = new Command();
program.name("earshot").description("Turn an agent's finished work into a voice memo and a sketch.");

program
  .command("init")
  .description("write a starter config")
  .option("--force", "overwrite an existing config")
  .action((o: { force?: boolean }) => {
    const path = defaultConfigPath();
    if (existsSync(path) && !o.force) {
      err(`earshot: ${path} already exists (use --force to overwrite)`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(new URL("../config.example.yaml", import.meta.url)));
    err(`Wrote ${path}`);
    err('Next: start a Kokoro-FastAPI server, then run: echo "<agent output>" | earshot run');
  });

program
  .command("run")
  .description("make a memo from piped text and print its two Listen links at once")
  .option("--file <path>", "read text from a file")
  .option("--from <name>", "stdin, claude-code, codex or tagged; claude-code and codex read that session's last message when nothing is piped; tagged takes the last <narrate> block")
  .option("--session <id>", "agent session id (claude-code or codex lookup, double-memo lock)")
  .option("--transcript <path>", "explicit Claude Code transcript or Codex rollout path")
  .option("--detach", "print the link now and finish the memo in a background process")
  .option("--title <text>", "override the generated title")
  .option("--voice <name>", "override tts.voice")
  .option("--no-sketch", "skip every picture (same as --no-explain)")
  .option("--no-explain", "skip the visual explanation page")
  .option("--explain-png", "also render the explanation as a 1080x1350 PNG next to the page (needs playwright and a Chromium)")
  .option("--no-audio", "skip the audio")
  .option("--json", "same as --format json")
  .option("--format <format>", "text (one markdown line: [Listen](...) · [Original](...)), plain (two Listen: lines), json ({listen, listen_original, card, id}) orca (wait for the audio, write an inline player page for Orca chat, print the ::orca-visual line, then the links) or auto (orca when ORCA_CHAT_SCRATCH_DIR is writable, else links at once)")
  .option("--orca-dir <path>", "where --format orca writes the page (default $ORCA_CHAT_SCRATCH_DIR)")
  .option("--dry-run", "scrub and ear-script only; print the script")
  .option("--config <path>", "alternate config file")
  .action(async (flags: RunFlags) => {
    try {
      process.exitCode = await runCommand(flags);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      err(`earshot: ${e.message}`);
      process.exitCode = 2;
    }
  });

program
  .command("serve")
  .description("serve ~/.earshot/briefs")
  .option("--host <host>", "bind address override")
  .option("--port <port>", "port override", (v) => Number(v))
  .option("--config <path>", "alternate config file")
  .action(async (o: { host?: string; port?: number; config?: string }) => {
    await startServe(loadConfig(o.config), { host: o.host, port: o.port }, log);
  });

program
  .command("worker <id>", { hidden: true })
  .description("finish a pending brief (started by --detach and the Stop hook)")
  .option("--title <text>", "title override (from the MCP narrate tool)")
  .option("--config <path>", "alternate config file")
  .action(async (id: string, o: { config?: string; title?: string }) => {
    const cfg = loadConfig(o.config);
    const prep = loadPrepared(id);
    if (!prep) {
      err(`earshot: brief ${id} is not pending`);
      process.exitCode = 2;
      return;
    }
    try {
      const r = await executeBrief(cfg, createLlm(cfg.llm), prep, { from: prep.meta.source.from, title: o.title, log });
      log(`${r.meta.status} in ${r.meta.total_ms}ms`);
    } catch (e) {
      if (!(e instanceof NothingUsableError)) throw e;
      err(`earshot: nothing usable was produced: ${e.message}`);
      process.exitCode = 2;
    }
  });

program
  .command("hook <agent> [payload]")
  .description("agent hook entry point: claude-code reads the Stop payload on stdin; codex takes the notify JSON as an argument")
  .action(async (agent: string, payload?: string) => {
    if (agent === "codex") {
      const p = payload ? parseNotifyArgv([payload]) : null;
      process.stdout.write(`${JSON.stringify(p ? await handleNotify(p) : {})}\n`);
      return;
    }
    if (agent !== "claude-code") throw new Error(`unknown agent "${agent}"; supported: claude-code, codex`);
    let stop: StopPayload = {};
    try {
      stop = JSON.parse(await extractRaw()) as StopPayload;
    } catch {
      /* nothing to narrate */
    }
    process.stdout.write(`${JSON.stringify(await handleStop(stop))}\n`);
  });

program
  .command("mcp")
  .description("stdio MCP server with the narrate and brief_status tools")
  .action(async () => {
    const { serveStdio } = await import("./mcp/server.js");
    await serveStdio();
  });

const scopeOf = (v: string): Scope => {
  if (v !== "user" && v !== "project") throw new InstallError(`--scope must be user or project, got "${v}"`);
  return v;
};
const modeOf = (v: string): Mode => {
  if (v !== "skill" && v !== "hook") throw new InstallError(`--mode must be skill or hook, got "${v}"`);
  return v;
};

const printResults = (rs: { note: string; path: string; backup: string | null }[]) => {
  for (const r of rs) {
    err(`${r.note}: ${r.path}`);
    if (r.backup) err(`backup: ${r.backup}`);
  }
};

const clientOf = (v: string | undefined): McpClient => {
  if (!v || !MCP_CLIENTS.includes(v as McpClient)) throw new InstallError(`--client must be one of ${MCP_CLIENTS.join(", ")}`);
  return v as McpClient;
};

program
  .command("install <agent>")
  .description("install into an agent: claude-code (skill or Stop hook), codex (notify program), mcp (MCP server config)")
  .option("--mode <mode>", "claude-code: skill or hook", "skill")
  .option("--scope <scope>", "claude-code: user (~/.claude) or project (./.claude); mcp with claude-code: local, project or user")
  .option("--client <client>", "mcp: claude-code, codex or generic")
  .option("--write", "mcp with codex: merge the table into config.toml instead of printing it")
  .option("--bin <cmd>", "how the skill, hook or MCP entry should invoke earshot")
  .action((agent: string, o: { mode: string; scope?: string; client?: string; write?: boolean; bin?: string }) => {
    try {
      if (agent === "claude-code") {
        printResults(install({ mode: modeOf(o.mode), scope: scopeOf(o.scope ?? "user"), bin: o.bin, log: err }));
      } else if (agent === "codex") {
        printResults(installCodex({ bin: o.bin }));
      } else if (agent === "mcp") {
        const r = mcpInstall({ client: clientOf(o.client), bin: o.bin, scope: o.scope, write: o.write });
        if (r.print) process.stdout.write(`${r.print}\n`);
        printResults(r.results);
      } else {
        throw new InstallError(`unknown target "${agent}"; supported: claude-code, codex, mcp`);
      }
    } catch (e) {
      if (!(e instanceof ForeignNotifyError)) throw e;
      err(`earshot: ${e.message}`);
      process.exitCode = 1;
    }
  });

program
  .command("uninstall <agent>")
  .description("remove what `install` added")
  .option("--scope <scope>", "claude-code: user or project", "user")
  .option("--client <client>", "mcp: codex (the others are removed in the client)")
  .action((agent: string, o: { scope: string; client?: string }) => {
    if (agent === "claude-code") printResults(uninstall({ scope: scopeOf(o.scope) }));
    else if (agent === "codex") printResults(uninstallCodex());
    else if (agent === "mcp") printResults(mcpUninstall({ client: clientOf(o.client) }));
    else throw new InstallError(`unknown target "${agent}"; supported: claude-code, codex, mcp`);
  });

async function extractRaw(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  await program.parseAsync(process.argv);
} catch (e) {
  err(`earshot: ${e instanceof ConfigError || e instanceof InstallError || e instanceof Error ? e.message : String(e)}`);
  process.exitCode = process.exitCode || 1;
}
await flushTracing();
