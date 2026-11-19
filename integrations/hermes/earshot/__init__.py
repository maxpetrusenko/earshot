"""earshot for Hermes: end a conversational reply with one Listen and Original line.

Hook: transform_llm_output. It runs once per turn on the finished reply, before delivery.
`earshot run --detach` prints the two links at once (about 0.4 s) and finishes the memo in a
background worker, so the reply is never held for audio. The hook is not registered with
hold_stream, so streaming is unchanged and the line arrives with the final text.

Skipped: platforms outside EARSHOT_HERMES_PLATFORMS (default cli, tui, telegram, matrix; cron
and whatsapp are never narrated), replies under EARSHOT_HERMES_MIN_CHARS (80), replies that
already carry an earshot link. Any failure returns None, so the reply goes out unchanged.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess

logger = logging.getLogger(__name__)

DEFAULT_PLATFORMS = "cli,tui,telegram,matrix"
DEFAULT_MIN_CHARS = 80
RUN_TIMEOUT_S = 6
LINK_LINE = re.compile(r"^\[Listen\]\([^)\s]+\) · \[Original\]\([^)\s]+\)\s*$", re.MULTILINE)
HAS_LINK = re.compile(r"/b/[A-Za-z0-9]{8,}/(edited|original)\.mp3")


def _platforms() -> set[str]:
    raw = os.environ.get("EARSHOT_HERMES_PLATFORMS", DEFAULT_PLATFORMS)
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def _min_chars() -> int:
    try:
        return int(os.environ.get("EARSHOT_HERMES_MIN_CHARS", DEFAULT_MIN_CHARS))
    except ValueError:
        return DEFAULT_MIN_CHARS


def _earshot_bin() -> str | None:
    explicit = os.environ.get("EARSHOT_BIN")
    if explicit:
        return explicit
    found = shutil.which("earshot")
    if found:
        return found
    for candidate in (os.path.expanduser("~/.local/bin/earshot"), "/opt/homebrew/bin/earshot", "/usr/local/bin/earshot"):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def _links_for(text: str) -> str | None:
    binary = _earshot_bin()
    if not binary:
        logger.warning("earshot: binary not found; set EARSHOT_BIN")
        return None
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(filter(None, [env.get("PATH"), "/opt/homebrew/bin", "/usr/local/bin"]))
    try:
        done = subprocess.run(
            [binary, "run", "--detach", "--format", "text", "--no-explain"],
            input=text, capture_output=True, text=True, timeout=RUN_TIMEOUT_S, env=env, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("earshot: run failed: %s", exc)
        return None
    match = LINK_LINE.search(done.stdout or "")
    if done.returncode != 0 or not match:
        logger.warning("earshot: no link (exit %s): %s", done.returncode, (done.stderr or "")[-200:])
        return None
    return match.group(0).strip()


def transform_llm_output(response_text: str, session_id: str = "", model: str = "", platform: str = "", **kwargs):
    if (platform or "").lower() not in _platforms():
        return None
    text = response_text or ""
    if len(text.strip()) < _min_chars() or HAS_LINK.search(text):
        return None
    line = _links_for(text)
    if not line:
        return None
    return f"{text.rstrip()}\n\n{line}"


def register(ctx):
    ctx.register_hook("transform_llm_output", transform_llm_output)
