import hashlib
import json
from pathlib import Path
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
LAL_PUBLIC = ROOT / "web" / "public" / "lal"


class LalWindowsReleaseTest(unittest.TestCase):
    def test_manifest_pins_a_native_lal_archive(self):
        manifest = json.loads((LAL_PUBLIC / "manifest.json").read_text())
        archive = LAL_PUBLIC / manifest["windowsArchive"].removeprefix("/lal/")

        self.assertTrue(archive.is_file())
        self.assertEqual(
            hashlib.sha256(archive.read_bytes()).hexdigest(),
            manifest["windowsSha256"],
        )

        with zipfile.ZipFile(archive) as release:
            names = set(release.namelist())
            for required in (
                "lal-cli/bin/lal.cmd",
                "lal-cli/lib/cli.js",
                "lal-cli/node/node.exe",
                "lal-cli/LICENSE",
                "lal-cli/NOTICE-LAL.md",
                "lal-cli/manifest.json",
            ):
                self.assertIn(required, names)
            release_manifest = json.loads(
                release.read("lal-cli/manifest.json").decode()
            )
            self.assertEqual(release_manifest["name"], "@local-ai-lab/lal-cli")
            self.assertEqual(release_manifest["version"], manifest["lalRuntimeVersion"])
            self.assertEqual(release_manifest["target"], "win-x64")
            interactive_chunk = next(
                name
                for name in names
                if name.startswith("lal-cli/lib/chunks/startInteractiveUI-")
            )
            interactive_text = release.read(interactive_chunk).decode()
            self.assertNotIn("Add a QWEN.md file", interactive_text)
            self.assertIn("Add a LAL.md file", interactive_text)
            self.assertIn("LAL connection needs repair", interactive_text)
            self.assertIn('"#22D3C5"', interactive_text)
            self.assertIn('"#55E06F"', interactive_text)
            self.assertIn('"#E6D85C"', interactive_text)

    def test_windows_launcher_never_falls_back_to_qwen(self):
        wrapper = (LAL_PUBLIC / "lal.cmd").read_text()
        wrapper_text = (LAL_PUBLIC / "lal.cmd.txt").read_text()
        installer = (LAL_PUBLIC / "install.ps1").read_text()

        self.assertEqual(wrapper, wrapper_text)
        self.assertIn(r"LAL\runtime\bin\lal.cmd", wrapper)
        self.assertNotIn("call qwen", wrapper.lower())
        self.assertNotIn("get-command qwen", installer.lower())
        self.assertNotIn("install-qwen", installer.lower())
        self.assertIn("Get-FileHash -Algorithm SHA256", installer)
        self.assertIn("settings.pre-managed.json", installer)
        self.assertIn("[System.Text.UTF8Encoding]::new($false)", installer)
        self.assertIn("WriteAllText($SettingsPath, $MergedSettingsText, $Utf8NoBom)", installer)
        self.assertIn("Set-LalSettingProperty $CurrentSettings 'security'", installer)
        self.assertIn("Set-LalSettingProperty $CurrentSettings 'privacy'", installer)
        self.assertIn("Set-LalSettingProperty $CurrentSettings 'telemetry'", installer)
        self.assertIn("Set-LalSettingProperty $CurrentSettings 'modelProviders'", installer)
        self.assertIn('"$HostUrl/api/lal/prompt/terminal"', installer)
        self.assertIn("-Headers $Headers -OutFile $SystemBasePromptPath", installer)
        self.assertIn("system.local.md", installer)
        self.assertIn("Set-LalSettingProperty $CurrentSettings 'tools'", installer)
        self.assertIn('QWEN_SYSTEM_MD=%LAL_HOME%\\system.md', wrapper)
        self.assertNotIn("if (-not (Test-Path $SettingsPath))", installer)


if __name__ == "__main__":
    unittest.main()
