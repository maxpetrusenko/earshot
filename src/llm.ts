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
}

export class LlmError extends Error {}

/**
 * Runs `claude -p` on the Claude subscription login. ANTHROPIC_API_KEY is stripped so a stray
 * key can never turn this into a paid API call. No tools, no session file, no slash commands.
 */
export function claudeCliProvider(cfg: LlmConfig): LlmProvider {
  return {
    name: "claude-cli",
    model: cfg.model,
    complete: (req) =>
      new Promise<string>((resolve, reject) => {
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_BASE_URL;
        const args = [
          "-p",
          "--model", cfg.model,
          "--tools", "",
          "--no-session-persistence",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--mcp-config", '{"mcpServers":{}}',
          "--setting-sources", "",
          "--output-format", "text",
          "--system-prompt", req.system,
        ];
        const child = spawn(cfg.command, args, { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
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
  return {
    name: "openai-compatible",
    model: cfg.model,
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

export function createLlm(cfg: LlmConfig): LlmProvider {
  return cfg.type === "claude-cli" ? claudeCliProvider(cfg) : openAiProvider(cfg);
}
