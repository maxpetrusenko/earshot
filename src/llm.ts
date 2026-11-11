import { netFetch } from "./lib/net.js";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolveKey, type LlmConfig } from "./config.js";

export interface LlmRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object where it supports that. */
  json?: boolean;
}

export interface LlmProvider {
  name: string;
  model: string;
  complete(req: LlmRequest): Promise<string>;
  /** Text as it is generated. Stopping iteration early cancels the request. Optional: callers fall back to complete(). */
  stream?(req: LlmRequest): AsyncGenerator<string, void>;
}

/** The stream of a provider, or its whole answer as one piece when it cannot stream. */
export async function* streamOrComplete(llm: LlmProvider, req: LlmRequest): AsyncGenerator<string, void> {
  if (llm.stream) yield* llm.stream(req);
  else yield await llm.complete(req);
}

export class LlmError extends Error {}

/**
 * Runs `claude -p` on the Claude subscription login. ANTHROPIC_API_KEY is stripped so a stray
 * key can never turn this into a paid API call. No tools, no session file, no slash commands.
 */
export function claudeArgs(cfg: LlmConfig, system: string, format: "text" | "stream-json"): string[] {
  return [
    "-p",
    "--model", cfg.model,
    "--tools", "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--output-format", format,
    ...(format === "stream-json" ? ["--verbose", "--include-partial-messages"] : []),
    "--system-prompt", system,
  ];
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** The text of one stream-json line: a text delta, the final result (fallback), or null. */
export function claudeStreamText(line: string): { delta?: string; result?: string } | null {
  let ev: { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; result?: unknown; is_error?: boolean };
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta" && ev.event.delta.text) {
    return { delta: ev.event.delta.text };
  }
  if (ev.type === "result" && typeof ev.result === "string" && !ev.is_error) return { result: ev.result };
  return null;
}

export function claudeCliProvider(cfg: LlmConfig): LlmProvider {
  return {
    name: "claude-cli",
    model: cfg.model,
    async *stream(req) {
      const child = spawn(cfg.command, claudeArgs(cfg, req.system, "stream-json"), { env: cleanEnv(), cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdin.on("error", () => undefined);
      child.stdin.end(req.user);
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on("error", (e) => reject(new LlmError(`claude-cli failed to start: ${e.message}`)));
        child.on("close", (code) => resolve(code));
      });
      closed.catch(() => undefined);
      const timer = setTimeout(() => child.kill("SIGKILL"), cfg.timeout_s * 1000);
      let sawDelta = false;
      let fallback = "";
      let buf = "";
      try {
        for await (const chunk of child.stdout) {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const t = claudeStreamText(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            if (t?.delta) {
              sawDelta = true;
              yield t.delta;
            } else if (t?.result) fallback = t.result;
          }
        }
        const t = claudeStreamText(buf);
        if (t?.result) fallback = t.result;
        const code = await closed;
        if (code !== 0 && !sawDelta) throw new LlmError(`claude-cli exited ${code}: ${err.trim().slice(0, 200) || "no output"}`);
        if (!sawDelta) {
          if (!fallback) throw new LlmError("claude-cli returned no text");
          yield fallback;
        }
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    complete: (req) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(cfg.command, claudeArgs(cfg, req.system, "text"), { env: cleanEnv(), cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new LlmError(`claude-cli timed out after ${cfg.timeout_s}s`));
        }, cfg.timeout_s * 1000);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new LlmError(`claude-cli failed to start: ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && out.trim()) resolve(out);
          else reject(new LlmError(`claude-cli exited ${code}: ${err.trim().slice(0, 200) || "no output"}`));
        });
        child.stdin.on("error", () => undefined); // early exit: the close handler reports it
        child.stdin.end(req.user);
      }),
  };
}

export function openAiProvider(cfg: LlmConfig): LlmProvider {
  const key = resolveKey(cfg.api_key_env);
  const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const messages = (req: LlmRequest) => [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  return {
    name: "openai-compatible",
    model: cfg.model,
    async *stream(req) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), cfg.timeout_s * 1000);
      try {
        const res = await netFetch(`${cfg.base_url.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: cfg.model, temperature: 0.3, stream: true, ...(req.json ? { response_format: { type: "json_object" } } : {}), messages: messages(req) }),
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) throw new LlmError(`llm HTTP ${res.status}`);
        const type = res.headers.get("content-type") ?? "";
        if (/application\/json/i.test(type)) {
          // The server ignored stream:true and answered whole.
          const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const text = body.choices?.[0]?.message?.content;
          if (!text) throw new LlmError("llm returned no content");
          yield text;
          return;
        }
        let buf = "";
        let any = false;
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            const delta = sseDelta(line);
            if (delta === null) return;
            if (delta) {
              any = true;
              yield delta;
            }
          }
        }
        if (!any) throw new LlmError("llm returned no content");
      } finally {
        clearTimeout(timer);
        ctl.abort();
      }
    },
    complete: async (req) => {
      const res = await netFetch(`${cfg.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.3,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeout_s * 1000),
      });
      if (!res.ok) throw new LlmError(`llm HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new LlmError("llm returned no content");
      return text;
    },
  };
}

/** One SSE line: the text delta, "" for a line with none, null for [DONE]. */
export function sseDelta(line: string): string | null {
  if (!line.startsWith("data:")) return "";
  const data = line.slice(5).trim();
  if (data === "[DONE]") return null;
  try {
    return (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

export function createLlm(cfg: LlmConfig): LlmProvider {
  return cfg.type === "claude-cli" ? claudeCliProvider(cfg) : openAiProvider(cfg);
}
