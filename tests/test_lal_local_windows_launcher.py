from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CMD = ROOT / "start-local-windows.cmd"
SCRIPT = ROOT / "scripts" / "start-local-windows.ps1"


class LalLocalWindowsLauncherTest(unittest.TestCase):
    def test_wrapper_uses_repo_script_without_touching_installed_lal(self):
        wrapper = CMD.read_text()

        self.assertIn(r"%~dp0scripts\start-local-windows.ps1", wrapper)
        self.assertNotIn(r"%LOCALAPPDATA%\LAL", wrapper)
        self.assertNotIn(r"%USERPROFILE%\.lal", wrapper)
        self.assertNotIn("setx", wrapper.lower())
        self.assertIn('if not "%lal_exit%"=="0"', wrapper.lower())

    def test_launcher_is_loopback_and_repo_scoped(self):
        script = SCRIPT.read_text()

        self.assertIn("$GatewayUrl = 'http://127.0.0.1:8771'", script)
        self.assertIn("Join-Path $Root '.local-windows'", script)
        self.assertIn("$env:LAL_HOME = $CliHome", script)
        self.assertIn("$env:QWEN_HOME = $CliHome", script)
        self.assertIn("$env:LAL_GATEWAY_URL = $GatewayUrl", script)
        self.assertIn("'--hostname', '127.0.0.1'", script)
        self.assertIn("'--port', '8771'", script)
        self.assertIn("$matches = @(Get-Command $Name", script)
        self.assertIn("return $matches[0]", script)
        self.assertIn("$Npm = Resolve-ApplicationCommand 'npm.cmd'", script)
        self.assertIn("$Node = Resolve-ApplicationCommand 'node.exe'", script)
        self.assertIn("$Ollama = Resolve-ApplicationCommand 'ollama.exe'", script)
        self.assertNotIn(
            "$Npm = Get-Command npm.cmd -CommandType Application", script
        )
        self.assertIn("Ensure-LocalCliRuntime", script)
        self.assertIn(r"$LocalRuntime = Join-Path $StateRoot 'runtime'", script)
        self.assertIn(
            "$installedRuntime = Join-Path $env:LOCALAPPDATA 'LAL\\runtime'",
            script,
        )
        self.assertIn(
            "Copy-Item -LiteralPath $installedRuntime -Destination $LocalRuntime -Recurse",
            script,
        )
        self.assertIn("& $LocalCliCommand @effectiveArguments", script)
        self.assertNotIn(
            "& $Node.Source (Join-Path $Root 'apps\\cli\\scripts\\dev.js')",
            script,
        )
        self.assertIn("$env:OLLAMA_HOST = '127.0.0.1:11434'", script)
        self.assertIn("$env:OLLAMA_MODELS = $OllamaModels", script)
        self.assertIn("$env:OLLAMA_VULKAN = '1'", script)
        self.assertIn("$env:OLLAMA_IGPU_ENABLE = '1'", script)
        self.assertIn("$env:LAL_OPENVINO_MODEL_ID = 'openvino/qwen3-8b-npu'", script)
        self.assertIn("$env:LAL_OPENVINO_MAX_PROMPT_LEN = '2048'", script)
        self.assertIn(
            "$UserOllamaModels = Join-Path $env:USERPROFILE '.ollama\\models'",
            script,
        )
        for name in (
            "LAL_HOME",
            "QWEN_HOME",
            "LAL_GATEWAY_URL",
            "LAL_API_KEY",
            "LAL_CLI_TOKEN",
            "LAL_MANAGED",
            "OLLAMA_MODELS",
            "OLLAMA_VULKAN",
            "OLLAMA_IGPU_ENABLE",
            "LAL_OPENVINO_PYTHON",
            "LAL_OPENVINO_MODEL_PATH",
            "LAL_OPENVINO_MODEL_ID",
            "LAL_OPENVINO_CACHE_DIR",
            "LAL_OPENVINO_MAX_PROMPT_LEN",
        ):
            self.assertIn(f"'{name}'", script)
        self.assertIn("$PreviousEnvironment = Save-ProcessEnvironment", script)
        self.assertIn("Restore-ProcessEnvironment $PreviousEnvironment", script)
        self.assertIn("if ($entry.Exists)", script)
        self.assertIn('Remove-Item -LiteralPath "Env:\\$name"', script)
        self.assertLess(
            script.index("Stop-ProcessTree $OllamaProcess"),
            script.index("Restore-ProcessEnvironment $PreviousEnvironment"),
        )
        self.assertIn("Join-Path $StateRoot 'ollama-models'", script)
        self.assertIn("$OllamaProcess = Start-Process", script)
        self.assertIn("-PassThru", script)
        self.assertIn("Stop-ProcessTree $OllamaProcess", script)
        self.assertIn("'  Ollama:    using the pre-existing loopback daemon'", script)
        self.assertIn("Assert-LoopbackListener 11434 'Ollama'", script)
        self.assertIn("function Test-TcpPort", script)
        self.assertIn("if (Test-TcpPort '127.0.0.1' 8771)", script)
        self.assertNotIn("Test-NetConnection", script)
        self.assertIn('$GatewayHealthUrl = "$GatewayUrl/api/agent/models"', script)
        self.assertIn("Wait-HttpEndpoint $GatewayHealthUrl 15", script)
        self.assertIn("Local host: already running on loopback; reusing it.", script)
        self.assertNotIn("ollama pull", script.lower())

    def test_launcher_does_not_mutate_machine_connection_state(self):
        script = SCRIPT.read_text().lower()

        for forbidden in (
            "setenvironmentvariable",
            "[environment]::set",
            "tailscale.exe",
            "lal update",
            r"localappdata%\lal",
            r"userprofile%\.lal",
        ):
            self.assertNotIn(forbidden, script)

        self.assertIn("port 8771 is already in use", script)
        self.assertIn("taskkill.exe /pid", script)

    def test_launcher_starts_isolated_cli_with_local_auth(self):
        script = SCRIPT.read_text()

        self.assertIn("if ($CliOnly)", script)
        self.assertIn("Local host: not running; starting it now.", script)
        self.assertIn("Wait-HttpEndpoint $GatewayHealthUrl 15", script)
        self.assertIn("$effectiveArguments += @('--auth-type', 'openai')", script)
        self.assertIn("exit (Start-LocalCli)", script)


if __name__ == "__main__":
    unittest.main()
