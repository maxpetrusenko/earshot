"""Hook decisions for the Hermes plugin. Run: python3 -m unittest discover -s integrations/hermes/tests"""

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

PLUGIN = os.path.join(os.path.dirname(__file__), "..", "earshot", "__init__.py")
spec = importlib.util.spec_from_file_location("earshot_hermes_plugin", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
sys.modules["earshot_hermes_plugin"] = plugin
spec.loader.exec_module(plugin)

LONG = "x" * 600
DIRECTORY = {"platforms": {"telegram": [{"id": "111", "type": "dm"}, {"id": "-9", "type": "group"}], "matrix": [{"id": "!room:hs", "type": "dm"}]}}
DEFAULT = plugin.photo_channels({})


def target(**kw):
    args = dict(platform="telegram", chat_type="dm", chat_id="111", text=LONG, channels=DEFAULT, directory=DIRECTORY)
    args.update(kw)
    return plugin.photo_target(**args)


class PhotoTarget(unittest.TestCase):
    def test_default_dm_telegram_and_matrix(self):
        self.assertEqual(target(), "telegram:111")
        self.assertEqual(target(platform="matrix", chat_id="!room:hs"), "matrix:!room:hs")

    def test_skips(self):
        self.assertIsNone(target(platform="whatsapp"))
        self.assertIsNone(target(platform="cron"))
        self.assertIsNone(target(platform="cli"))
        self.assertIsNone(target(chat_type="group", chat_id="-9"))
        self.assertIsNone(target(chat_id="222"))
        self.assertIsNone(target(text="short reply"))
        self.assertIsNone(target(channels=[]))
        self.assertIsNone(target(directory=None))

    def test_explicit_id_needs_no_directory(self):
        self.assertEqual(target(channels=["telegram:222"], chat_id="222", directory=None), "telegram:222")
        self.assertIsNone(target(channels=["telegram:222"], chat_id="111"))
        self.assertIsNone(target(channels=["matrix:222"], chat_id="222"))

    def test_group_never_even_if_listed(self):
        self.assertIsNone(target(channels=["telegram:-9"], chat_type="group", chat_id="-9"))

    def test_channel_parsing(self):
        self.assertEqual(plugin.photo_channels({"photo_channels": "Telegram:DM, matrix:!a:b"}), ["telegram:dm", "matrix:!a:b"])
        self.assertEqual(plugin.photo_channels({"photo_channels": []}), [])
        self.assertEqual(plugin.photo_channels(None), ["telegram:dm", "matrix:dm"])


class Deliver(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.clock_t = 0.0

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def clock(self):
        return self.clock_t

    def sleep(self, s):
        self.clock_t += s

    def run_deliver(self, sender, **kw):
        return plugin.deliver(self.dir, "abcd1234", "telegram:111", timeout=30, settle=4, sender=sender, sleep=self.sleep, clock=self.clock, **kw)

    def test_sends_each_png_once_settled(self):
        for name in ("explain", "explain2"):
            open(os.path.join(self.dir, f"earshot-abcd1234-{name}.png"), "w").close()
        open(os.path.join(self.dir, "earshot-other-explain.png"), "w").close()
        calls = []
        n = self.run_deliver(lambda t, p, c: calls.append((t, os.path.basename(p), c)) or True, caption="cap", limit=3)
        self.assertEqual(n, 2)
        self.assertEqual(calls, [("telegram:111", "earshot-abcd1234-explain.png", "cap"), ("telegram:111", "earshot-abcd1234-explain2.png", "cap")])

    def test_default_limit_is_one(self):
        for name in ("explain", "explain2"):
            open(os.path.join(self.dir, f"earshot-abcd1234-{name}.png"), "w").close()
        calls = []
        self.assertEqual(plugin.deliver(self.dir, "abcd1234", "telegram:111", timeout=30, settle=4, sender=lambda *a: calls.append(a) or True, sleep=self.sleep, clock=self.clock), 1)
        self.assertEqual(len(calls), 1)
        self.assertFalse(os.path.exists(self.dir))

    def test_no_png_sends_nothing(self):
        calls = []
        self.assertEqual(self.run_deliver(lambda *a: calls.append(a) or True), 0)
        self.assertEqual(calls, [])
        self.assertGreaterEqual(self.clock_t, 30)

    def test_failed_send_not_counted(self):
        open(os.path.join(self.dir, "earshot-abcd1234-explain.png"), "w").close()
        self.assertEqual(self.run_deliver(lambda *a: False), 0)


class Hook(unittest.TestCase):
    LINE = "[Listen](https://h.ts.net/b/AbCd1234Ef/edited.mp3) · [Original](https://h.ts.net/b/AbCd1234Ef/original.mp3)"

    def run_hook(self, session, text=LONG, platform="telegram", cfg=None):
        spawned, runs = [], []
        patches = [
            mock.patch.object(plugin, "_session_env", lambda: session),
            mock.patch.object(plugin, "_plugin_config", lambda: cfg or {}),
            mock.patch.object(plugin, "_channel_directory", lambda: DIRECTORY),
            mock.patch.object(plugin, "_links_for", lambda t, d=None: runs.append(d) or self.LINE),
            mock.patch.object(plugin, "_spawn_deliverer", lambda *a: spawned.append(a)),
            mock.patch.object(plugin, "_photo_root", lambda: tempfile.gettempdir()),
        ]
        for p in patches:
            p.start()
        try:
            out = plugin.transform_llm_output(text, platform=platform)
        finally:
            for p in patches:
                p.stop()
        return out, spawned, runs

    def test_dm_gets_line_and_deliverer(self):
        out, spawned, runs = self.run_hook({"platform": "telegram", "chat_type": "dm", "chat_id": "111"})
        self.assertTrue(out.endswith(self.LINE))
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0][1:3], ("AbCd1234Ef", "telegram:111"))
        self.assertIsNotNone(runs[0])
        shutil.rmtree(spawned[0][0], ignore_errors=True)

    def test_group_gets_line_only(self):
        out, spawned, runs = self.run_hook({"platform": "telegram", "chat_type": "group", "chat_id": "-9"})
        self.assertTrue(out.endswith(self.LINE))
        self.assertEqual((spawned, runs), ([], [None]))

    def test_short_dm_gets_no_photo(self):
        text = "y" * 100
        out, spawned, runs = self.run_hook({"platform": "telegram", "chat_type": "dm", "chat_id": "111"}, text=text)
        self.assertTrue(out.endswith(self.LINE))
        self.assertEqual((spawned, runs), ([], [None]))

    def test_photos_off(self):
        _, spawned, _ = self.run_hook({"platform": "telegram", "chat_type": "dm", "chat_id": "111"}, cfg={"photos": False})
        self.assertEqual(spawned, [])

    def test_tiny_reply_and_cron_untouched(self):
        self.assertIsNone(self.run_hook({}, text="hi")[0])
        self.assertIsNone(self.run_hook({}, platform="cron")[0])
        self.assertIsNone(self.run_hook({}, platform="whatsapp")[0])


class Args(unittest.TestCase):
    def test_no_explain_flag_dropped(self):
        self.assertNotIn("--no-explain", plugin._explain_args(None))
        self.assertNotIn("--no-explain", plugin._explain_args("/tmp/x"))
        self.assertIn("--explain-png", plugin._explain_args("/tmp/x"))
        self.assertIn("--detach", plugin._explain_args(None))


class UserPrompt(unittest.TestCase):
    def test_pre_llm_call_records_the_message_and_returns_none(self):
        plugin._LAST_USER.clear()
        self.assertIsNone(plugin.remember_user_message(session_id="s 1", user_message="draw me a diagram", platform="cli"))
        self.assertEqual(plugin._LAST_USER["s 1"], "draw me a diagram")

    def test_session_key_is_safe(self):
        self.assertEqual(plugin._session_key("a b/c"), "hermes-a_b_c")
        self.assertEqual(plugin._session_key(""), "")

    def test_run_gets_prompt_env_and_session(self):
        plugin._LAST_USER["sess9"] = "make a chart"
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"], seen["env"] = cmd, kw["env"]

            class Done:
                returncode = 0
                stdout = "[Listen](https://h.ts.net/b/AbCd1234Ef/edited.mp3) · [Original](https://h.ts.net/b/AbCd1234Ef/original.mp3)\n"
                stderr = ""

            return Done()

        with mock.patch.object(plugin, "_earshot_bin", lambda: "/bin/earshot"), mock.patch.object(plugin, "_session_env", lambda: {"platform": "cli", "chat_type": "", "chat_id": ""}), mock.patch.object(plugin, "_plugin_config", lambda: {}), mock.patch.object(plugin.subprocess, "run", fake_run):
            out = plugin.transform_llm_output("x" * 200, session_id="sess9", platform="cli")
        self.assertIn("[Listen](", out)
        self.assertEqual(seen["env"]["EARSHOT_USER_PROMPT"], "make a chart")
        self.assertEqual(seen["cmd"][-2:], ["--session", "hermes-sess9"])


if __name__ == "__main__":
    unittest.main()
