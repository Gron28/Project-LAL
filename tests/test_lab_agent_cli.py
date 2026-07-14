import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "lab-agent"


class FakeLab(BaseHTTPRequestHandler):
    posted = None

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/agent/loop":
            type(self).posted = body
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"runId": "run-1", "conversationId": "code-1"}).encode())
            return
        self.send_error(404)

    def do_GET(self):
        if self.path == "/api/agent/models":
            payload = json.dumps({"models": ["test-model", "other-model"], "current": "test-model"}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/api/agent/runs/run-1/stream?after=0":
            events = [
                {"k": "model_ready", "v": {"model": "test-model", "backend": "fake"}},
                {"k": "tool_request", "v": {"id": "call-1", "name": "read_file", "args": {"path": "README.md"}}},
                {"k": "tool_result", "v": {"id": "call-1", "ok": True, "output": "ok"}},
                {"k": "text", "v": "prototype works"},
                {"k": "status", "v": "done"},
            ]
            payload = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)


class LabAgentCliTest(unittest.TestCase):
    def test_runs_in_current_directory_and_streams_answer(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeLab)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as project:
                result = subprocess.run(
                    [str(SCRIPT), "--host", f"http://127.0.0.1:{server.server_port}", "-y", "inspect", "this", "repo"],
                    cwd=project,
                    text=True,
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "prototype works\n")
                self.assertEqual(FakeLab.posted["project"], str(Path(project).resolve()))
                self.assertEqual(FakeLab.posted["messages"][0]["content"], "inspect this repo")
                self.assertTrue(FakeLab.posted["autoApprove"])
                self.assertIn("test-model ready via fake", result.stderr)
                self.assertIn("read_file", result.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_tui_opens_on_current_directory_and_exposes_controls(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeLab)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as project:
                result = subprocess.run(
                    [str(SCRIPT), "--tui", "--host", f"http://127.0.0.1:{server.server_port}"],
                    cwd=project,
                    input="/settings\n/quit\n",
                    text=True,
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("LAL  ·  Local AI Lab", result.stdout)
                self.assertIn(str(Path(project).resolve()), result.stdout)
                self.assertIn('"model": "test-model"', result.stdout)
                self.assertIn('"mode": "default"', result.stdout)
                self.assertIn("Leaving LAL.", result.stdout)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
