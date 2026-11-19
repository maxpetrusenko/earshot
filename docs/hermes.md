# Hermes integration

read_when: installing earshot into Hermes Agent, changing the Hermes plugin, or debugging a Hermes reply that has no Listen line.

Hermes replies get the same last line as Claude Code replies: `[Listen](...) · [Original](...)`. Tested 2026-11-18 on Hermes at ae2a81ccc0 (maxiclaw) and the pro checkout.

## Design

A Hermes plugin registers `transform_llm_output`. Hermes fires it once per turn on the finished reply, before delivery on every surface (CLI, TUI, Telegram, Matrix, WhatsApp, cron) and before the reply is stored. The plugin pipes the reply to `earshot run --detach --format text --no-explain`, which prints the two links in about 0.4 seconds and finishes the memo in a background worker, then returns the reply with the line appended. Streaming is unchanged (no `hold_stream`), so the user sees the reply as it arrives and the line comes with the final text.

Chosen over alternatives:

| Option | Why not |
|---|---|
| Gateway `agent:end` event hook | Return values are discarded, so it cannot add to the reply; it would need a second message. It also never loads in the CLI, TUI or cron |
| Patch core files | Overwritten by `hermes update`; a plugin under `~/.hermes/plugins/` is not |
| Telegram voice note | The edited track streams for several seconds; a voice note needs the finished file, so it either blocks the reply or arrives as a second message, and Matrix needs a different upload path. The link starts playing while the memo is still being made |

Plugin source: `integrations/hermes/earshot/` (`plugin.yaml`, `__init__.py`). Installer: `integrations/hermes/install.sh`.

```
integrations/hermes/install.sh            # copies to ~/.hermes/plugins/earshot, runs `hermes plugins enable earshot`
integrations/hermes/install.sh --restart  # also `hermes gateway restart`
hermes plugins disable earshot            # undo
```

`hermes plugins enable` adds `earshot` to `plugins.enabled` in `config.yaml` and loads the plugin into the running gateway, so no restart is needed and cron keeps running. A changed copy at the destination is moved to `earshot.earshot-bak-<time>` first.

## Format per channel

| Channel | Output |
|---|---|
| CLI, TUI | the markdown line, same as Claude Code |
| Telegram | the same line; Telegram renders `[Listen](url)` as a tappable link and the audio plays in the browser or the in-app viewer |
| Matrix | the same line; Element renders it as links |

One format for all three: it needs no per-platform upload code, it costs one detached process, and it reuses the card page.

## What is skipped

- Platforms outside `EARSHOT_HERMES_PLATFORMS` (default `cli,tui,telegram,matrix`). Cron output arrives with platform `cron` and WhatsApp replies go to third parties, so neither is ever narrated.
- Replies under `EARSHOT_HERMES_MIN_CHARS` (default 80).
- Replies that already contain an earshot link.
- Any failure (no `earshot` binary, run error, no link in the output, 6 second timeout): the reply goes out unchanged.

`EARSHOT_BIN` overrides the binary; otherwise `earshot` on PATH, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`.

## Latency

`--detach` returns the links before audio exists, so the added delay is the subprocess start, about 0.4 seconds. The worker runs outside the gateway.

## Privacy

Links point at `earshot serve` in `tailscale-serve` mode (a `*.ts.net` host, never funnel), so they open only on Max's tailnet. The reply text is scrubbed by earshot before any LLM or TTS call. Matrix rooms with other people would show the link to them, but it does not open off the tailnet.

## Survives `hermes update`

The plugin lives in `~/.hermes/plugins/`, outside the Hermes checkout, and the enable flag lives in `config.yaml`. Neither is touched by an update. If a Hermes release renames the hook, `hermes plugins list` shows the plugin and the gateway log prints the registration error; re-run `install.sh`.
