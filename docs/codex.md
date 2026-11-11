# Codex integration

read_when: installing earshot into Codex CLI, changing the notify hook or the Codex extractor, or debugging a Codex turn that produced no memo.

Three ways in, from most to least automatic:

1. `notify` hook: every finished turn that passes the trigger gate becomes a memo. Codex shows no hook output, so the link is only in `~/.earshot/logs/hook.log`.
2. MCP: Codex calls `narrate` and prints the link in its reply. See `docs/mcp.md`.
3. `earshot run --from codex --session <id>`: by hand, for one named session.

## notify

Source: https://developers.openai.com/codex/config-advanced (Notifications), checked 2026-11-10 against Codex CLI 0.145.0. Codex runs the `notify` program with the notification as a single JSON argument appended to the argv. Fields: `type` (currently only `agent-turn-complete`), `thread-id` (the session id), `turn-id`, `cwd`, `input-messages`, `last-assistant-message`. A project `.codex/config.toml` cannot set `notify`; only the user config can.

```
earshot install codex              # writes notify into $CODEX_HOME/config.toml (default ~/.codex)
earshot uninstall codex
```

The line written is:

```
# earshot-managed: notify
notify = ["env", "EARSHOT_HOOK=1", "earshot-hook", "codex"]
```

- Ownership is exact: a notify array is earshot's only when it starts with `env`, `EARSHOT_HOOK=1`. The installer inserts it at the root, before the first table.
- Codex allows one `notify` program. If one is already set, earshot leaves the file unchanged, prints it with a short recipe for calling earshot from your own program, and exits 1. It does not chain, because that would mean rewriting a program earshot did not write.
- Edits are line splices that keep comments, CRLF line endings and a missing final newline. smol-toml parses the file before and after: the result must equal the old file plus exactly earshot's keys, or nothing is written (the error says so and no backup is made). Install then uninstall gives back the same bytes.
- A `notify` written as `"notify" = ...` or `notify.x = ...` counts as another program's.
- Before any write the file is copied to `config.toml.earshot-bak-<time>`. A symlinked config stays a symlink, the mode is kept, and every other line is untouched.
- `--bin "<cmd>"` sets the hook command. The default is `earshot-hook` when on PATH, otherwise `node <abs>/dist/hook-entry.js`.

`earshot-hook codex '<json>'` (or `earshot hook codex '<json>'`) applies the trigger gate (`min_chars`, `require_tool_use`, `opt_in_tag`), starts the detached worker and exits in about 120 ms. Tool use is counted from the session log, since the payload does not carry it; if the log is not found the turn counts as no tool use and is skipped when `require_tool_use` is on. A second turn in the same session supersedes a still-pending memo from the first.

## Session logs

`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl` (default `~/.codex`), plus a flat `archived_sessions/`. One JSON object per line, `{timestamp, type, payload}`. Verified on real files from Codex 0.145.0 and from April 2026, then copied as structure only into `test/fixtures/codex/`.

| Entry | Meaning |
|---|---|
| `session_meta` | `payload.id` is the session id |
| `event_msg` / `task_started` | a turn begins |
| `response_item` / `message`, `role: "assistant"`, `phase: "final_answer"` | the final answer; `content[]` holds `{type: "output_text", text}` |
| same, `phase: "commentary"` | progress chatter, skipped |
| `response_item` / `function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call` | tool use |
| `event_msg` / `task_complete` | turn end; `last_agent_message` repeats the answer, `error` appears when the turn failed (a usage limit, for example) |

The extractor takes the last turn only: entries after the last `task_started`. It prefers `final_answer`, then assistant text without a phase after the last tool call, then `task_complete.last_agent_message`. A turn with no answer returns nothing and never falls back to an earlier turn. A torn last line is ignored and a lagging file is retried for about a second.

`run --from codex --session <id>` needs the exact id. The id must be 8 to 80 letters, digits and dashes and must match a file name suffix, so a prefix or a path never matches. `--transcript <rollout file>` skips the lookup.

## Any other agent

`earshot run --from tagged` reads stdin and narrates the last non-empty `<narrate>...</narrate>` block. No block means exit 2 with a message.
