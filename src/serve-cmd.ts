import type { AddressInfo } from "node:net";
import { parseTailscaleStatus, runTailscale } from "./baseurl.js";
import type { Config } from "./config.js";
import { createEarshotServer } from "./serve.js";
import { sweepDead } from "./sweep.js";

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/** Refuse to replace a Tailscale serve handler that points somewhere else. Returns null when safe. */
export function serveConflict(statusJson: string, httpsPort: number, target: string): string | null {
  let st: ServeStatus;
  try {
    st = JSON.parse(statusJson) as ServeStatus;
  } catch {
    return null;
  }
  if (!st.TCP || !(String(httpsPort) in st.TCP)) return null;
  for (const [hostport, web] of Object.entries(st.Web ?? {})) {
    if (!hostport.endsWith(`:${httpsPort}`)) continue;
    const proxy = web.Handlers?.["/"]?.Proxy;
    if (proxy && proxy.replace(/\/$/, "") !== target) {
      return `tailscale serve already routes HTTPS port ${httpsPort} to ${proxy}; set serve.https_port to a free port`;
    }
  }
  return null;
}

/** Loopback or a Tailscale (100.64.0.0/10) address only. Anything else would expose briefs wider than the tailnet. */
export function validateBindHost(host: string): void {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  const loop = h === "localhost" || h === "::1" || (m && m[1] === "127");
  const tailnet = m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  if (!loop && !tailnet) {
    throw new Error(`--host ${host} is not allowed: use loopback (127.0.0.1, ::1, localhost) or a Tailscale address in 100.64.0.0/10`);
  }
}

export function validatePort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer from 1 to 65535 (got ${String(port)})`);
  }
  return port;
}

export interface ServeOverrides {
  host?: string;
  port?: number;
}

export async function startServe(cfg: Config, over: ServeOverrides, log: (l: string) => void): Promise<void> {
  if (over.host !== undefined) validateBindHost(over.host);
  const swept = sweepDead();
  if (swept.length) log(`marked ${swept.length} brief(s) failed: worker died`);
  const port = over.port === undefined ? cfg.serve.port : validatePort(over.port);
  const mode = cfg.serve.mode;
  let host = over.host ?? "127.0.0.1";
  if (mode === "tailnet-ip" && !over.host) {
    const ip = parseTailscaleStatus(await runTailscale(["status", "--json"])).ip4;
    if (!ip) throw new Error("serve.mode tailnet-ip needs a Tailscale IPv4 address; is tailscale up?");
    host = ip;
  }
  const server = await createEarshotServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log(`listening on http://${host}:${(server.address() as AddressInfo).port} (${mode})`);

  let teardown: (() => Promise<void>) | null = null;
  if (mode === "tailscale-serve") {
    const target = `http://127.0.0.1:${port}`;
    const conflict = serveConflict(await runTailscale(["serve", "status", "--json"]), cfg.serve.https_port, target);
    if (conflict) {
      server.close();
      throw new Error(conflict);
    }
    await runTailscale(["serve", "--bg", `--https=${cfg.serve.https_port}`, target]);
    log(`tailscale serve: HTTPS ${cfg.serve.https_port} -> ${target} (tailnet only, no funnel)`);
    teardown = async () => {
      await runTailscale(["serve", `--https=${cfg.serve.https_port}`, "off"]).catch(() => undefined);
    };
  }
  const stop = () => {
    void (async () => {
      await teardown?.();
      server.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
