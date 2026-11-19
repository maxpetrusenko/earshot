# Cursor integration

read_when: installing earshot into Cursor (the IDE agent or `cursor-agent`), changing the sessionStart hook, or debugging a Cursor reply with no Listen link.

Cursor cannot append a line to a reply from outside: its hooks (`stop`, `afterAgentResponse`) can observe the reply but cannot add to it. The link has to come from the agent itself, so earshot gives the agent the same required final step the Claude Code skill carries: run `earshot run --format auto` with the reply, then end the message with what it printed.

## Install

```
earshot install cursor                  # user scope: a sessionStart hook in ~/.cursor/hooks.json
earshot install cursor --scope project  # project scope: ./.cursor/rules/earshot.mdc (alwaysApply)
earshot uninstall cursor [--scope project]
```

- User scope: `earshot install cursor` merges one entry into `hooks.sessionStart` of `~/.cursor/hooks.json` (`CURSOR_CONFIG_DIR` moves it), command `EARSHOT_HOOK=1 earshot cursor-session-start`. The hook prints `{"additional_context": "<instruction>"}`, which Cursor adds to the conversation context at session start. It runs for the IDE agent and for `cursor-agent`. The `EARSHOT_HOOK=1 ` prefix is the only way earshot recognises its own entry; Orca's hooks and any other entry are never touched. The file is copied to `hooks.json.earshot-bak-<time>` first, invalid JSON aborts with nothing changed, and a second install is a no-op.
- Project scope: a rule file with `alwaysApply: true`. A rule earshot did not write (no `earshot-managed` marker) is never overwritten or removed.
- Why not `~/.cursor/rules`: the Cursor CLI does not read it. Tested 2026-11-18 with cursor-agent 2026.11.17: a rule at `~/.cursor/rules/earshot.mdc` was ignored, the same file in `<project>/.cursor/rules/` was followed.
- Why not MCP: `docs/mcp.md` works (`narrate` tool), but `cursor-agent` needs `--approve-mcps` for it in headless runs and the model has to choose to call it. The hook text is in context from the first turn.
- `--bin "<cmd>"` sets how the instruction invokes earshot (default `earshot` on PATH).

## Check

```
HTTPS_PROXY= HTTP_PROXY= cursor-agent -p --force --trust "Explain what a mutex is in three sentences."
```

The reply ends with `[Listen](...) · [Original](...)`; inside Orca a `::orca-visual` player line comes first. On a machine behind the agent-vault proxy, empty the proxy variables or `cursor-agent` fails with `SSL alert number 120`.

Limits: the agent can still skip the step, as it can with the Claude Code skill. A subagent started by Cursor gets its own session start and may also narrate.
