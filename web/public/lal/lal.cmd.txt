@echo off
setlocal
set "LAL_HOME=%USERPROFILE%\.lal"
if /I "%~1"=="update" goto update
set "QWEN_HOME=%LAL_HOME%"
set "LAL_MANAGED=1"
if exist "%LAL_HOME%\system.md" set "QWEN_SYSTEM_MD=%LAL_HOME%\system.md"
if exist "%LAL_HOME%\.env" for /f "usebackq tokens=1,* delims==" %%A in ("%LAL_HOME%\.env") do if "%%A"=="LAL_API_KEY" set "LAL_API_KEY=%%B"
if exist "%LAL_HOME%\client-host" for /f "usebackq delims=" %%A in ("%LAL_HOME%\client-host") do set "LAL_HOST=%%A"
if exist "%LAL_HOME%\device-id" for /f "usebackq delims=" %%A in ("%LAL_HOME%\device-id") do set "LAL_DEVICE_ID=%%A"
if exist "%LAL_HOME%\device-name" for /f "usebackq delims=" %%A in ("%LAL_HOME%\device-name") do set "LAL_DEVICE_NAME=%%A"
if exist "%LAL_HOME%\platform" for /f "usebackq delims=" %%A in ("%LAL_HOME%\platform") do set "LAL_PLATFORM=%%A"
if exist "%LAL_HOME%\client-version" for /f "usebackq delims=" %%A in ("%LAL_HOME%\client-version") do set "LAL_CLIENT_VERSION=%%A"
if defined LAL_API_KEY if defined LAL_DEVICE_ID powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($env:LAL_HOST + '/api/lal/heartbeat') -Headers @{ Authorization=('Bearer ' + $env:LAL_API_KEY); 'X-LAL-Device-Id'=$env:LAL_DEVICE_ID; 'X-LAL-Device-Name'=$env:LAL_DEVICE_NAME; 'X-LAL-Platform'=$env:LAL_PLATFORM; 'X-LAL-Client-Version'=$env:LAL_CLIENT_VERSION } | Out-Null } catch {}"
if not exist "%LOCALAPPDATA%\LAL\runtime\bin\lal.cmd" goto missing
call "%LOCALAPPDATA%\LAL\runtime\bin\lal.cmd" %*
exit /b %ERRORLEVEL%

:missing
echo LAL runtime is missing. Run: lal update 1>&2
exit /b 1

:update
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=(Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.lal\client-host') -Raw).Trim(); $t=((Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.lal\.env') | Select-String '^LAL_API_KEY=').Line -replace '^LAL_API_KEY=',''); $env:LAL_HOST=$h; $env:LAL_TOKEN=$t; Invoke-Expression (Invoke-RestMethod ($h + '/lal/install.ps1'))"
exit /b %ERRORLEVEL%
