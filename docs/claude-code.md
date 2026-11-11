# Claude Code integration

read_when: installing earshot into Claude Code, changing the Stop hook or the skill, or debugging a missing Listen link.

Two modes. Pick one per scope; running both makes two memos (the hook skips a session the skill narrated in the last 30 seconds, so a double install degrades to one memo).

| | Skill mode (default) | Hook mode |
|---|---|---|
| Link appears | In the chat, as the last line of the reply | In the terminal UI as a hook message |
| Who writes the memo input | Claude: its final reply for the turn, passed verbatim | The hook, from Claude's final message |
| Fires | When Claude judges the task substantial, or the user says "narrate" or "listen" | After every turn that passes the trigger gate |
| Phone (remote session) | Link is in the chat you are reading | Terminal only |

## Install

```
earshot install claude-code                       # skill, user scope (~/.claude)
earshot install claude-code --scope project       # skill, ./.claude
earshot install claude-code --mode hook --scope project
earshot uninstall claude-code --scope project
```

- Skill mode copies `integrations/claude-code/skills/earshot/SKILL.md` to `<scope>/skills/earshot/`, with `{{EARSHOT}}` replaced by `earshot` when it is on PATH, otherwise `node <abs>/dist/cli.js`.
- Hook mode merges one entry into `hooks.Stop` of `<scope>/settings.json`, command `EARSHOT_HOOK=1 node <abs>/dist/hook-entry.js` (or `EARSHOT_HOOK=1 earshot-hook` when on PATH), timeout 10. The `EARSHOT_HOOK=1 ` prefix is the only way earshot recognises its own entry; any other Stop hook is never modified or removed.
- The settings file is copied to `settings.json.earshot-bak-<time>` before any change. Existing hooks, permissions and other keys are never touched. Invalid JSON aborts with nothing changed. A second install is a no-op; a changed command is updated in place.
- A skill file earshot did not write (no `earshot-managed` marker) is never overwritten or removed.
- `CLAUDE_CONFIG_DIR` moves the user scope, as it does for Claude Code itself.

Hook snippet, for hand editing (`integrations/claude-code/settings.hook.json`):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "EARSHOT_HOOK=1 earshot-hook", "timeout": 10 } ] } ] } }
```

From a checkout without a global install: `node /path/to/earshot/integrations/claude-code/hooks/stop.mjs` (needs `pnpm build` once).

## Verified Stop payload

Source: https://code.claude.com/docs/en/hooks (Stop section), checked 2026-11-10 against Claude Code 2.1.322.

| Field | Used for |
|---|---|
| `session_id` | queue key and skill lock key |
| `prompt_id` | rejects transcript text from an earlier prompt (transcript fallback only) |
| `transcript_path` | tool-use count for the gate; text only when `last_assistant_message` is absent |
| `cwd` | not used |
| `hook_event_name` | `"Stop"` |
| `stop_hook_active` | true means Claude is already continuing because of a stop hook; earshot returns `{}` |
| `last_assistant_message` | the final response text; preferred over the transcript. The docs say the transcript "isn't guaranteed to include the final message at Stop time", and recommend this field for read-aloud hooks |
| `background_tasks`, `session_crons` | ignored |

Output: `{"systemMessage": "[Listen](<url>/edited.mp3) · [Listen original](<url>/original.mp3)"}`. The docs list `systemMessage` as a universal field, shown to the user, and the Stop section does not say it is discarded. `systemMessage` also arrives as an informational message in `--output-format stream-json` and the Agent SDK. In plain `claude -p` text mode a Stop hook's message is not printed; skill mode is the way to get a link into `-p` output. Every outcome logs to `~/.earshot/logs/hook.log`. earshot never returns `decision: block`, so it cannot extend a turn.

## Transcript fallback

Real transcripts hold one JSONL entry per content block (thinking, tool_use and text each get a line), user entries are either a prompt (string or text blocks), a `tool_result`, or injected context (`isMeta`), and subagent work has `isSidechain: true`. The extractor takes entries after the last real user prompt, skips sidechains, meta entries, thinking, tool_use and tool_result, and returns the text blocks after the last tool call (the final message, not the "now I will run the tests" chatter). It reads the last 1 MB, ignores a torn last line, retries for about 1 second, and returns nothing rather than text from an earlier turn. It does not join all text blocks of the turn: mid-turn narration makes a poor memo.

## Trigger gate

`trigger.min_chars` (400), `trigger.require_tool_use` (true) and `trigger.opt_in_tag` (false; true narrates only a message containing `<narrate>...</narrate>`, and the memo uses the text inside the tags). A missing transcript counts as no tool use when `require_tool_use` is on.

## Detach and queue

The hook writes the pending brief (scrubbed `input.txt`, `meta.json`, pending card) itself, then starts `earshot worker <id>` with `detached: true`, stdio on `~/.earshot/logs/<id>.log`, and `unref()`. It prints the link and exits. Newest wins per session: a still-pending older brief for the same session becomes `failed` with `error: superseded` and its worker gets SIGTERM (only after a `ps` check that the pid is an earshot worker).
