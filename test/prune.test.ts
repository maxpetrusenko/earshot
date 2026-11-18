import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createEarshotServer } from "../src/serve.js";
import { markServed, pruneBriefs, pruneIfDue, PRUNE_INTERVAL_MS } from "../src/prune.js";

const DAY = 86_400_000;
const MB = 1024 * 1024;
let home: string;
let prevHome: string | undefined;
let n = 0;
const id = () => `${String(++n).padStart(4, "0")}abcdefghijkl`; // 16 base62 chars

/** A brief of `mb` megabytes made `ageMs` ago. */
function brief(ageMs: number, mb = 0.1, extra: Record<string, unknown> = {}): string {
  const bid = id();
  const dir = join(home, "briefs", bid);
  mkdirSync(dir, { recursive: true });
  const t = (Date.now() - ageMs) / 1000;
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: bid, created_at: new Date(Date.now() - ageMs).toISOString(), status: "ready", ...extra }));
  writeFileSync(join(dir, "edited.mp3"), Buffer.alloc(Math.round(mb * MB)));
  for (const f of ["meta.json", "edited.mp3"]) utimesSync(join(dir, f), t, t);
  utimesSync(dir, t, t);
  return bid;
}
const has = (bid: string) => existsSync(join(home, "briefs", bid));
const R = { days: 7, max_mb: 1024 };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-prune-"));
  mkdirSync(join(home, "briefs"));
  prevHome = process.env.EARSHOT_HOME;
  process.env.EARSHOT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.EARSHOT_HOME;
  else process.env.EARSHOT_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("retention config", () => {
  it("defaults to 7 days and 1 GB, and reads config.yaml", () => {
    expect(parseConfig("").retention).toEqual({ days: 7, max_mb: 1024 });
    expect(parseConfig("retention:\n  days: 3\n  max_mb: 200\n").retention).toEqual({ days: 3, max_mb: 200 });
  });
  it("rejects a bad value and an unknown key", () => {
    expect(() => parseConfig("retention:\n  days: 0\n")).toThrow(/retention.days/);
    expect(() => parseConfig("retention:\n  keep: 1\n")).toThrow(/retention.keep/);
  });
});

describe("pruneBriefs", () => {
  it("deletes briefs older than the retention days and keeps newer ones", () => {
    const old = brief(8 * DAY);
    const fresh = brief(2 * DAY);
    const r = pruneBriefs(R);
    expect(r.deleted).toEqual([old]);
    expect(has(old)).toBe(false);
    expect(has(fresh)).toBe(true);
    expect(r.freedBytes).toBeGreaterThan(0.09 * MB);
  });

  it("honors a configured number of days", () => {
    const b = brief(2 * DAY);
    expect(pruneBriefs({ days: 1, max_mb: 1024 }).deleted).toEqual([b]);
  });

  it("over the size cap deletes the oldest first until it fits", () => {
    const a = brief(5 * DAY, 1);
    const b = brief(4 * DAY, 1);
    const c = brief(3 * DAY, 1);
    const r = pruneBriefs({ days: 7, max_mb: 2.5 });
    expect(r.deleted).toEqual([a]);
    expect([has(a), has(b), has(c)]).toEqual([false, true, true]);
    expect(r.bytesAfter).toBeLessThanOrEqual(2.5 * MB);
  });

  it("never deletes a brief under an hour old, even over the cap", () => {
    const young = brief(10 * 60_000, 2);
    const older = brief(3 * 60 * 60_000, 2);
    const r = pruneBriefs({ days: 7, max_mb: 1 });
    expect(has(young)).toBe(true);
    expect(has(older)).toBe(false);
    expect(r.protectedCount).toBe(1);
    expect(r.bytesAfter).toBeGreaterThan(1 * MB); // still over the cap: protected beats the cap
  });

  it("never deletes a brief past the retention that was served within the hour, and does once that is stale", () => {
    const b = brief(30 * DAY);
    markServed(b);
    expect(pruneBriefs(R).deleted).toEqual([]);
    expect(has(b)).toBe(true);
    const old = (Date.now() - 2 * 60 * 60_000) / 1000;
    utimesSync(join(home, "briefs", b, ".served"), old, old);
    utimesSync(join(home, "briefs", b), old, old);
    expect(pruneBriefs(R).deleted).toEqual([b]);
  });

  it("never deletes a brief whose worker is still running", () => {
    const live = brief(30 * DAY, 0.1, { status: "pending", worker_pid: 4242 });
    const dead = brief(30 * DAY, 0.1, { status: "pending", worker_pid: 4243 });
    const r = pruneBriefs({ ...R, alive: (pid) => pid === 4242 });
    expect(has(live)).toBe(true);
    expect(has(dead)).toBe(false);
    expect(r.protectedCount).toBe(1);
  });

  it("dry run deletes nothing but reports the same result", () => {
    const old = brief(9 * DAY);
    const r = pruneBriefs({ ...R, dryRun: true });
    expect(r.deleted).toEqual([old]);
    expect(has(old)).toBe(true);
  });

  it("ignores folders that are not briefs and clears a leftover .prune- folder", () => {
    mkdirSync(join(home, "briefs", "not-a-brief"));
    mkdirSync(join(home, "briefs", ".prune-leftover"));
    pruneBriefs(R);
    expect(existsSync(join(home, "briefs", "not-a-brief"))).toBe(true);
    expect(existsSync(join(home, "briefs", ".prune-leftover"))).toBe(false);
  });

  it("copes with a missing briefs folder", () => {
    rmSync(join(home, "briefs"), { recursive: true });
    expect(pruneBriefs(R).deleted).toEqual([]);
  });
});

describe("pruneIfDue", () => {
  it("runs once, then not again within the hour, then again after it", () => {
    const old = brief(9 * DAY);
    expect(pruneIfDue(R)?.deleted).toEqual([old]);
    const old2 = brief(9 * DAY);
    expect(pruneIfDue(R)).toBeNull();
    expect(has(old2)).toBe(true);
    const past = (Date.now() - PRUNE_INTERVAL_MS - 1000) / 1000;
    utimesSync(join(home, ".prune-stamp"), past, past);
    expect(pruneIfDue(R)?.deleted).toEqual([old2]);
  });
});

describe("the server marks what it serves", () => {
  it("a request for a brief protects it from a prune that follows", async () => {
    const b = brief(30 * DAY);
    const server = await createEarshotServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/b/${b}/meta.json`, { headers: { Connection: "close" } });
      expect(res.status).toBe(200);
      expect(statSync(join(home, "briefs", b, ".served")).isFile()).toBe(true);
      expect(pruneBriefs(R).deleted).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("earshot prune command", () => {
  const run = (args: string[]) => spawnSync("npx", ["tsx", "src/cli.ts", ...args], { env: { ...process.env, EARSHOT_HOME: home, EARSHOT_CONFIG: join(home, "none.yaml") }, cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  it("prunes with its flags, prints what it freed and stamps the run", () => {
    writeFileSync(join(home, "none.yaml"), "retention:\n  days: 7\n  max_mb: 1024\n");
    const old = brief(9 * DAY, 1);
    const keep = brief(1 * DAY, 1);
    const dry = run(["prune", "--dry-run"]);
    expect(dry.stdout).toMatch(/^would delete 1 briefs, would free 1\.0 MB; 1 kept/);
    expect(has(old)).toBe(true);
    const r = run(["prune"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^deleted 1 briefs, freed 1\.0 MB; 1 kept/);
    expect(has(old)).toBe(false);
    expect(has(keep)).toBe(true);
    expect(existsSync(join(home, ".prune-stamp"))).toBe(true);
    expect(run(["prune", "--days", "0"]).status).toBe(2);
  }, 60000);

  it("earshot run prunes at its start, once an hour", () => {
    writeFileSync(join(home, "none.yaml"), "");
    const old = brief(9 * DAY);
    const first = spawnSync("npx", ["tsx", "src/cli.ts", "run"], { env: { ...process.env, EARSHOT_HOME: home, EARSHOT_CONFIG: join(home, "none.yaml") }, cwd: join(import.meta.dirname, ".."), encoding: "utf8", input: "" });
    expect(first.stderr).toMatch(/pruned 1 old briefs, freed/);
    expect(has(old)).toBe(false);
    const old2 = brief(9 * DAY);
    const second = spawnSync("npx", ["tsx", "src/cli.ts", "run"], { env: { ...process.env, EARSHOT_HOME: home, EARSHOT_CONFIG: join(home, "none.yaml") }, cwd: join(import.meta.dirname, ".."), encoding: "utf8", input: "" });
    expect(second.stderr).not.toMatch(/pruned/);
    expect(has(old2)).toBe(true); // the stamp says an hour has not passed
  }, 60000);
});
