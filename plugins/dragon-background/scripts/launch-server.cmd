@echo off
setlocal DisableDelayedExpansion
if defined DRAGON_BACKGROUND_NODE goto configured
where node.exe >nul 2>nul
if errorlevel 1 (
  echo DragonGirlBackground requires Node.js 24 or newer on PATH. You can also set DRAGON_BACKGROUND_NODE to node.exe's full path. 1>&2
  exit /b 1
)
set "DRAGON_BACKGROUND_NODE=node.exe"
:configured
"%DRAGON_BACKGROUND_NODE%" -e "if(Number(process.versions.node.split('.')[0])<24){process.stderr.write('DragonGirlBackground requires Node.js 24 or newer.\n');process.exit(1)}"
if errorlevel 1 exit /b %errorlevel%
"%DRAGON_BACKGROUND_NODE%" "%~dp0..\src\server.mjs"
exit /b %errorlevel%
