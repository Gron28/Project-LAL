param(
  [string]$SshTarget = "gron@main-pc"
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "LocalAILab"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "lab-agent") (Join-Path $InstallDir "lab-agent") -Force
Copy-Item (Join-Path $PSScriptRoot "lal.cmd") (Join-Path $InstallDir "lal.cmd") -Force

[Environment]::SetEnvironmentVariable("LAL_SSH", $SshTarget, "User")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
if ($parts -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $InstallDir) -join ";"), "User")
}

Write-Host "LAL installed in $InstallDir" -ForegroundColor Green
Write-Host "Open a new CMD in any folder and run: lal" -ForegroundColor Cyan
Write-Host "Remote lab: $SshTarget (folder changes sync over Tailscale SSH/OpenSSH)"
