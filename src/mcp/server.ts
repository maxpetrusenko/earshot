import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listenMarkdown } from "../links.js";
import { briefStatus, narrate, RateLimiter, ToolError, type BriefView, type ToolDeps } from "./tools.js";

const NARRATE_DESCRIPTION =
  "Turn a finished task's result into two spoken memos (edited and original) with a sketch. Returns two links that start playing when opened, even while the audio is still being made. " +
  "Pass the final reply text exactly as written, not a summary. The text content is one markdown line, [Listen](<listen>) · [Listen original](<listen_original>): print it as the last line of the reply, verbatim, with nothing after it. Do not print the card link unless asked. " +
  "Returns at once by default (check with brief_status).";

const asResult = (v: BriefView) => ({
  content: [{ type: "text" as const, text: listenMarkdown(v) }],
  structuredContent: v as unknown as Record<string, unknown>,
});

const asError = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof ToolError ? e.message : `earshot: ${e instanceof Error ? e.message : String(e)}` }],
});

const viewShape = {
  url: z.string(),
  card: z.string(),
  listen: z.string(),
  listen_original: z.string(),
  id: z.string(),
  status: z.enum(["pending", "ready", "degraded", "failed"]),
  script: z.string().optional(),
  audio_url: z.string().optional(),
  original_audio_url: z.string().optional(),
  image_url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
};

export function createServer(deps: ToolDeps = {}): McpServer {
  const server = new McpServer({ name: "earshot", version: "0.0.1" });
  const limiter = new RateLimiter();
  server.registerTool(
    "narrate",
    {
      title: "Narrate a finished task",
      description: NARRATE_DESCRIPTION,
      inputSchema: {
        text: z.string().min(1).describe("The agent's final output for the task."),
        title: z.string().optional().describe("Optional title override."),
        evidence: z.string().optional().describe("Optional https link to the real artifact (PR, diff). Must appear in text and be on an allowed host."),
        wait: z.boolean().optional().describe("true blocks until the memo is ready, failed or degraded (up to 120 s). Default false."),
      },
      outputSchema: viewShape,
    },
    async (a) => {
      try {
        return asResult(await narrate(a, limiter, deps));
      } catch (e) {
        return asError(e);
      }
    },
  );
  server.registerTool(
    "brief_status",
    {
      title: "Status of a memo",
      description: "Status of a memo started by narrate: pending, ready, degraded or failed, with the script and file links once done.",
      inputSchema: { id: z.string().describe("The id returned by narrate (the id returned with the links).") },
      outputSchema: viewShape,
    },
    async (a) => {
      try {
        return asResult(await briefStatus(a.id, deps));
      } catch (e) {
        return asError(e);
      }
    },
  );
  return server;
}

/** Serve over stdio. Stdout belongs to the protocol; every log goes to stderr. */
export async function serveStdio(deps: ToolDeps = {}): Promise<void> {
  await createServer(deps).connect(new StdioServerTransport());
}
