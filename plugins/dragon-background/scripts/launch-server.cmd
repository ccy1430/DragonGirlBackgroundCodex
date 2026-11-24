@echo off
setlocal DisableDelayedExpansion
set "DRAGON_NODE_CANDIDATE=%DRAGON_BACKGROUND_NODE%"
call :check_node
if not errorlevel 1 goto launch

set "DRAGON_NODE_CANDIDATE=%CODEX_MCP_NODE_PATH%"
call :check_node
if not errorlevel 1 goto launch

for /f "delims=" %%I in ('"%SystemRoot%\System32\where.exe" $PATH:node.exe 2^>nul') do (
  set "DRAGON_NODE_CANDIDATE=%%I"
  call :check_node
  if not errorlevel 1 goto launch
)

echo DragonGirlBackground requires Node.js 24 or newer. Install it on PATH or set DRAGON_BACKGROUND_NODE to its full path. 1>&2
exit /b 1

:check_node
if not defined DRAGON_NODE_CANDIDATE exit /b 1
if not exist "%DRAGON_NODE_CANDIDATE%" exit /b 1
"%DRAGON_NODE_CANDIDATE%" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)" >nul 2>nul
exit /b %errorlevel%

:launch
"%DRAGON_NODE_CANDIDATE%" "%~dp0..\src\server.mjs"
exit /b %errorlevel%
