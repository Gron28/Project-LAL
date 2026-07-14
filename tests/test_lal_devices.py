import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
COMMAND = ROOT / "bin" / "lal-devices"


class LalDevicesTest(unittest.TestCase):
    def test_formats_devices_and_rejected_attempts(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "devices.json"
            registry.write_text(json.dumps({
                "version": 1,
                "devices": {
                    "abc12345": {
                        "id": "abc12345",
                        "name": "workstation",
                        "platform": "Windows/x64",
                        "clientVersion": "0.2.0",
                        "firstSeen": "2026-07-13T00:00:00.000Z",
                        "lastSeen": "2026-07-13T00:00:00.000Z",
                        "lastActivity": "heartbeat",
                        "lastIp": "100.64.0.5",
                        "userAgent": "test",
                        "tailnetLogin": "",
                        "requests": 3,
                    }
                },
                "denied": {
                    "total": 2,
                    "lastSeen": "2026-07-13T00:00:00.000Z",
                    "lastIp": "100.64.0.9",
                    "userAgent": "test",
                },
            }), encoding="utf-8")
            result = subprocess.run(
                [str(COMMAND)],
                env={**os.environ, "LAL_DEVICES_FILE": str(registry)},
                text=True,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("workstation", result.stdout)
            self.assertIn("Windows/x64", result.stdout)
            self.assertIn("Rejected-token attempts: 2", result.stdout)


if __name__ == "__main__":
    unittest.main()
