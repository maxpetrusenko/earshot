# Earshot

**Hear what your coding agent did.** Get a short spoken summary instead of reading long output, plus a glance diagram so it's easier to understand.

<p align="center"><img src="https://raw.githubusercontent.com/maxpetrusenko/earshot/main/assets/brand/hero-card.png" alt="Earshot card showing player, diagram, and transcript" width="360"></p>

Reading agent output away from your desk is hard, sometimes impossible. Read-aloud tools speak text written for the eye. A memo for the ear has a different shape: outcome first, numbers spelled out, no file paths, one decision at the end. Earshot pairs that voice memo with a diagram you can take in at a glance.

## Features

- **Instant playback**: Listen while the memo is still being made. Audio starts in ~1.5 seconds for the original track, ~4 seconds for the edited memo.
- **Two tracks**: *Listen* for the polished ear-first memo, *Original* for your agent's own words spoken as written.
- **One-glance diagrams**: Top-down flow showing what broke and what got fixed (for substantial work).
- **Privacy-first**: Secrets scrubbed before any network call. Local or Tailscale-only serving, never public.
- **Works everywhere**: Claude Code, Codex, any MCP client, Orca chat, or pipe from stdin.

## Quick Start

**Requirements**: Node ≥22, a TTS server ([Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) works out of the box on port 8880, or any OpenAI-compatible `/v1/audio/speech` endpoint).

### Install

```bash
npm install -g @maxpetrusenko/earshot
# or run once: npx @maxpetrusenko/earshot
```

### Configure

```bash
earshot init  # writes ~/.config/earshot/config.yaml
```

Minimal config:

```yaml
llm:
  type: claude-cli          # uses your Claude subscription login
  model: sonnet

tts:
  type: openai-compatible
  base_url: http://localhost:8880/v1
  model: kokoro
  voice: af_heart

serve:
  mode: loopback            # or tailscale-serve
```

### Run

Start the server in one terminal:

```bash
earshot serve
```

Make a memo from another terminal:

```bash
echo "Fixed the flaky webhook retries. The counter reset on every 5xx, so a dead endpoint was retried forever. Now it stops after five attempts. 212 tests pass. Open question: delete the 41k stale rows or archive them?" | earshot run
```

Output:
```
[Listen](http://localhost:7777/b/<id>/edited.mp3) · [Original](http://localhost:7777/b/<id>/original.mp3)
```

Tap either word to start playing. Both tracks start streaming before they're complete. The card with diagram and transcript is at `/b/<id>`.

## Integrations

| Agent | Installation | How the link reaches you |
|-------|--------------|--------------------------|
| **Claude Code** (skill) | `earshot install claude-code` | Claude ends its reply with: Listen · Original |
| **Claude Code** (hook) | `earshot install claude-code --mode hook` | Stop hook message in terminal UI |
| **Orca chat** | `earshot run --format auto` | Inline Web Audio player on desktop (links on iOS), flow diagram for bigger tasks |
| **Codex** | `earshot install codex` | `notify` program, link in `~/.earshot/logs/hook.log` |
| **Any MCP client** | `earshot install mcp --client claude-code` | Agent calls `narrate` tool and prints the links |
| **Custom/other** | `earshot run --from tagged` | Reads last `<narrate>...</narrate>` block from stdin |

Pick skill **or** hook mode per scope, not both.

**Deep dive**: [Claude Code](docs/claude-code.md) · [Codex](docs/codex.md) · [MCP](docs/mcp.md) · [Orca](docs/orca.md)

## Privacy and Security

- **Secrets scrubbed**: API keys, tokens, private keys, and `KEY=value` pairs are redacted before any network call. Long input is capped at `privacy.max_input_chars`.
- **No API billing**: `claude-cli` removes `ANTHROPIC_API_KEY` from the environment—uses your subscription login, never bills API credits.
- **Local or Tailscale only**: `earshot serve` binds loopback or Tailscale address only. `tailscale-serve` mode never uses funnel. No public mode exists.
- **Unique brief IDs**: Each brief is reachable only by its random 16-character ID.
- **Strict CSP**: The card HTML escapes every string. SVG is sanitized and served with `script-src 'none'`. No inline scripts, no CDN calls.
- **Evidence link validation**: Must appear in your text, point at allowed hosts (`github.com`, `gitlab.com`, plus `privacy.evidence_hosts`), and carry no secret-looking path or query.

Scrubbing is pattern-based—it misses secrets that don't look like one. Keep the server on a network you trust.

## Configuration

Every key with defaults and comments is in [`config.example.yaml`](config.example.yaml). Unknown keys are errors.

### Script styles

- `short` (default): 20-40 second summary, hard-capped at 110 words. Outcome, what changed, one decision as a question. Skips file paths, URLs, quoted text.
- `story`: Longer conversational memo that reads quoted text word-for-word (e.g., a post draft).
- `brief`: Terse status update.

Set with `script.style` in config.

### TTS profiles

`tts.profile` picks an entry from `tts.profiles`. Fast profile (`fast`) defaults to Kokoro. Add a voice clone as another profile; if it takes tens of seconds per sentence, keep `fast` as default for streaming. WAV output is auto-converted with ffmpeg.

### LLM models

`llm.model: sonnet` is the default for `claude-cli`. In testing, Sonnet streamed its first words in ~1.5 seconds; Haiku took 6-10 seconds thinking before the first word.

## How It Works

```
agent output
     |
1. extract    Stop payload, Codex session log, <narrate> tag, or stdin
     |
2. scrub      redact secret-shaped strings, cap input length
     |
     +------------------+------------------+
     |                  |                  |
original track    edited track       sketch (mermaid -> SVG)
clean text -> TTS  LLM stream ->     starts when diagram written,
sentence by       sentences ->       never blocks audio
sentence          TTS per chunk
     |                  |
original.mp3      edited.mp3
(growing)         (growing)
     |                  |
     +--------+---------+
              |
       card + links
       ~/.earshot/briefs/<id>/ served by `earshot serve`
       -> [Listen](url/edited.mp3) · [Original](url/original.mp3)
```

Links are allocated before work finishes. With `--detach` (and in every hook), the command prints links immediately while a background worker completes the memo—the agent is never blocked.

## Advanced Usage

### Output formats

- `--format plain`: Two lines: `Listen: <url>` and `Original: <url>`
- `--format json`: `{listen, listen_original, card, id}`
- `--format auto`: Orca inline player (when `ORCA_CHAT_SCRATCH_DIR` is set), otherwise links with background worker

### Serve modes

- `loopback`: 127.0.0.1 only, `http://localhost:<port>`
- `tailscale-serve`: Bind 127.0.0.1 and run `tailscale serve` (tailnet only, never funnel). Link: `https://<node>.<tailnet>.ts.net`
- `tailnet-ip`: Bind the Tailscale IPv4 only, plain HTTP

### Trigger gates (hook mode)

Control which turns become memos with `trigger.*` settings:

- `min_chars` (default: 80): Skip very short replies
- `require_tool_use` (default: false): Skip turns with no tool calls
- `opt_in_tag` (default: false): Only narrate when output contains `<narrate>...</narrate>`

## Demo Video

The demo in [`video/`](video/README.md) is built with [HyperFrames](https://github.com/heygen-com/hyperframes) from real card markup and a real Kokoro memo.

## Roadmap

- Phone checks: Lock-screen controls and seeking on iOS/Android, HTTPS vs plain HTTP
- Voice input: Answer the decision at the end of a memo by voice
- More publishers: S3, R2, custom command (beyond `earshot serve`)

## Links

- **npm**: [@maxpetrusenko/earshot](https://www.npmjs.com/package/@maxpetrusenko/earshot)
- **GitHub**: [maxpetrusenko/earshot](https://github.com/maxpetrusenko/earshot)
- **Issues**: [Report a bug or request a feature](https://github.com/maxpetrusenko/earshot/issues)

## License

MIT. See [LICENSE](LICENSE).
