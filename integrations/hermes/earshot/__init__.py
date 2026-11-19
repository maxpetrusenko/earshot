"""earshot for Hermes: end a conversational reply with one Listen and Original line, and follow it with the explain image.

Hook: transform_llm_output. It runs once per turn on the finished reply, before delivery.
`earshot run --detach` prints the two links at once (about 0.4 s) and finishes the memo in a
background worker, so the reply is never held for audio. The hook is not registered with
hold_stream, so streaming is unchanged and the line arrives with the final text.

Photo follow-up: when the turn is a one-to-one chat listed in `earshot.photo_channels`, the run
also renders the explain image to a PNG (`--explain-png`). A detached deliverer process (this
file run as a script) waits for the PNG and hands it to `hermes send`, Hermes's own sender, as a
`MEDIA:` attachment: a photo on Telegram, an m.image on Matrix. The hook returns before any of that.

Skipped: platforms outside EARSHOT_HERMES_PLATFORMS (default cli, tui, telegram, matrix; cron
and whatsapp are never narrated), replies under EARSHOT_HERMES_MIN_CHARS (80), replies that
already carry an earshot link. Photos need telegram or matrix, chat type dm, a chat in
photo_channels and a reply of at least EARSHOT_HERMES_PHOTO_MIN_CHARS (500). Any failure returns
None, so the reply goes out unchanged.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

logger = logging.getLogger(__name__)

DEFAULT_PLATFORMS = "cli,tui,telegram,matrix"
DEFAULT_MIN_CHARS = 80
DEFAULT_PHOTO_MIN_CHARS = 500
DEFAULT_PHOTO_MAX = 1
PHOTO_PLATFORMS = ("telegram", "matrix")
DEFAULT_PHOTO_CHANNELS = ["telegram:dm", "matrix:dm"]
RUN_TIMEOUT_S = 6
DELIVER_TIMEOUT_S = 300
SETTLE_S = 4
SEND_TIMEOUT_S = 90
LINK_LINE = re.compile(r"^\[Listen\]\([^)\s]+\) · \[Original\]\([^)\s]+\)\s*$", re.MULTILINE)
HAS_LINK = re.compile(r"/b/[A-Za-z0-9]{8,}/(edited|original)\.mp3")
BRIEF_ID = re.compile(r"/b/([A-Za-z0-9]{8,})/")


def _platforms() -> set[str]:
    raw = os.environ.get("EARSHOT_HERMES_PLATFORMS", DEFAULT_PLATFORMS)
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _min_chars() -> int:
    return _int_env("EARSHOT_HERMES_MIN_CHARS", DEFAULT_MIN_CHARS)


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


def _hermes_bin() -> str | None:
    explicit = os.environ.get("HERMES_BIN")
    if explicit:
        return explicit
    found = shutil.which("hermes")
    if found:
        return found
    for candidate in (os.path.expanduser("~/.local/bin/hermes"), "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


# ---------------------------------------------------------------- photo decisions (pure, unit-tested)


def photo_channels(cfg: dict | None) -> list[str]:
    """`earshot.photo_channels` from Hermes config: `<platform>:<chat id>` or `<platform>:dm`.

    `dm` stands for every one-to-one chat in Hermes's channel directory for that platform, so no id
    lives in the repo. An explicit empty list turns photos off."""
    raw = (cfg or {}).get("photo_channels", DEFAULT_PHOTO_CHANNELS)
    if isinstance(raw, str):
        raw = [p for p in raw.split(",")]
    if not isinstance(raw, (list, tuple)):
        return list(DEFAULT_PHOTO_CHANNELS)
    return [str(x).strip().lower() if str(x).strip().lower().endswith(":dm") else str(x).strip() for x in raw if str(x).strip()]


def _directory_dms(directory: dict | None, platform: str) -> set[str]:
    items = ((directory or {}).get("platforms") or {}).get(platform) or []
    return {str(i.get("id")) for i in items if isinstance(i, dict) and str(i.get("type", "")).lower() == "dm" and i.get("id")}


def photo_target(
    *, platform: str, chat_type: str, chat_id: str, text: str, channels: list[str], directory: dict | None, min_chars: int = DEFAULT_PHOTO_MIN_CHARS
) -> str | None:
    """`<platform>:<chat id>` when this turn should get the explain photo, else None.

    Pure: every skip rule lives here. Telegram and Matrix only (cron, WhatsApp, CLI never), the chat must be
    one-to-one, listed in photo_channels, and the reply long enough to have an explain page."""
    platform = (platform or "").lower()
    if platform not in PHOTO_PLATFORMS or (chat_type or "").lower() != "dm" or not chat_id:
        return None
    if len((text or "").strip()) < min_chars:
        return None
    chat_id = str(chat_id)
    for entry in channels:
        plat, _, ref = entry.partition(":")
        if plat.strip().lower() != platform or not ref:
            continue
        ref = ref.strip()
        if ref.lower() == "dm":
            if chat_id in _directory_dms(directory, platform):
                return f"{platform}:{chat_id}"
        elif ref == chat_id:
            return f"{platform}:{chat_id}"
    return None


def newest_pngs(directory: str, brief_id: str) -> list[str]:
    return sorted(glob.glob(os.path.join(directory, f"earshot-{brief_id}-explain*.png")))


# ---------------------------------------------------------------- Hermes state readers


def _session_env() -> dict[str, str]:
    """platform, chat_id and chat_type of this turn, from Hermes's task-local session vars (env as fallback)."""
    names = {"platform": "HERMES_SESSION_PLATFORM", "chat_id": "HERMES_SESSION_CHAT_ID", "chat_type": "HERMES_SESSION_CHAT_TYPE"}
    try:
        from gateway.session_context import get_session_env  # type: ignore

        return {k: get_session_env(v, "") for k, v in names.items()}
    except Exception:
        return {k: os.environ.get(v, "") for k, v in names.items()}


def _plugin_config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore

        cfg = load_config_readonly().get("earshot")
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _channel_directory() -> dict | None:
    try:
        with open(os.path.join(_hermes_home(), "channel_directory.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- earshot run


def _explain_args(photo_dir: str | None) -> list[str]:
    # Explain stays on (no --no-explain): earshot's own visuals config decides whether there is a picture.
    # With a photo dir the run is inline (--format auto + --orca-dir), which is the form that can render a PNG.
    if photo_dir:
        return ["--format", "auto", "--orca-dir", photo_dir, "--explain-png"]
    return ["--detach", "--format", "text"]


def _links_for(text: str, photo_dir: str | None = None) -> str | None:
    binary = _earshot_bin()
    if not binary:
        logger.warning("earshot: binary not found; set EARSHOT_BIN")
        return None
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(filter(None, [env.get("PATH"), "/opt/homebrew/bin", "/usr/local/bin"]))
    try:
        done = subprocess.run(
            [binary, "run", *_explain_args(photo_dir)],
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


# ---------------------------------------------------------------- delivery (detached process)


def hermes_send(target: str, path: str, caption: str = "") -> bool:
    """Send one image with Hermes's own sender (`hermes send`: platform credentials from Hermes config, no raw token here)."""
    binary = _hermes_bin()
    if not binary:
        logger.warning("earshot: hermes binary not found; set HERMES_BIN")
        return False
    body = f"{caption}\nMEDIA:{path}" if caption else f"MEDIA:{path}"
    try:
        done = subprocess.run([binary, "send", "--to", target, "--json", body], capture_output=True, text=True, timeout=SEND_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("earshot: hermes send failed: %s", exc)
        return False
    try:
        ok = done.returncode == 0 and json.loads(done.stdout or "{}").get("success") is not False
    except ValueError:
        ok = done.returncode == 0
    if not ok:
        logger.warning("earshot: hermes send exit %s: %s", done.returncode, ((done.stdout or "") + (done.stderr or ""))[-200:])
    return ok


def deliver(directory: str, brief_id: str, target: str, *, caption: str = "", limit: int = DEFAULT_PHOTO_MAX, timeout: float = DELIVER_TIMEOUT_S, settle: float = SETTLE_S, sender=hermes_send, sleep=time.sleep, clock=time.monotonic) -> int:
    """Wait for the worker's explain PNGs, send each to `target`, delete the directory. Returns how many were sent.

    A PNG counts as ready once the list has stopped changing for `settle` seconds. No PNG before the deadline (no picture
    for this reply, or the PNG render failed) sends nothing."""
    deadline = clock() + timeout
    last: list[str] = []
    stable_since = clock()
    sent = 0
    while clock() < deadline:
        found = newest_pngs(directory, brief_id)
        if found != last:
            last, stable_since = found, clock()
        elif found and clock() - stable_since >= settle:
            for path in found[:limit]:
                if sender(target, path, caption):
                    sent += 1
            break
        sleep(1)
    shutil.rmtree(directory, ignore_errors=True)
    return sent


def _spawn_deliverer(directory: str, brief_id: str, target: str, caption: str, limit: int = DEFAULT_PHOTO_MAX) -> None:
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--deliver", directory, brief_id, target, caption, str(limit)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
    )


# ---------------------------------------------------------------- hook


def transform_llm_output(response_text: str, session_id: str = "", model: str = "", platform: str = "", **kwargs):
    if (platform or "").lower() not in _platforms():
        return None
    text = response_text or ""
    if len(text.strip()) < _min_chars() or HAS_LINK.search(text):
        return None
    photo_dir = target = None
    cfg: dict = {}
    try:
        cfg = _plugin_config()
        session = _session_env()
        if cfg.get("photos", True) is not False and not os.environ.get("HERMES_CRON_SESSION"):
            target = photo_target(
                platform=session["platform"] or platform, chat_type=session["chat_type"], chat_id=session["chat_id"], text=text,
                channels=photo_channels(cfg), directory=_channel_directory(),
                min_chars=_int_env("EARSHOT_HERMES_PHOTO_MIN_CHARS", DEFAULT_PHOTO_MIN_CHARS),
            )
        logger.info("earshot: photo decision hook_platform=%s session=%s -> %s", platform, {k: bool(v) for k, v in session.items()}, target or "none")
        if target:
            photo_dir = tempfile.mkdtemp(prefix="earshot-photo-", dir=_photo_root())
    except Exception as exc:
        logger.warning("earshot: photo decision failed: %s", exc)
        target = photo_dir = None
    line = _links_for(text, photo_dir)
    if not line:
        if photo_dir:
            shutil.rmtree(photo_dir, ignore_errors=True)
        return None
    brief = BRIEF_ID.search(line)
    if target and photo_dir and brief:
        try:
            _spawn_deliverer(photo_dir, brief.group(1), target, str(cfg.get("photo_caption", "") or ""), _photo_max(cfg))
        except OSError as exc:
            logger.warning("earshot: deliverer not started: %s", exc)
            shutil.rmtree(photo_dir, ignore_errors=True)
    elif photo_dir:
        shutil.rmtree(photo_dir, ignore_errors=True)
    return f"{text.rstrip()}\n\n{line}"


def _photo_max(cfg: dict) -> int:
    try:
        return max(1, min(3, int(cfg.get("photo_max", DEFAULT_PHOTO_MAX))))
    except (TypeError, ValueError):
        return DEFAULT_PHOTO_MAX


def _photo_root() -> str:
    root = os.path.join(_hermes_home(), "cache", "earshot-photos")
    os.makedirs(root, exist_ok=True)
    return root


def register(ctx):
    ctx.register_hook("transform_llm_output", transform_llm_output)


if __name__ == "__main__" and len(sys.argv) >= 5 and sys.argv[1] == "--deliver":
    sys.exit(0 if deliver(sys.argv[2], sys.argv[3], sys.argv[4], caption=sys.argv[5] if len(sys.argv) > 5 else "", limit=int(sys.argv[6]) if len(sys.argv) > 6 else DEFAULT_PHOTO_MAX) >= 0 else 1)
