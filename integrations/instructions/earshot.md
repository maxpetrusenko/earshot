# earshot: end every reply with listen links

Required final step on every reply to the user, tool use or not. Skip only a reply under about 80 characters, or a pure clarifying question under 80 characters. Run it once per reply, never twice.

1. Write your final reply for this turn, the exact text the user will read.
2. Pass that reply to earshot word for word (not a summary, not an earlier reply). Put it in the heredoc body unchanged:

```bash
{{EARSHOT}} run --format auto <<'EARSHOT_EOF'
<your final reply, exactly as you will send it>
EARSHOT_EOF
```

   Add `--visual` after `--format auto` only for a multi-step change, a UI change, a perf result or an architecture recommendation. Never for a status update, a test run, a short reply or an answer to a question.
3. The command returns in about half a second and prints one markdown line, `[Listen](<url>) · [Original](<url>)`. Inside Orca it first prints one or two `::orca-visual{...}` lines. Copy what it printed verbatim. Do not wait for the audio and do not run anything else to check on it.
4. Send your final reply unchanged. The last lines of the message are exactly what the command printed, with nothing after them. Do not add any other link and do not turn the links into raw URLs.

If the command fails or prints no `[Listen](` line, say so in one sentence and do not invent a link.
