import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failPending, SUPERSEDED } from "../bundle.js";
import { earshotHome } from "../config.js";

/** Per-session state: the newest-wins job queue and the skill/hook double-memo lock. */

export const LOCK_WINDOW_MS = 30_000;
const MAX_JOB_AGE_MS = 15 * 60_000;

const dirFor = (kind: "queue" | "locks") => {
  const d = join(earshotHome(), kind);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

/** Session ids come from outside; never let one become a path. */
export function sessionKey(session: string): string {
  return /^[A-Za-z0-9_-]{1,80}$/.test(session) ? session : createHash("sha256").update(session).digest("hex").slice(0, 32);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

interface Job {
  id: string;
  pid: number | null;
  ts: number;
}

/** True when pid is alive and its command line looks like an earshot worker (guards against pid reuse). */
export function isWorker(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000 });
    return /earshot|cli\.(?:js|ts)/.test(cmd) && /\bworker\b/.test(cmd);
  } catch {
    return false;
  }
}

/**
 * Newest wins per session. The previous job, if still pending, ends as failed with
 * "superseded" and its worker is stopped. Then the new job is recorded.
 */
export function enqueue(session: string, job: Job): { superseded: string | null } {
  const file = join(dirFor("queue"), `${sessionKey(session)}.json`);
  const prev = readJson<Job>(file);
  let superseded: string | null = null;
  if (prev && prev.id !== job.id && Date.now() - prev.ts < MAX_JOB_AGE_MS && failPending(prev.id, SUPERSEDED)) {
    superseded = prev.id;
    if (prev.pid && isWorker(prev.pid)) {
      try {
        process.kill(prev.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  writeJson(file, job);
  return { superseded };
}

/** Skill-mode runs call this; the hook then skips the same session for 30 seconds. */
export function touchLock(session: string): void {
  writeJson(join(dirFor("locks"), `${sessionKey(session)}.json`), { ts: Date.now() });
}

export function lockedRecently(session: string, now = Date.now()): boolean {
  const l = readJson<{ ts: number }>(join(dirFor("locks"), `${sessionKey(session)}.json`));
  return !!l && now - l.ts < LOCK_WINDOW_MS;
}
