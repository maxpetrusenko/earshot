# MCP server

read_when: wiring earshot into an MCP client, changing the `narrate` or `brief_status` tools, or debugging a missing Listen link from an MCP call.

`earshot mcp` is a stdio MCP server built on `@modelcontextprotocol/sdk` 1.32.2. It exposes two tools. The agent calls `narrate` with its result text and prints the returned link in chat, which is how the link reaches a Claude Code remote session on a phone.

## Install

```
earshot install mcp --client claude-code [--scope local|project|user]   # prints a `claude mcp add` command
earshot install mcp --client generic                                    # prints {"mcpServers": {...}} JSON
earshot install mcp --client codex                                      # prints the TOML table
earshot install mcp --client codex --write                              # merges it into $CODEX_HOME/config.toml
earshot uninstall mcp --client codex
```

- Claude Code: earshot prints the command and does not edit Claude's files. Run it yourself. For a project-only setup, save the generic JSON as `.mcp.json` in the project.
- Codex: the table is `[mcp_servers.earshot]` with `command` and `args`. The line above it is the marker `# earshot-managed: mcp`. A table without that marker is never touched, and so is an `earshot` entry written under `[mcp_servers]`, with dotted keys or as an inline table. Updating our table rewrites only `command` and `args`; keys you added (for example `env`) stay. Uninstall removes the table and its subtables (`[mcp_servers.earshot.env]`). The same verify-before-write rule as `docs/codex.md` applies: the result must parse to the old file plus exactly earshot's keys. Inline tables, dotted keys and subtables for `earshot` make the installer stop with an error. Before any write the file is copied to `config.toml.earshot-bak-<time>`. A symlinked config stays a symlink, the file mode is kept, and other entries are left byte for byte.
- `--bin "<cmd>"` sets how the client starts earshot. The default is `earshot` when it is on PATH, otherwise `node <abs>/dist/cli.js`.

## Tools

`narrate` input: `{text: string, title?: string, evidence?: string, wait?: boolean}`.
Output (also as `structuredContent`): `{url, id, status, script?, audio_url?, image_url?, title?, error?}`.

- Default `wait=false`: the brief is written, a detached worker starts, and the link comes back in about 100 ms with `status: "pending"`. The worker is the same one the Stop hook starts.
- `wait=true` polls until `ready`, `degraded` or `failed`, for at most 120 s. On timeout it returns the `pending` view, not an error.
- `script`, `audio_url` and `image_url` appear once the brief is `ready` or `degraded` and the file exists.

`brief_status` input: `{id}`, the 16 character id from the link. It returns the same shape. Before answering it marks any brief whose worker died (pending, older than a minute, recorded pid gone) as `failed` with `error: "worker died"`; `earshot serve` does the same at start and when a card polls `meta.json`. An unknown id or a malformed one is a tool error.

`wait` is a boolean, there is no `voice` argument, and `evidence` and `title` are the only overrides.

## Rules for untrusted text

Anything an MCP client sends is treated as untrusted.

- Same scrub as the CLI: secret patterns are redacted and long input is cut from the middle (`privacy.max_input_chars`) before any LLM call. Text over four times that limit is rejected.
- `<narrate>` tags are stripped. Empty text is rejected.
- An explicit call is its own trigger. `trigger.min_chars`, `require_tool_use` and `opt_in_tag` gate the automatic hooks and do not apply here.
- The rate limit is checked before any parsing, and the tag scan is linear (1 MB of unclosed `<narrate>` takes a few milliseconds).
- Limit: 6 `narrate` calls per 10 minutes per server process. The 7th is a tool error.
- `title` is redacted, flattened to one line and cut to 120 characters before it becomes a process argument. The worker applies the usual title leak check again.
- `evidence` follows the card's evidence rules: the link must appear in the scrubbed text, its host must be allowlisted (`github.com`, `gitlab.com`, plus `privacy.evidence_hosts`), and it must carry no secret-looking path segment or query key. A link that fails is dropped silently.
- No newest-wins queue or skill lock: MCP calls carry no session id.
- Tool results never contain local paths.

## Check it by hand

```
npx @modelcontextprotocol/inspector --cli node dist/cli.js mcp --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/cli.js mcp --method tools/call --tool-name narrate --tool-arg "text=<report>"
```

The SDK is on the 1.x line, the npm `latest` tag. A 2.x split package, `@modelcontextprotocol/server`, shipped the same day as 1.32.2 and is not used here.
