"""Behavior of bin/lal's stale-bundle check under LAL_SKIP_CLI_BUILD.

Convention: mirrors tests/test_lal_distribution.py (Python unittest,
subprocess against a real copy of the script, fake executables on PATH
instead of mocking bash). Placed alongside it because it exercises the
same launcher script, just a different corner of its behavior, so a
reader of the "M1 latency" fix knows where to look next to it.

Every scenario runs the ACTUAL current bin/lal content (read from the
repo at test time) inside a throwaway ROOT, so this fails if bin/lal's
staleness logic ever drifts from what's asserted here. No real
`npm run build`/`npm run bundle` is ever executed: a fake `npm` on PATH
stands in for it so the test stays fast and never triggers a real CLI
rebuild.
"""

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL_WRAPPER = ROOT / "bin" / "lal"

REBUILD_MESSAGE = "CLI sources changed; rebuilding the runtime bundle..."


class LalSkipBuildWarningTest(unittest.TestCase):
    def _write(self, path: Path, content: str, *, executable: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    def _make_sandbox(self, tmp: Path, *, stale: bool) -> dict:
        """Build a throwaway ROOT with a real copy of bin/lal and a fake
        apps/cli tree, and return the env to run it with.

        stale=True: a source file is made newer than dist/cli.js.
        stale=False: dist/cli.js is made newer than every source file.
        """
        bin_dir = tmp / "bin"
        cli_root = tmp / "apps" / "cli"
        fake_bin = tmp / "fakebin"
        lal_home = tmp / "lal-home"
        npm_log = tmp / "npm-invocations.log"

        self._write(bin_dir / "lal", LOCAL_WRAPPER.read_text(encoding="utf-8"), executable=True)

        self._write(cli_root / "package.json", '{"name": "fake-cli", "version": "0.0.0-test"}\n')
        self._write(cli_root / "package-lock.json", "{}\n")
        self._write(cli_root / "scripts" / "cli-entry.js", (
            "process.stderr.write('cli-entry-invoked\\n');\n"
            "console.log('CLI_ENTRY_RAN');\n"
        ))
        self._write(cli_root / "packages" / "core" / "src" / "marker.ts", "// core source\n")
        self._write(cli_root / "packages" / "cli" / "src" / "marker.ts", "// cli source\n")

        # Fake `npm`: records invocations instead of running a real build,
        # and "fixes" the bundle so a real build's effect is observable.
        self._write(fake_bin / "npm", (
            "#!/usr/bin/env bash\n"
            "echo \"npm $*\" >> \"$FAKE_NPM_LOG\"\n"
            "touch \"$FAKE_CLI_BUNDLE\"\n"
            "exit 0\n"
        ), executable=True)

        bundle = cli_root / "dist" / "cli.js"
        bundle.parent.mkdir(parents=True, exist_ok=True)
        bundle.write_text("// bundle\n", encoding="utf-8")

        now = 1_700_000_000
        if stale:
            # Sources predate the bundle...
            os.utime(bundle, (now, now))
            for f in (
                cli_root / "package.json",
                cli_root / "package-lock.json",
                cli_root / "scripts" / "cli-entry.js",
                cli_root / "packages" / "core" / "src" / "marker.ts",
            ):
                os.utime(f, (now - 100, now - 100))
            # ...except one, which is newer -> triggers the `-newer` find.
            os.utime(cli_root / "packages" / "cli" / "src" / "marker.ts", (now + 100, now + 100))
        else:
            for f in (
                cli_root / "package.json",
                cli_root / "package-lock.json",
                cli_root / "scripts" / "cli-entry.js",
                cli_root / "packages" / "core" / "src" / "marker.ts",
                cli_root / "packages" / "cli" / "src" / "marker.ts",
            ):
                os.utime(f, (now - 100, now - 100))
            os.utime(bundle, (now, now))

        lal_home.mkdir(parents=True, exist_ok=True)

        env = {
            "PATH": f"{fake_bin}:/usr/bin:/bin:{os.path.dirname(sys.executable)}",
            "HOME": str(tmp),
            "LAL_HOME": str(lal_home),
            "FAKE_NPM_LOG": str(npm_log),
            "FAKE_CLI_BUNDLE": str(bundle),
        }
        # Make the real `node` reachable without importing the caller's
        # full PATH (keeps the sandbox hermetic about what bin/lal can see).
        node_path = subprocess.run(
            ["which", "node"], capture_output=True, text=True, check=True
        ).stdout.strip()
        env["PATH"] = f"{fake_bin}:{os.path.dirname(node_path)}:/usr/bin:/bin"

        return {
            "bin_lal": bin_dir / "lal",
            "env": env,
            "npm_log": npm_log,
        }

    def _run(self, sandbox: dict, *, skip_build: bool | None) -> subprocess.CompletedProcess:
        env = dict(sandbox["env"])
        if skip_build is not None:
            env["LAL_SKIP_CLI_BUILD"] = "1" if skip_build else "0"
        return subprocess.run(
            [str(sandbox["bin_lal"]), "--version"],
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
        )

    # (a) Default behavior unchanged: a stale bundle still rebuilds, with
    # no opt-out set at all.
    def test_default_rebuilds_stale_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = self._make_sandbox(Path(tmp), stale=True)
            result = self._run(sandbox, skip_build=None)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(REBUILD_MESSAGE, result.stderr)
            self.assertTrue(sandbox["npm_log"].exists(), "npm was never invoked")
            self.assertIn("npm run build", sandbox["npm_log"].read_text())
            self.assertIn("npm run bundle", sandbox["npm_log"].read_text())
            self.assertIn("CLI_ENTRY_RAN", result.stdout)

    # (b) LAL_SKIP_CLI_BUILD=1 skips the rebuild entirely.
    def test_opt_out_skips_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = self._make_sandbox(Path(tmp), stale=True)
            result = self._run(sandbox, skip_build=True)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(REBUILD_MESSAGE, result.stderr)
            self.assertFalse(sandbox["npm_log"].exists(), "npm should not have been invoked")
            self.assertIn("CLI_ENTRY_RAN", result.stdout)

    # (c) LAL_SKIP_CLI_BUILD=1 with a stale bundle still warns loudly on
    # stderr instead of silently running stale.
    def test_opt_out_with_stale_bundle_still_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = self._make_sandbox(Path(tmp), stale=True)
            result = self._run(sandbox, skip_build=True)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("stale", result.stderr.lower())
            self.assertIn("LAL_SKIP_CLI_BUILD", result.stderr)
            self.assertFalse(sandbox["npm_log"].exists())
            self.assertIn("CLI_ENTRY_RAN", result.stdout)

    # Sanity: the opt-out must not manufacture a warning when the bundle
    # is not actually stale.
    def test_opt_out_with_fresh_bundle_is_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = self._make_sandbox(Path(tmp), stale=False)
            result = self._run(sandbox, skip_build=True)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(REBUILD_MESSAGE, result.stderr)
            self.assertNotIn("stale", result.stderr.lower())
            self.assertFalse(sandbox["npm_log"].exists())
            self.assertIn("CLI_ENTRY_RAN", result.stdout)


if __name__ == "__main__":
    unittest.main()
