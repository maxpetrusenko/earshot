# earshot

Turn a coding agent's finished work into a voice memo and a one-glance diagram, and get back a `Listen:` link you can open on your phone.

<p align="center"><img src="assets/brand/hero-card.png" alt="The earshot card on a phone: title, player, a top-down four-box diagram and the transcript" width="360"></p>

## Why

- Reading a wall of agent text away from your desk is hard, and sometimes impossible.
- Read-aloud tools speak text that was written for the eye. A memo for the ear has a different shape: the outcome first, numbers spelled out, no file paths, one decision at the end.
- Nothing pairs a voice memo with a diagram you can take in at a glance.

earshot does that pairing for any agent that can hand it text.

## Quickstart

You need Node 22 or newer, pnpm, and a TTS server. [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) works with the defaults on port 8880. Any OpenAI-compatible `/v1/audio/speech` endpoint works too.

```bash
npm i -g earshot        # or: npx earshot <command>

earshot init            # writes ~/.config/earshot/config.yaml
```

A minimal `~/.config/earshot/config.yaml`:

```yaml
llm:
  type: claude-cli          # runs `claude -p` on your Claude login
  model: haiku
  # or any OpenAI-compatible chat endpoint:
  # type: openai-compatible
  # base_url: http://localhost:11434/v1
  # model: qwen3:8b

tts:
  type: openai-compatible
  base_url: http://localhost:8880/v1
  model: kokoro
  voice: af_heart

serve:
  mode: loopback            # or tailscale-serve, see Privacy and security
```

Start the server in one terminal and make a memo from another:

```bash
earshot serve

echo "Fixed the flaky webhook retries. The counter reset on every 5xx, so a dead endpoint was retried forever. Now it stops after five attempts. 212 tests pass. Open question: delete the 41k stale rows or archive them?" | earshot run
# Listen: http://localhost:7777/b/<id>
```

Open the link. On a CPU-only machine a memo takes about 11 seconds to reach `ready`.

## Integrations

| Agent | Command | How the link reaches you |
|---|---|---|
| Claude Code, skill | `earshot install claude-code` | Claude ends its reply with `Listen: <url>` |
| Claude Code, hook | `earshot install claude-code --mode hook` | Stop hook message in the terminal UI |
| Codex | `earshot install codex` | `notify` program, link in `~/.earshot/logs/hook.log` |
| Any MCP client | `earshot install mcp --client claude-code` | the agent calls the `narrate` tool and prints the URL |
| Anything else | `earshot run --from tagged` | reads the last `<narrate>...</narrate>` block from stdin |

Pick skill or hook mode per scope, not both. Details: [Claude Code](docs/claude-code.md), [Codex](docs/codex.md), [MCP](docs/mcp.md). The installers back up the files they edit and never touch entries they did not write. `earshot uninstall <agent>` undoes them.

## How it works

```
 agent output
      |
 1. extract   Stop payload, Codex session log, <narrate> tag, or stdin
      |
 2. scrub     redact secret-shaped strings, cap input length
      |
 3. rewrite   one LLM call -> { title, spoken script, mermaid diagram }
      |
      +---------------+
      |               |
 4. voice (TTS)   sketch (mermaid -> SVG)      run in parallel
      |               |
      +-------+-------+
              |
 5. card      ~/.earshot/briefs/<id>/ served by `earshot serve`
              -> Listen: <url>
```

The link is allocated before the work finishes. With `--detach`, and in every hook, the command prints the link at once and a background worker completes the memo, so the agent is never blocked.

## Privacy and security

- Text is scrubbed before any network call. API keys, tokens, private keys and `KEY=value` pairs are redacted, and long input is cut from the middle at `privacy.max_input_chars`.
- `claude-cli` removes `ANTHROPIC_API_KEY` from the child environment, so it uses your subscription login and never bills API credits.
- `earshot serve` binds loopback or a Tailscale address only. `tailscale-serve` mode never uses funnel. There is no public mode.
- A brief is reachable only by its 16-character id. The server serves four files per brief: the card, `memo.mp3`, the sketch and `meta.json`. `input.txt` and `script.md` are never served.
- The card HTML escapes every string. The SVG is sanitized and served with `script-src 'none'`. The card runs under a strict CSP with no inline scripts and no CDN calls.
- The evidence link on the card must appear in your text, point at an allowed host (`github.com`, `gitlab.com`, plus `privacy.evidence_hosts`) and carry no secret-looking path or query.
- MCP input is untrusted. It gets the same scrub, tags are stripped, and a server process accepts 6 `narrate` calls per 10 minutes.

Scrubbing is pattern based. It misses a secret that does not look like one, so keep the server on a network you trust.

## Config reference

Every key, with defaults and comments, is in [`config.example.yaml`](config.example.yaml). Unknown keys are an error. Keys never hold secrets, only the name of the environment variable to read.

## Demo video

The demo in [`video/`](video/README.md) is built with [HyperFrames](https://github.com/heygen-com/hyperframes) from the real card markup and a real Kokoro memo.

## Roadmap

- Phone checks: lock-screen controls and seeking on iOS and Android, HTTPS versus plain HTTP.
- Voice input: answer the decision at the end of a memo by voice.
- More publishers: S3, R2 and a custom command, next to `earshot serve`.

## License

MIT. See [LICENSE](LICENSE).
