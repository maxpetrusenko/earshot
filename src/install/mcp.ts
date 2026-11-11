import { codexConfigPath, installCodexMcp, mcpBlock, uninstallCodexMcp } from "./codex.js";
import { cliArgv, InstallError, q, type Result } from "./shared.js";

export type McpClient = "claude-code" | "codex" | "generic";
export const MCP_CLIENTS: McpClient[] = ["claude-code", "codex", "generic"];

export interface McpInstallOptions {
  client: McpClient;
  bin?: string;
  /** Claude Code only: local, project or user. */
  scope?: string;
  /** Codex only: merge into config.toml instead of printing the snippet. */
  write?: boolean;
  /** Codex config path (tests). Default: $CODEX_HOME/config.toml. */
  path?: string;
}

export interface McpInstallOutput {
  /** Text for stdout: a command or a config snippet. */
  print: string;
  results: Result[];
}

const SCOPES = ["local", "project", "user"];

/**
 * Claude Code: print the `claude mcp add` command (its own CLI owns its config files).
 * Generic: print the standard `mcpServers` JSON. Codex: print the TOML table, or merge it with --write.
 */
export function mcpInstall(o: McpInstallOptions): McpInstallOutput {
  const argv = [...cliArgv(o.bin), "mcp"];
  if (o.client === "claude-code") {
    if (o.scope !== undefined && !SCOPES.includes(o.scope)) throw new InstallError(`--scope must be one of ${SCOPES.join(", ")}, got "${o.scope}"`);
    const scope = o.scope ? ` --scope ${o.scope}` : "";
    return { print: `claude mcp add${scope} earshot -- ${argv.map(q).join(" ")}`, results: [] };
  }
  if (o.client === "generic") {
    const [command, ...args] = argv;
    return { print: JSON.stringify({ mcpServers: { earshot: { command, args } } }, null, 2), results: [] };
  }
  if (o.client === "codex") {
    if (!o.write) return { print: mcpBlock(argv.slice(0, -1)).slice(1).join("\n"), results: [] };
    return { print: "", results: [installCodexMcp(o.path ?? codexConfigPath(), argv.slice(0, -1))] };
  }
  throw new InstallError(`--client must be one of ${MCP_CLIENTS.join(", ")}, got "${String(o.client)}"`);
}

export function mcpUninstall(o: { client: McpClient; path?: string }): Result[] {
  if (o.client === "codex") return [uninstallCodexMcp(o.path ?? codexConfigPath())];
  if (o.client === "claude-code") throw new InstallError("remove it with: claude mcp remove earshot");
  throw new InstallError("remove the earshot entry from your client's MCP config by hand");
}
