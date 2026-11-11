import http from "node:http";
import https from "node:https";
import tls from "node:tls";

/**
 * Hosts on this machine, the LAN or the tailnet. An HTTP proxy (NODE_USE_ENV_PROXY with a
 * credential-injecting proxy, for example) cannot reach these, so requests to them go direct.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".ts.net") || h.endsWith(".localhost")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** Trust the OS store as well as Node's bundle: Tailscale certificates use a newer Let's Encrypt chain. */
function trustedCAs(): string[] | undefined {
  try {
    return [...tls.getCACertificates("default"), ...tls.getCACertificates("system")];
  } catch {
    return undefined;
  }
}

const directAgents = { http: new http.Agent(), https: new https.Agent({ ca: trustedCAs() }) };

function directFetch(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const agent = url.protocol === "https:" ? directAgents.https : directAgents.http;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req = lib.request(url, { method: init.method ?? "GET", headers, agent, signal: init.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: h }));
      });
    });
    req.on("error", reject);
    if (init.body !== undefined && init.body !== null) req.write(init.body as string);
    req.end();
  });
}

/** fetch, except private destinations skip any configured HTTP proxy. */
export function netFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  return isPrivateHost(url.hostname) ? directFetch(url, init) : fetch(url, init);
}
