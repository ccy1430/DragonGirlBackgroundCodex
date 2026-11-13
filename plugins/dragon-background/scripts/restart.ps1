param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$sessionMutex = $null
$mutexOwned = $false
$request = $null
$resultCode = 0
function Write-RestartState([string]$Phase,[string]$Message,[int]$MainProcessId=0) {
  $state = @{id=$request.id;phase=$Phase;message=$Message;helperPid=$PID;mainPid=$MainProcessId;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  foreach($statePath in @($request.statusPath,(Join-Path $request.dataDirectory 'restart-state.json'))) {
    $temporary = $statePath + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary,$state,[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
  }
  Add-Content -LiteralPath (Join-Path $request.dataDirectory 'restart.log') -Value $state -Encoding UTF8
}
function Assert-OriginalInstance {
  $current = Get-BackgroundHostStatus -Port $request.port
  if($current.mainCount -ne 1 -or $current.mainPid -ne $request.mainPid -or $current.startTicks -ne $request.startTicks) { throw 'Codex 实例已改变，取消重启，未打开第二个实例。' }
  if(-not $current.portAvailable -or $current.debugReady) { throw '本机调试端口状态已改变，取消重启。' }
}
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  . (Join-Path $PSScriptRoot 'host.ps1')
  . (Join-Path $PSScriptRoot 'handoff.ps1')
  Write-RestartState 'starting' '正在检查重启条件。'
  $sessionMutex = New-Object Threading.Mutex($false,'Local\CodexDragonBackgroundSingleLauncher')
  try { $mutexOwned = $sessionMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $mutexOwned = $true }
  if(-not $mutexOwned) { throw '已有一次背景重启正在进行，请勿重复点击。' }
  Assert-OriginalInstance
  $rootProcess = Get-Process -Id $request.mainPid
  $exe = $rootProcess.Path
  if(-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $request.nodePath)) { throw '启动文件不可用，未关闭应用。' }
  if($request.mode -eq 'probe') { Write-RestartState 'probe-ok' '重启助手检查通过；本次仅检查，未关闭或启动应用。' $request.mainPid; return }
  Write-RestartState 'ready' '重启助手已就绪，等待设置保存完成。' $request.mainPid
  Wait-BackgroundRestartCommit -CommitPath $request.commitPath -ExpectedId $request.id
  Start-Sleep -Milliseconds 1500
  Assert-OriginalInstance
  $tree = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'")
  $ownedIds = New-Object 'System.Collections.Generic.HashSet[int]'
  $null = $ownedIds.Add([int]$request.mainPid)
  do { $added=$false; foreach($item in $tree) { if($item.ExecutablePath -eq $exe -and $ownedIds.Contains([int]$item.ParentProcessId) -and $ownedIds.Add([int]$item.ProcessId)){$added=$true} } } while($added)
  $snapshots = @(foreach($ownedId in $ownedIds){$p=Get-Process -Id $ownedId -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{Id=$p.Id;Ticks=$p.StartTime.Ticks.ToString()}}})
  Write-RestartState 'closing' '正在关闭原 Codex 实例。' $request.mainPid
  $null = $rootProcess.CloseMainWindow()
  $deadline = (Get-Date).AddSeconds(4)
  while((Get-Process -Id $request.mainPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 250}
  foreach($snapshot in @($snapshots | Sort-Object @{Expression={if($_.Id -eq $request.mainPid){0}else{1}}})){
    $p=Get-Process -Id $snapshot.Id -ErrorAction SilentlyContinue
    if($p -and $p.Path -eq $exe -and $p.StartTime.Ticks.ToString() -eq $snapshot.Ticks){Stop-Process -Id $p.Id -Force}
  }
  Start-Sleep -Milliseconds 600
  $remaining = Get-BackgroundHostStatus -Port $request.port
  if($remaining.mainCount){throw '仍有 Codex 实例，取消启动以避免双开。'}
  $profile = Join-Path $request.dataDirectory 'profile'
  New-Item -ItemType Directory -Path $profile -Force | Out-Null
  Write-RestartState 'launching' '正在启动一个带背景连接的 Codex 实例。'
  $appArgs = @('--remote-debugging-address=127.0.0.1',"--remote-debugging-port=$($request.port)",('--user-data-dir="'+$profile+'"'))
  $launched = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
  $deadline = (Get-Date).AddSeconds(45)
  $ready = $false
  while((Get-Date) -lt $deadline){
    Start-Sleep -Milliseconds 500
    $status = Get-BackgroundHostStatus -Port $request.port
    if($status.debugReady -and $status.mainCount -eq 1 -and $status.mainPid -eq $launched.Id){$ready=$true;break}
  }
  if(-not $ready){throw '未建立本机调试连接，背景没有开启。未再次打开 Codex。'}
  $agentArgs = @(('"'+(Join-Path $request.pluginRoot 'src\agent.mjs')+'"'),'--main-pid',"$($launched.Id)",'--data',('"'+$request.dataDirectory+'"'))
  Start-Process -FilePath $request.nodePath -ArgumentList $agentArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $request.dataDirectory 'agent.stdout.log') -RedirectStandardError (Join-Path $request.dataDirectory 'agent.stderr.log') | Out-Null
  Write-RestartState 'complete' 'Codex 已重新启动，背景工作进程已启动。' $launched.Id
  Remove-Item -LiteralPath (Join-Path $request.dataDirectory 'last-error.txt') -ErrorAction SilentlyContinue
} catch {
  $resultCode = 1
  if($request) {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $request.dataDirectory 'last-error.txt') -Encoding UTF8
    Write-RestartState 'failed' $_.Exception.Message
  }
} finally {
  if($mutexOwned){$sessionMutex.ReleaseMutex()}
  if($sessionMutex){$sessionMutex.Dispose()}
  if($request){Remove-Item -LiteralPath $request.commitPath -ErrorAction SilentlyContinue}
}
exit $resultCode
