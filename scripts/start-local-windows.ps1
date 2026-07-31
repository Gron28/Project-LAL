[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoBrowser,
  [switch]$CliOnly,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArguments
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$StateRoot = Join-Path $Root '.local-windows'
$CliHome = Join-Path $StateRoot 'cli-home'
$UserOllamaModels = Join-Path $env:USERPROFILE '.ollama\models'
$OllamaModels = if (Test-Path $UserOllamaModels) {
  $UserOllamaModels
} else {
  Join-Path $StateRoot 'ollama-models'
}
$LocalRuntime = Join-Path $StateRoot 'runtime'
$TokenFile = Join-Path $StateRoot 'cli-token'
$WebLog = Join-Path $StateRoot 'web.log'
$WebErrorLog = Join-Path $StateRoot 'web.error.log'
$OpenVinoPython = Join-Path $StateRoot 'npu-env\Scripts\python.exe'
$OpenVinoModel = Join-Path $StateRoot 'models\openvino-qwen3-8b-int4-cw'
$OpenVinoCache = Join-Path $StateRoot 'openvino-cache\qwen3-8b-npu'
$GatewayUrl = 'http://127.0.0.1:8771'
$GatewayHealthUrl = "$GatewayUrl/api/agent/models"
$WebProcess = $null
$OllamaProcess = $null

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process -or $Process.HasExited) { return }
  & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}

function Test-HttpEndpoint {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-HttpEndpoint {
  param([string]$Url, [int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Url) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Test-TcpPort {
  param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds = 1000)
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync($Address, $Port)
    return $connect.Wait($TimeoutMilliseconds) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Assert-LoopbackListener {
  param([int]$Port, [string]$Name)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    $netstatListeners = @(
      & netstat.exe -ano -p tcp |
        Select-String -Pattern "^\s*TCP\s+\S*:$Port\s+\S+\s+LISTENING\s+\d+\s*$"
    )
    if ($netstatListeners.Count -eq 0) {
      throw "$Name answered on port $Port, but its listener binding could not be verified."
    }
    $nonLoopback = @($netstatListeners | Where-Object {
      $_ -notmatch "^\s*TCP\s+(127\.0\.0\.1|\[::1\]|::1):$Port\s+"
    })
    if ($nonLoopback.Count -gt 0) {
      throw "$Name is exposed beyond loopback on port $Port. Refusing to use it."
    }
    return
  }
  $nonLoopback = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
  if ($nonLoopback.Count -gt 0) {
    throw "$Name is exposed beyond loopback on port $Port. Refusing to use it."
  }
}

function Save-ProcessEnvironment {
  param([string[]]$Names)
  $snapshot = @{}
  foreach ($name in $Names) {
    $exists = Test-Path -LiteralPath "Env:\$name"
    $snapshot[$name] = @{
      Exists = $exists
      Value = if ($exists) { [Environment]::GetEnvironmentVariable($name, 'Process') } else { $null }
    }
  }
  return $snapshot
}

function Restore-ProcessEnvironment {
  param([hashtable]$Snapshot)
  foreach ($name in $Snapshot.Keys) {
    $entry = $Snapshot[$name]
    if ($entry.Exists) {
      Set-Item -LiteralPath "Env:\$name" -Value $entry.Value
    } else {
      Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
    }
  }
}

function Normalize-ProcessPath {
  $pathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
  Remove-Item -LiteralPath 'Env:\PATH' -ErrorAction SilentlyContinue
  $env:Path = $pathValue
}

function Resolve-ApplicationCommand {
  param([string]$Name)
  $matches = @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}

function Ensure-LocalCliRuntime {
  $localCommand = Join-Path $LocalRuntime 'bin\lal.cmd'
  if (Test-Path $localCommand) { return $localCommand }
  $installedRuntime = Join-Path $env:LOCALAPPDATA 'LAL\runtime'
  $installedCommand = Join-Path $installedRuntime 'bin\lal.cmd'
  if (-not (Test-Path $installedCommand)) {
    throw 'No Windows LAL runtime is available to isolate. Install the Windows client first.'
  }
  if ($DryRun) {
    Write-Host "  CLI runtime: would copy from $installedRuntime"
    return $installedCommand
  }
  Write-Host 'Creating an isolated copy of the Windows LAL runtime...'
  Copy-Item -LiteralPath $installedRuntime -Destination $LocalRuntime -Recurse
  if (-not (Test-Path $localCommand)) {
    throw 'The isolated Windows LAL runtime copy is incomplete.'
  }
  return $localCommand
}

function Start-LocalCli {
  if (-not (Wait-HttpEndpoint $GatewayHealthUrl 15)) {
    throw "The isolated LAL host is not running at $GatewayUrl. Run start-local-windows.cmd first."
  }
  $effectiveArguments = @($CliArguments)
  if (-not ($effectiveArguments | Where-Object { $_ -eq '--auth-type' -or $_ -like '--auth-type=*' })) {
    $effectiveArguments += @('--auth-type', 'openai')
  }
  & $LocalCliCommand @effectiveArguments
  return $LASTEXITCODE
}

if ($env:OS -ne 'Windows_NT') {
  throw 'This launcher is for native Windows only.'
}

$Node = Resolve-ApplicationCommand 'node.exe'
$Npm = Resolve-ApplicationCommand 'npm.cmd'
if (-not $Node) { throw 'Node.js 22 or newer is required.' }
if (-not $Npm) { throw 'npm.cmd is required. Reinstall Node.js for Windows.' }

$NodeMajor = [int]((& $Node.Source --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required; found $NodeMajor." }
if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) {
  throw 'Web dependencies are missing. Run: npm.cmd --prefix web install'
}
if (-not (Test-Path (Join-Path $Root 'apps\cli\node_modules'))) {
  throw 'CLI dependencies are missing. Run: npm.cmd --prefix apps/cli install'
}
$LocalCliCommand = Ensure-LocalCliRuntime

New-Item -ItemType Directory -Force -Path $StateRoot, $CliHome, $OllamaModels | Out-Null
if (-not (Test-Path $TokenFile)) {
  $bytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  $token = [Convert]::ToBase64String($bytes)
  [IO.File]::WriteAllText($TokenFile, $token, [Text.Encoding]::ASCII)
}
$Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()

$OverriddenEnvironmentNames = @(
  'LAL_HOME',
  'QWEN_HOME',
  'LAL_GATEWAY_URL',
  'LAL_API_KEY',
  'LAL_CLI_TOKEN',
  'LAL_MANAGED',
  'OLLAMA_MODELS',
  'OLLAMA_VULKAN',
  'OLLAMA_IGPU_ENABLE',
  'OLLAMA_KEEP_ALIVE',
  'LAL_OPENVINO_PYTHON',
  'LAL_OPENVINO_MODEL_PATH',
  'LAL_OPENVINO_MODEL_ID',
  'LAL_OPENVINO_CACHE_DIR',
  'LAL_OPENVINO_MAX_PROMPT_LEN'
)
$PreviousEnvironment = Save-ProcessEnvironment $OverriddenEnvironmentNames
try {
  Normalize-ProcessPath
  $env:LAL_HOME = $CliHome
  $env:QWEN_HOME = $CliHome
  $env:LAL_GATEWAY_URL = $GatewayUrl
  $env:LAL_API_KEY = $Token
  $env:LAL_CLI_TOKEN = $Token
  $env:LAL_MANAGED = '1'
  $env:OLLAMA_MODELS = $OllamaModels
  $env:OLLAMA_VULKAN = '1'
  $env:OLLAMA_IGPU_ENABLE = '1'
  # Keep a loaded model resident for an hour after its last use. Ollama's default
  # (5 minutes) forced a cold reload after any short pause; on this box nothing
  # else contends for the iGPU, so staying warm is free and makes both the CLI
  # and the web UI respond immediately on the next turn. The daemon reads this as
  # the default for every request that does not set keep_alive itself.
  $env:OLLAMA_KEEP_ALIVE = '60m'
  if ((Test-Path $OpenVinoPython) -and (Test-Path (Join-Path $OpenVinoModel 'openvino_model.bin'))) {
    $env:LAL_OPENVINO_PYTHON = $OpenVinoPython
    $env:LAL_OPENVINO_MODEL_PATH = $OpenVinoModel
    $env:LAL_OPENVINO_MODEL_ID = 'openvino/qwen3-8b-npu'
    $env:LAL_OPENVINO_CACHE_DIR = $OpenVinoCache
    $env:LAL_OPENVINO_MAX_PROMPT_LEN = '2048'
  }

  Write-Host 'Project-LAL isolated Windows session'
  Write-Host "  Web:       $GatewayUrl"
  Write-Host "  CLI state: $CliHome"
  Write-Host '  Existing user-level LAL state and machine PATH are untouched.'

  $ExistingLocalHost = Wait-HttpEndpoint $GatewayHealthUrl 15
  if ($ExistingLocalHost) {
    Assert-LoopbackListener 8771 'Project-LAL web host'
    Write-Host '  Local host: already running on loopback; reusing it.'
    if ($DryRun) {
      Write-Host 'Dry run complete; the running local host was detected and the CLI was not started.'
      exit 0
    }
    if (-not $NoBrowser -and -not $CliOnly) { Start-Process $GatewayUrl | Out-Null }
    exit (Start-LocalCli)
  }

  if ($CliOnly) {
    Write-Host '  Local host: not running; starting it now.'
  }

  $Ollama = Resolve-ApplicationCommand 'ollama.exe'
  if ($Ollama) {
    if (-not (Test-HttpEndpoint 'http://127.0.0.1:11434/api/version')) {
      if ($DryRun) {
        Write-Host "  Ollama:    would start on 127.0.0.1:11434 with models in $OllamaModels"
      } else {
        $previousOllamaHost = $env:OLLAMA_HOST
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        try {
          $OllamaProcess = Start-Process -FilePath $Ollama.Source -ArgumentList 'serve' -WindowStyle Hidden -PassThru
        } finally {
          if ($null -eq $previousOllamaHost) {
            Remove-Item Env:OLLAMA_HOST
          } else {
            $env:OLLAMA_HOST = $previousOllamaHost
          }
        }
        if (-not (Wait-HttpEndpoint 'http://127.0.0.1:11434/api/version' 15)) {
          throw 'Ollama was found but did not become ready on 127.0.0.1:11434.'
        }
        Assert-LoopbackListener 11434 'Ollama'
        Write-Host '  Ollama:    isolated daemon ready on 127.0.0.1:11434'
      }
    } else {
      Assert-LoopbackListener 11434 'Ollama'
      Write-Host '  Ollama:    using the pre-existing loopback daemon'
      Write-Warning 'The pre-existing daemon may use a different model directory; it remains untouched.'
    }
    Write-Host "  Models:    $OllamaModels"
  } else {
    Write-Host '  Ollama:    not installed (the UI can still start without models)'
  }

  if (Test-TcpPort '127.0.0.1' 8771) {
    throw 'Port 8771 is already in use. Refusing to attach to an unknown process.'
  }

  if ($DryRun) {
    Write-Host 'Dry run complete; no web or CLI process was started.'
    exit 0
  }

  $WebProcess = Start-Process `
    -FilePath $Npm.Source `
    -ArgumentList @('--prefix', 'web', 'run', 'dev', '--', '--hostname', '127.0.0.1', '--port', '8771') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $WebLog `
    -RedirectStandardError $WebErrorLog `
    -PassThru `
    -WindowStyle Hidden

  if (-not (Wait-HttpEndpoint $GatewayUrl 60)) {
    Stop-ProcessTree $WebProcess
    throw "The web host did not become ready. Inspect $WebLog and $WebErrorLog."
  }

  if (-not $NoBrowser -and -not $CliOnly) { Start-Process $GatewayUrl | Out-Null }
  Write-Host 'Local web host is ready. Starting the isolated CLI; exit it to stop the web host.'
  exit (Start-LocalCli)
} finally {
  try {
    Stop-ProcessTree $WebProcess
    Stop-ProcessTree $OllamaProcess
  } finally {
    Restore-ProcessEnvironment $PreviousEnvironment
  }
}
