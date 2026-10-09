@echo off
rem prompt-optimize: full uninstall. All logic lives in node (cli.mjs uninstall).
rem KEEP THIS FILE PURE ASCII WITH CRLF LINE ENDINGS (see the setup bat for why).
cd /d "%~dp0"
where node.exe >nul 2>&1 || echo [X] Node.js not found in PATH - please install Node.js first.
node cli.mjs uninstall
echo.
pause
