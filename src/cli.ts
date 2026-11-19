#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { cachedBaseUrl } from "./baseurl.js";
import { ConfigError, defaultConfigPath, loadConfig, type Config } from "./config.js";
import { formatBytes, pruneBriefs, pruneIfDue, stampPruned } from "./prune.js";
import { startDetached } from "./detach.js";
import { briefLinks, listenLines, listenMarkdown } from "./links.js";
import { prepareBrief } from "./prepare.js";
import { extractLastMessage, findTranscript, isSafeSessionId, normalizeSession } from "./extract/claude-code.js";
import { extractCodexLast, findCodexSession, isSafeCodexId } from "./extract/codex.js";
import { extractStdin, normalizeInput } from "./extract/stdin.js";
import { extractTagged } from "./extract/tagged.js";
import { handleStop, type StopPayload } from "./hook/claude-code.js";
import { handleNotify, parseNotifyArgv } from "./hook/codex.js";
import { touchLock } from "./hook/state.js";
import { claudeDir, install, InstallError, uninstall, type Mode, type Scope } from "./install/claude-code.js";
import { installMod, uninstallMod } from "./install/claude-mod.js";
import { ForeignNotifyError, installCodex, uninstallCodex } from "./install/codex.js";
import { codexHome, cursorHome, cursorSessionOutput, FILE_AGENTS, installAgentsBlock, installCursorHook, installCursorRule, uninstallCursorHook, instructionBin, uninstallAgentsBlock, uninstallCursorRule } from "./install/instructions.js";
import { mcpInstall, mcpUninstall, MCP_CLIENTS, type McpClient } from "./install/mcp.js";
import { netFetch } from "./lib/net.js";
import { createLlm } from "./llm.js";
import { orcaDir } from "./orca.js";
import { classifyReply, shouldAutoVisual, type Classification } from "./situation.js";
import { renderFallbackHtml } from "./explain-fallback.js";
import { redact } from "./redact.js";
import { armOrcaDeadline, EXPLAIN_MIN_CHARS, finishExplain, finishPlayer, orcaLines, orcaOutput, type OrcaJob } from "./orca-output.js";
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
  visual?: boolean;
  audio: boolean;
  json?: boolean;
  format?: string;
  orcaDir?: string;
    dryRun?: boolean;
  config?: string;
}

class UsageError extends Error {}

/** --visual forces the picture on, --no-visual forces it off; otherwise visuals.auto decides from the reply (situation not none, 600+ chars). */
function wantVisual(flag: boolean | undefined, auto: boolean, text: string, cls?: Classification): boolean {
  if (flag !== undefined) return flag;
  return auto && shouldAutoVisual(text, cls);
}

/** Old briefs go at the start of a run, at most once an hour. A failure here never stops the memo. */
function autoPrune(cfg: Config): void {
  try {
    const r = pruneIfDue(cfg.retention);
    if (r && r.deleted.length) log(`pruned ${r.deleted.length} old briefs, freed ${formatBytes(r.freedBytes)}`);
  } catch (e) {
    log(`prune skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runCommand(flags: RunFlags): Promise<number> {
  const runStart = performance.now();
  if (flags.session !== normalizeSession(flags.session)) {
    log("ignoring an empty or unexpanded --session value");
    flags.session = normalizeSession(flags.session);
  }
  if (flags.session !== undefined && !(flags.from === "codex" ? isSafeCodexId(flags.session) : isSafeSessionId(flags.session))) {
    err("earshot: --session may contain only letters, digits, - and _ (max 80 characters)");
    return 2;
  }
  const cfg = loadConfig(flags.config);
  autoPrune(cfg);
  const input = await readInput(flags, cfg.privacy.max_input_chars);
  if (!input.text) {
    err(flags.from === "tagged" ? "earshot: no <narrate>...</narrate> block in the input." : "earshot: no input. Pipe the agent's output in, or pass --file.");
    return 2;
  }
  if (flags.session) touchLock(flags.session);
  if (flags.format !== undefined && flags.format !== "text" && flags.format !== "plain" && flags.format !== "json" && flags.format !== "orca" && flags.format !== "auto") throw new UsageError(`--format must be text, plain, json, orca or auto, got "${flags.format}"`);
  // auto: inside Orca (scratch dir writable) the memo is made by a background worker while the player lines print at once;
  // elsewhere the links print at once with a background memo. orca: the blocking form, waits for the finished audio.
  const auto = flags.format === "auto";
  const scratch = orcaDir(flags.orcaDir);
  const inline = auto && scratch !== null && flags.audio && !flags.dryRun;
  const orca = flags.format === "orca";
  if (auto && !inline) flags.detach = true;
  if (orca && flags.detach) throw new UsageError("--format orca waits for the finished audio, so it cannot be combined with --detach");
  const asJson = flags.json || flags.format === "json";
  const out = (base: string, id: string) => {
    const l = briefLinks(base, id);
    process.stdout.write(asJson ? `${JSON.stringify({ listen: l.listen, listen_original: l.listen_original, card: l.card, id: l.id })}\n` : `${flags.format === "plain" ? listenLines(l) : listenMarkdown(l)}\n`);
  };
  if (inline) {
    // The explain page is still made (card page, optional PNG) when the reply is long enough; it is never printed as a chat line.
    // --visual is the caller asking for a picture: the Explain line prints now and a page is guaranteed behind it.
    const explainOn = flags.sketch && flags.explain && cfg.image.type !== "none";
    const cls = classifyReply(input.text);
    const visual = wantVisual(flags.visual, cfg.visuals.auto, input.text, cls) && explainOn;
    if (flags.visual && !explainOn) log("--visual ignored: the explain stage is off (--no-explain, --no-sketch or image.type none)");
    log(`situation ${cls.situation} (${cls.route}), visual ${visual ? "on" : "off"}`);
    const withExplain = visual || (explainOn && input.text.length >= EXPLAIN_MIN_CHARS);
    const job = startDetached(cfg, input.text, { from: input.from, session: flags.session, configPath: flags.config ? resolve(flags.config) : undefined, orca: { dir: scratch!, explain: withExplain, png: flags.explainPng === true, visual }, log });
    log(`worker pid ${job.pid}, log ${job.log}`);
    process.stdout.write(`${orcaLines(job.prepared.meta.id, await cachedBaseUrl(cfg.serve), visual)}\n`);
    return 0;
  }
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
  // --format orca prints its lines after the audio is complete instead.
  if (!orca) out(base, prep.meta.id);
  let result;
  try {
    result = await executeBrief(cfg, llm, prep, { from: input.from, session: flags.session, title: flags.title, voice: flags.voice, noSketch: !flags.sketch || !flags.explain, explain: orca, visual: orca && wantVisual(flags.visual, cfg.visuals.auto, input.text), situation: classifyReply(input.text).situation, noAudio: !flags.audio, waitForAudio: orca, log });
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
    const line = await orcaOutput(flags.orcaDir, meta.id, base, runStart, flags.explainPng === true, log);
    process.stdout.write(`${line}\n`);
  }
  await healthCheck(base);
  return 0;
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
  .option("--visual", "force the Explain picture on (default: automatic, see visuals.auto): the Explain ::orca-visual line prints at once; the worker writes the model's image, or a deterministic what-changed card when the model draws nothing")
  .option("--no-visual", "force the Explain picture off")
  .option("--no-audio", "skip the audio")
  .option("--json", "same as --format json")
  .option("--format <format>", "text (one markdown line: [Listen](...) · [Original](...)), plain (two Listen: lines), json ({listen, listen_original, card, id}) orca (wait for the audio, write an inline player page for Orca chat, print the ::orca-visual line, then the links) or auto (never waits: in Orca, stand-in player pages and the ::orca-visual lines at once and the worker fills them in; elsewhere the links at once)")
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
  .command("prune")
  .description("delete old briefs from ~/.earshot/briefs: older than retention.days, then the oldest until under retention.max_mb; never a brief under an hour old or still being played, served or made")
  .option("--days <n>", "keep this many days (default retention.days, 7)", (v) => Number(v))
  .option("--max-mb <n>", "size cap in MB (default retention.max_mb, 1024)", (v) => Number(v))
  .option("--dry-run", "show what would be deleted, delete nothing")
  .option("--config <path>", "alternate config file")
  .action((o: { days?: number; maxMb?: number; dryRun?: boolean; config?: string }) => {
    const cfg = loadConfig(o.config);
    const days = o.days ?? cfg.retention.days;
    const max_mb = o.maxMb ?? cfg.retention.max_mb;
    if (!(days > 0) || !(max_mb > 0)) {
      err("earshot: --days and --max-mb must be positive numbers");
      process.exitCode = 2;
      return;
    }
    const r = pruneBriefs({ days, max_mb, dryRun: o.dryRun === true });
    if (!o.dryRun) stampPruned();
    process.stdout.write(`${o.dryRun ? "would delete" : "deleted"} ${r.deleted.length} briefs, ${o.dryRun ? "would free" : "freed"} ${formatBytes(r.freedBytes)}; ${r.keptCount} kept (${formatBytes(r.bytesAfter)} of ${formatBytes(r.bytesBefore)}), ${r.protectedCount} protected as young, served or in progress\n`);
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
  .option("--orca-dir <path>", "write the Orca player page (and explain page) here when the audio is ready")
  .option("--orca-explain", "also make the explain pages (they go on the card page)")
  .option("--explain-png", "with --orca-explain: also render the PNG")
  .option("--orca-visual", "the Explain line is already in the chat: write the explain page (the image or the fallback card) into the Orca dir")
  .option("--config <path>", "alternate config file")
  .action(async (id: string, o: { config?: string; title?: string; orcaDir?: string; orcaExplain?: boolean; explainPng?: boolean; orcaVisual?: boolean }) => {
    const cfg = loadConfig(o.config);
    const prep = loadPrepared(id);
    if (!prep) {
      err(`earshot: brief ${id} is not pending`);
      process.exitCode = 2;
      return;
    }
    const orca: OrcaJob | null = o.orcaDir ? { dir: o.orcaDir, png: o.explainPng === true, visual: o.orcaVisual === true, written: { player: false, explain: false } } : null;
    const fallbackCard = () => renderFallbackHtml(cfg.privacy.redact ? redact(prep.text).text : prep.text);
    const disarm = orca ? armOrcaDeadline(orca, id, fallbackCard, log) : () => undefined;
    let playerDone = false;
    let explainDone = false;
    try {
      const r = await executeBrief(cfg, createLlm(cfg.llm), prep, {
        from: prep.meta.source.from,
        title: o.title,
        log,
        ...(orca ? { explain: o.orcaExplain === true, waitForAudio: true, visual: orca.visual === true } : {}),
        onAudioReady: orca ? (async () => { playerDone = true; await finishPlayer(orca.dir, id, log, orca.written); }) : undefined,
        onExplain: orca ? (async (htmls) => { explainDone = true; await finishExplain(orca, id, htmls, log); }) : undefined,
      });
      log(`${r.meta.status} in ${r.meta.total_ms}ms`);
    } catch (e) {
      if (!(e instanceof NothingUsableError)) throw e;
      err(`earshot: nothing usable was produced: ${e.message}`);
      process.exitCode = 2;
    } finally {
      // A placeholder must never be left asking for a file that will not come.
      disarm();
      if (orca && !playerDone) await finishPlayer(orca.dir, id, log, orca.written);
      // The same for the Explain line printed by --visual: never leave the placeholder, write the card from the reply.
      if (orca?.visual && !explainDone) await finishExplain(orca, id, [renderFallbackHtml(cfg.privacy.redact ? redact(prep.text).text : prep.text)], log);
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
  .command("cursor-session-start", { hidden: true })
  .description("Cursor sessionStart hook: print the earshot instruction as additional_context")
  .action(() => {
    process.stdout.write(`${cursorSessionOutput(instructionBin())}\n`);
  });

program
  .command("install <agent>")
  .description("install into an agent: claude-code (skill, Stop hook or Play button mod), codex (notify program or AGENTS.md instructions), cursor (user sessionStart hook, or a project rule), opencode, gemini, droid (global instruction file), mcp (MCP server config)")
  .option("--mode <mode>", "claude-code: skill, hook or mod (Play button buttons inside Claude Code); codex: notify (default) or instructions (AGENTS.md block that makes Codex print the links)", "skill")
  .option("--scope <scope>", "claude-code: user (~/.claude) or project (./.claude); cursor: user (hook, default) or project (./.cursor/rules); mcp with claude-code: local, project or user")
  .option("--client <client>", "mcp: claude-code, codex or generic")
  .option("--write", "mcp with codex: merge the table into config.toml instead of printing it")
  .option("--bin <cmd>", "how the skill, hook or MCP entry should invoke earshot")
  .action((agent: string, o: { mode: string; scope?: string; client?: string; write?: boolean; bin?: string }) => {
    try {
      if (agent === "claude-code" && o.mode === "mod") {
        printResults(installMod(claudeDir(scopeOf(o.scope ?? "user"), process.cwd())));
      } else if (agent === "claude-code") {
        printResults(install({ mode: modeOf(o.mode), scope: scopeOf(o.scope ?? "user"), bin: o.bin, log: err }));
      } else if (agent === "codex" && o.mode === "instructions") {
        printResults([installAgentsBlock(join(codexHome(), "AGENTS.md"), instructionBin(o.bin))]);
      } else if (agent === "codex") {
        printResults(installCodex({ bin: o.bin }));
      } else if (agent in FILE_AGENTS) {
        printResults([installAgentsBlock(FILE_AGENTS[agent]!(), instructionBin(o.bin))]);
      } else if (agent === "cursor" && o.scope === "project") {
        printResults([installCursorRule(join(process.cwd(), ".cursor"), instructionBin(o.bin))]);
      } else if (agent === "cursor") {
        printResults([installCursorHook(cursorHome(), instructionBin(o.bin))]);
      } else if (agent === "mcp") {
        const r = mcpInstall({ client: clientOf(o.client), bin: o.bin, scope: o.scope, write: o.write });
        if (r.print) process.stdout.write(`${r.print}\n`);
        printResults(r.results);
      } else {
        throw new InstallError(`unknown target "${agent}"; supported: claude-code, codex, cursor, ${Object.keys(FILE_AGENTS).join(", ")}, mcp`);
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
  .option("--scope <scope>", "claude-code or cursor: user or project", "user")
  .option("--client <client>", "mcp: codex (the others are removed in the client)")
  .option("--mode <mode>", "claude-code: mod removes only the Play button mod; codex: instructions removes only the AGENTS.md block; default removes everything")
  .action((agent: string, o: { scope: string; client?: string; mode?: string }) => {
    if (agent === "claude-code" && o.mode === "mod") printResults(uninstallMod(claudeDir(scopeOf(o.scope), process.cwd())));
    else if (agent === "claude-code") printResults(uninstall({ scope: scopeOf(o.scope) }));
    else if (agent === "codex" && o.mode === "instructions") printResults([uninstallAgentsBlock(join(codexHome(), "AGENTS.md"))]);
    else if (agent === "codex") printResults([...uninstallCodex(), uninstallAgentsBlock(join(codexHome(), "AGENTS.md"))]);
    else if (agent in FILE_AGENTS) printResults([uninstallAgentsBlock(FILE_AGENTS[agent]!())]);
    else if (agent === "cursor" && o.scope === "project") printResults([uninstallCursorRule(join(process.cwd(), ".cursor"))]);
    else if (agent === "cursor") printResults([uninstallCursorHook(cursorHome())]);
    else if (agent === "mcp") printResults(mcpUninstall({ client: clientOf(o.client) }));
    else throw new InstallError(`unknown target "${agent}"; supported: claude-code, codex, cursor, ${Object.keys(FILE_AGENTS).join(", ")}, mcp`);
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
