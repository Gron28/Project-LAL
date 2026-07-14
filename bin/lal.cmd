@echo off
setlocal
set "LAL_DIR=%~dp0"
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 "%LAL_DIR%lab-agent" %*
exit /b %errorlevel%

:use_python
python "%LAL_DIR%lab-agent" %*
exit /b %errorlevel%
