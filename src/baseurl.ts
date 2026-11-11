import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { earshotHome, type ServeConfig } from "./config.js";

export interface TailscaleInfo {
  dnsName?: string;
  ip4?: string;
}

export class BaseUrlError extends Error {}

/** The base URL comes from the serve block only. It is never guessed from the host name. */
export function resolveBaseUrl(serve: ServeConfig, ts: TailscaleInfo): string {
  switch (serve.mode) {
    case "loopback":
      return `http://localhost:${serve.port}`;
    case "tailnet-ip":
      if (!ts.ip4) throw new BaseUrlError("serve.mode tailnet-ip needs a Tailscale IPv4 address; is tailscale up?");
      return `http://${ts.ip4}:${serve.port}`;
    case "tailscale-serve": {
      if (!ts.dnsName) throw new BaseUrlError("serve.mode tailscale-serve needs the Tailscale DNS name; is tailscale up?");
      const port = serve.https_port === 443 ? "" : `:${serve.https_port}`;
      return `https://${ts.dnsName}${port}`;
    }
  }
}

const BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export function runTailscale(args: string[]): Promise<string> {
  const attempt = (i: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const bin = BINARIES[i];
      if (!bin) return reject(new BaseUrlError("tailscale CLI not found"));
      execFile(bin, args, { timeout: 5000 }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(attempt(i + 1));
        if (err) return reject(new BaseUrlError(`tailscale ${args[0]} failed: ${err.message.split("\n")[0]}`));
        resolve(stdout);
      });
    });
  return attempt(0);
}

export function parseTailscaleStatus(json: string): TailscaleInfo {
  const self = (JSON.parse(json) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
  return {
    dnsName: self?.DNSName?.replace(/\.$/, "") || undefined,
    ip4: self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
  };
}

export async function tailscaleInfo(): Promise<TailscaleInfo> {
  return parseTailscaleStatus(await runTailscale(["status", "--json"]));
}

/** Resolve the base URL for a config, querying Tailscale only when the mode needs it. */
export async function baseUrlFor(serve: ServeConfig): Promise<string> {
  const ts = serve.mode === "loopback" ? {} : await tailscaleInfo();
  return resolveBaseUrl(serve, ts);
}

const CACHE_TTL_MS = 10 * 60_000;

/**
 * baseUrlFor with a small on-disk cache. `tailscale status` costs about 80 ms, which a Stop hook
 * cannot spare. A stale entry is still used when tailscale cannot be reached.
 */
export async function cachedBaseUrl(serve: ServeConfig): Promise<string> {
  if (serve.mode === "loopback") return baseUrlFor(serve);
  const file = join(earshotHome(), "baseurl.json");
  const key = JSON.stringify(serve);
  let hit: { key: string; url: string; ts: number } | null = null;
  try {
    hit = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* no cache yet */
  }
  const fresh = hit && hit.key === key;
  if (fresh && Date.now() - hit!.ts < CACHE_TTL_MS) return hit!.url;
  try {
    const url = await baseUrlFor(serve);
    mkdirSync(earshotHome(), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ key, url, ts: Date.now() }), { mode: 0o600 });
    return url;
  } catch (e) {
    if (fresh) return hit!.url;
    throw e;
  }
}
