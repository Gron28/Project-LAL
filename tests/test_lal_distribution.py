import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "web" / "public" / "lal" / "install.sh"
WRAPPER = ROOT / "web" / "public" / "lal" / "lal.sh"


class FakeDistribution(BaseHTTPRequestHandler):
    client_version = "0.1.0"
    heartbeats = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/lal/manifest.json":
            return self.reply_json({
                "clientVersion": type(self).client_version,
                "runtimeVersion": "0.19.9",
                "runtimeInstaller": "https://invalid.example",
            })
        if self.path == "/api/lal/client-settings":
            if self.headers.get("authorization") != "Bearer test-token":
                self.send_error(401)
                return
            return self.reply_json({"model": {"name": "qwen3-4b-stock"}})
        if self.path == "/lal/lal.sh":
            return self.reply_file(WRAPPER)
        if self.path == "/lal/install.sh":
            return self.reply_file(INSTALLER)
        self.send_error(404)

    def do_POST(self):
        if self.path == "/api/lal/heartbeat":
            if self.headers.get("authorization") != "Bearer test-token":
                self.send_error(401)
                return
            type(self).heartbeats.append({
                "id": self.headers.get("x-lal-device-id"),
                "name": self.headers.get("x-lal-device-name"),
                "platform": self.headers.get("x-lal-platform"),
                "version": self.headers.get("x-lal-client-version"),
            })
            return self.reply_json({"ok": True})
        self.send_error(404)

    def reply_json(self, value):
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def reply_file(self, path):
        payload = path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class LalDistributionTest(unittest.TestCase):
    def test_install_invocation_and_update_preserve_user_state(self):
        FakeDistribution.heartbeats = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeDistribution)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                home = root / "home"
                bin_dir = root / "bin"
                fake_path = root / "fake-path"
                lal_home = home / ".lal"
                for directory in (home, bin_dir, fake_path, lal_home):
                    directory.mkdir(parents=True, exist_ok=True)
                fake_qwen = fake_path / "qwen"
                fake_qwen.write_text(
                    "#!/bin/sh\nprintf 'home=%s token=%s args=%s\\n' \"$QWEN_HOME\" \"$LAL_API_KEY\" \"$*\"\n",
                    encoding="utf-8",
                )
                fake_qwen.chmod(0o755)
                (lal_home / "runtime-version").write_text("0.19.9\n", encoding="utf-8")
                env = {
                    **os.environ,
                    "HOME": str(home),
                    "PATH": f"{fake_path}:{os.environ['PATH']}",
                    "LAL_HOME": str(lal_home),
                    "LAL_BIN_DIR": str(bin_dir),
                    "LAL_HOST": f"http://127.0.0.1:{server.server_port}",
                    "LAL_TOKEN": "test-token",
                }

                installed = subprocess.run(
                    [str(INSTALLER)],
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=15,
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)
                self.assertTrue((bin_dir / "lal").is_file())
                self.assertEqual((lal_home / "client-version").read_text().strip(), "0.1.0")
                self.assertEqual(json.loads((lal_home / "settings.json").read_text())["model"]["name"], "qwen3-4b-stock")
                device_id = (lal_home / "device-id").read_text().strip()
                self.assertRegex(device_id, r"^[0-9a-f]{32}$")
                self.assertTrue(FakeDistribution.heartbeats)
                self.assertEqual(FakeDistribution.heartbeats[-1]["id"], device_id)

                invoked = subprocess.run(
                    [str(bin_dir / "lal"), "--version"],
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(invoked.returncode, 0, invoked.stderr)
                self.assertIn(f"home={lal_home}", invoked.stdout)
                self.assertIn("token=test-token", invoked.stdout)
                self.assertIn("args=--version", invoked.stdout)

                (lal_home / "settings.json").write_text('{"user":"keep"}\n', encoding="utf-8")
                chats = lal_home / "projects" / "repo" / "chats"
                chats.mkdir(parents=True)
                (chats / "session.jsonl").write_text("keep\n", encoding="utf-8")
                FakeDistribution.client_version = "0.1.1"
                updated = subprocess.run(
                    [str(bin_dir / "lal"), "update"],
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=15,
                )
                self.assertEqual(updated.returncode, 0, updated.stderr)
                self.assertEqual((lal_home / "client-version").read_text().strip(), "0.1.1")
                self.assertEqual((lal_home / "device-id").read_text().strip(), device_id)
                self.assertEqual((lal_home / "settings.json").read_text(), '{"user":"keep"}\n')
                self.assertEqual((chats / "session.jsonl").read_text(), "keep\n")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
