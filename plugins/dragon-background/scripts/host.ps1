function Get-BackgroundHostStatus([int]$Port = 9236) {
  $mains = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -OperationTimeoutSec 8 | Where-Object {
    $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -and $_.CommandLine -notmatch '--type='
  })
  # Skip the slow NetTCPIP module when the port is not listening.
  $portInUse = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port }).Count -gt 0
  # Keep the outer result an array: a single CimInstance has no Count in WinPS 5.1.
  $listeners = @(if ($portInUse) { Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop })
  $debugMain = @($mains | Where-Object { $_.CommandLine -match ("--remote-debugging-port(?:=|\s+)" + $Port + '(?:\s|$)') })
  $ready = $mains.Count -eq 1 -and $debugMain.Count -eq 1 -and $listeners.Count -gt 0
  if ($ready) { foreach ($listener in $listeners) { if ($listener.LocalAddress -notin @('127.0.0.1','::1') -or $listener.OwningProcess -ne $debugMain[0].ProcessId) { $ready = $false } } }
  $main = if ($mains.Count -eq 1) { $mains[0] } else { $null }
  $startTicks = if ($main) { (Get-Process -Id $main.ProcessId).StartTime.Ticks.ToString() } else { $null }
  return @{debugReady=[bool]$ready;mainCount=$mains.Count;mainPid=if($main){[int]$main.ProcessId}else{$null};startTicks=$startTicks;portAvailable=(-not $portInUse -or $ready)}
}
