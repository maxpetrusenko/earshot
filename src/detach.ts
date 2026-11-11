import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { earshotHome } from "./config.js";
import { recordWorker } from "./bundle.js";
import { prepareBrief, type Prepared } from "./prepare.js";

export const logsDir = () => join(earshotHome(), "logs");

/** argv for running this CLI: the built file when it exists, else tsx on the TypeScript source. */
export function cliCommand(): string[] {
  const js = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(js)) return [process.execPath, js];
  return [process.execPath, "--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url))];
}

export interface Detached {
  prepared: Prepared;
  pid: number | null;
  log: string;
}

/**
 * Write the pending brief, then start `earshot worker <id>` in its own session. The worker's
 * stdio is a log file and the child is unref'd, so the caller (a Stop hook) can exit at once:
 * Claude Code waits for EOF on a hook's stdout and stderr, which a child holding them would delay.
 */
export function startDetached(cfg: Config, raw: string, o: { from: string; session?: string; title?: string; evidence?: string; configPath?: string; log?: (l: string) => void }): Detached {
  const prepared = prepareBrief(cfg, raw, o);
  mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
  const log = join(logsDir(), `${prepared.meta.id}.log`);
  const fd = openSync(log, "a", 0o600);
  const [bin, ...args] = cliCommand() as [string, ...string[]];
  try {
    const child = spawn(bin, [...args, "worker", prepared.meta.id, ...(o.title ? [`--title=${o.title}`] : []), ...(o.configPath ? ["--config", o.configPath] : [])], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.on("error", () => undefined);
    child.unref();
    if (child.pid) {
      try {
        recordWorker(prepared.meta.id, child.pid);
        prepared.meta.worker_pid = child.pid;
      } catch {
        /* the sweep then has no pid to check; the brief itself is unaffected */
      }
    }
    return { prepared, pid: child.pid ?? null, log };
  } finally {
    closeSync(fd);
  }
}
