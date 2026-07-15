$ErrorActionPreference = 'Stop'
$HostUrl = if ($env:LAL_HOST) { $env:LAL_HOST.TrimEnd('/') } else { 'https://main-pc.tail3ba909.ts.net:8443' }
$LalHome = Join-Path $HOME '.lal'
$BinDir = Join-Path $env:LOCALAPPDATA 'LAL\bin'
$RuntimeDir = Join-Path $env:LOCALAPPDATA 'LAL\runtime'
$Manifest = Invoke-RestMethod "$HostUrl/lal/manifest.json"
New-Item -ItemType Directory -Force -Path $LalHome, $BinDir | Out-Null

$DeviceIdFile = Join-Path $LalHome 'device-id'
$DeviceNameFile = Join-Path $LalHome 'device-name'
$PlatformFile = Join-Path $LalHome 'platform'
$DeviceId = if (Test-Path $DeviceIdFile) { (Get-Content $DeviceIdFile -Raw).Trim() } else { [guid]::NewGuid().ToString('N') }
$DeviceName = if (Test-Path $DeviceNameFile) { (Get-Content $DeviceNameFile -Raw).Trim() } else { $env:COMPUTERNAME }
$Platform = "$([System.Environment]::OSVersion.VersionString)/$env:PROCESSOR_ARCHITECTURE"
[IO.File]::WriteAllText($DeviceIdFile, "$DeviceId`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText($DeviceNameFile, "$DeviceName`r`n", [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($PlatformFile, "$Platform`r`n", [Text.Encoding]::UTF8)

$Token = $env:LAL_TOKEN
$EnvFile = Join-Path $LalHome '.env'
if (-not $Token -and (Test-Path $EnvFile)) {
  $Line = Get-Content $EnvFile | Where-Object { $_ -like 'LAL_API_KEY=*' } | Select-Object -First 1
  if ($Line) { $Token = $Line.Substring('LAL_API_KEY='.Length) }
}
if (-not $Token) { $Token = Read-Host 'LAL pairing token' }
if (-not $Token) { throw 'A pairing token is required.' }
$Headers = @{
  Authorization = "Bearer $Token"
  'X-LAL-Device-Id' = $DeviceId
  'X-LAL-Device-Name' = $DeviceName
  'X-LAL-Platform' = $Platform
  'X-LAL-Client-Version' = [string]$Manifest.clientVersion
}
$SettingsText = (Invoke-WebRequest -UseBasicParsing -Headers $Headers "$HostUrl/api/lal/client-settings").Content
$SystemPromptPath = Join-Path $LalHome 'system.md'
$SystemBasePromptPath = Join-Path $LalHome 'system.base.md'
$SystemLocalPromptPath = Join-Path $LalHome 'system.local.md'
Invoke-WebRequest -UseBasicParsing -OutFile $SystemBasePromptPath "$HostUrl/lal/system.md"
if (-not (Test-Path $SystemLocalPromptPath)) {
  [IO.File]::WriteAllText($SystemLocalPromptPath, '# Your local LAL prompt additions. This file is preserved by lal update.' + "`r`n", [Text.Encoding]::UTF8)
}
$SystemPrompt = (Get-Content -LiteralPath $SystemBasePromptPath -Raw) + "`r`n`r`n---`r`n`r`n# Owner additions (system.local.md)`r`n`r`n" + (Get-Content -LiteralPath $SystemLocalPromptPath -Raw)
[IO.File]::WriteAllText($SystemPromptPath, $SystemPrompt, [Text.Encoding]::UTF8)

$RuntimeFile = Join-Path $LalHome 'runtime-version'
$InstalledRuntime = if (Test-Path $RuntimeFile) { (Get-Content $RuntimeFile -Raw).Trim() } else { '' }
$RuntimeCommand = Join-Path $RuntimeDir 'bin\lal.cmd'
$ExpectedRuntime = [string]$Manifest.lalRuntimeVersion
if ($InstalledRuntime -ne $ExpectedRuntime -or -not (Test-Path $RuntimeCommand)) {
  $TempDir = Join-Path ([IO.Path]::GetTempPath()) ("lal-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  try {
    $Archive = Join-Path $TempDir 'lal-cli-win-x64.zip'
    Invoke-WebRequest -UseBasicParsing -OutFile $Archive "$HostUrl$($Manifest.windowsArchive)"
    $ActualHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($ActualHash -ne ([string]$Manifest.windowsSha256).ToLowerInvariant()) {
      throw "LAL runtime checksum mismatch. Expected $($Manifest.windowsSha256), got $ActualHash."
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir -Force
    $StagedRuntime = Join-Path $TempDir 'lal-cli'
    if (-not (Test-Path (Join-Path $StagedRuntime 'bin\lal.cmd'))) { throw 'Invalid LAL runtime archive.' }
    $OldRuntime = "$RuntimeDir.old"
    if (Test-Path $OldRuntime) { Remove-Item -Recurse -Force $OldRuntime }
    if (Test-Path $RuntimeDir) { Move-Item -Force $RuntimeDir $OldRuntime }
    try {
      Move-Item -Force $StagedRuntime $RuntimeDir
    } catch {
      if (Test-Path $OldRuntime) { Move-Item -Force $OldRuntime $RuntimeDir }
      throw
    }
    if (Test-Path $OldRuntime) { Remove-Item -Recurse -Force $OldRuntime }
  } finally {
    if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
  }
}

$WrapperContent = (Invoke-WebRequest -UseBasicParsing "$HostUrl/lal/lal.cmd.txt").Content
$Wrapper = if ($WrapperContent -is [byte[]]) {
  [Text.Encoding]::UTF8.GetString($WrapperContent)
} else {
  [string]$WrapperContent
}
$WrapperPath = Join-Path $BinDir 'lal.cmd'
[IO.File]::WriteAllText($WrapperPath, $Wrapper, [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $BinDir 'LAL.cmd'), $Wrapper, [Text.Encoding]::ASCII)
[IO.File]::WriteAllText($EnvFile, "LAL_API_KEY=$Token`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $LalHome 'client-host'), "$HostUrl`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $LalHome 'client-version'), "$($Manifest.clientVersion)`r`n", [Text.Encoding]::ASCII)
[IO.File]::WriteAllText($RuntimeFile, "$ExpectedRuntime`r`n", [Text.Encoding]::ASCII)
$SettingsPath = Join-Path $LalHome 'settings.json'
$SettingsBackupPath = Join-Path $LalHome 'settings.pre-managed.json'
$ManagedSettings = $SettingsText | ConvertFrom-Json
$CurrentSettings = [pscustomobject]@{}
if (Test-Path $SettingsPath) {
  if (-not (Test-Path $SettingsBackupPath)) { Copy-Item -LiteralPath $SettingsPath -Destination $SettingsBackupPath }
  try {
    $ParsedSettings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    if ($ParsedSettings -is [pscustomobject]) { $CurrentSettings = $ParsedSettings }
  } catch {
    Write-Warning 'Existing settings.json was invalid. LAL preserved a backup and repaired its managed connection.'
  }
}
function Set-LalSettingProperty {
  param([object]$Target, [string]$Name, [object]$Value)
  $Target | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force
}
$CurrentGeneral = $CurrentSettings.general
if ($null -eq $CurrentGeneral -or $CurrentGeneral -isnot [pscustomobject]) { $CurrentGeneral = [pscustomobject]@{} }
Set-LalSettingProperty $CurrentGeneral 'enableAutoUpdate' $false
Set-LalSettingProperty $CurrentSettings '$version' $ManagedSettings.'$version'
Set-LalSettingProperty $CurrentSettings 'general' $CurrentGeneral
Set-LalSettingProperty $CurrentSettings 'privacy' $ManagedSettings.privacy
Set-LalSettingProperty $CurrentSettings 'telemetry' $ManagedSettings.telemetry
Set-LalSettingProperty $CurrentSettings 'tools' $ManagedSettings.tools
Set-LalSettingProperty $CurrentSettings 'context' $ManagedSettings.context
Set-LalSettingProperty $CurrentSettings 'security' $ManagedSettings.security
Set-LalSettingProperty $CurrentSettings 'model' $ManagedSettings.model
Set-LalSettingProperty $CurrentSettings 'modelProviders' $ManagedSettings.modelProviders
$MergedSettingsText = $CurrentSettings | ConvertTo-Json -Depth 100
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($SettingsPath, $MergedSettingsText, $Utf8NoBom)

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $BinDir) {
  $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }
try { Invoke-WebRequest -UseBasicParsing -Method Post -Headers $Headers "$HostUrl/api/lal/heartbeat" | Out-Null } catch {}
Write-Host "LAL $($Manifest.clientVersion) installed or updated. Sessions and preferences were preserved; the managed connection was refreshed."
Write-Host 'Open a new CMD or PowerShell window, cd into any project, and run: lal'
