@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-windows.ps1" %*
set "LAL_EXIT=%ERRORLEVEL%"
if not "%LAL_EXIT%"=="0" (
  echo.
  echo Project-LAL did not start. Review the error above.
  pause
)
exit /b %LAL_EXIT%
