@echo off
rem prompt-optimize: one-click setup. All logic lives in node (cli.mjs setup).
rem
rem KEEP THIS FILE PURE ASCII WITH CRLF LINE ENDINGS.
rem Reason: cmd decodes .bat text with the OEM codepage (936/GBK on zh-CN), but if
rem this file were saved as UTF-8, the multi-byte Chinese characters would shift
rem cmd's line offsets and swallow the first characters of the following lines,
rem producing bogus errors like:  'ompt' is not recognized as an internal command.
rem That is why every Chinese message is printed by node instead of by this file.
cd /d "%~dp0"
where node.exe >nul 2>&1 || echo [X] Node.js not found in PATH - please install Node.js first.
node cli.mjs setup
echo.
pause
