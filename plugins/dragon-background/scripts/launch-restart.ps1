param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$helper = Join-Path $PSScriptRoot 'restart.ps1'
. (Join-Path $PSScriptRoot 'independent-process.ps1')
$helperArguments = '-NoLogo -NoProfile -NonInteractive -File "'+$helper+'" -RequestPath "'+$RequestPath+'"'
Start-BackgroundIndependentProcess -ExecutablePath (Join-Path $PSHOME 'powershell.exe') -Arguments $helperArguments -WorkingDirectory $PSScriptRoot | ConvertTo-Json -Compress
