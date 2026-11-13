function Start-BackgroundIndependentProcess([string]$ExecutablePath,[string]$Arguments,[string]$WorkingDirectory) {
  # Local WMI process creation does not inherit the caller's Windows Job Object.
  # Keep a hidden console: WinPS 5.1 exits immediately with DETACHED_PROCESS.
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]16777232;WinstationDesktop='winsta0\default'}
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('"'+$ExecutablePath+'" '+$Arguments);CurrentDirectory=$WorkingDirectory;ProcessStartupInformation=$startup} -OperationTimeoutSec 8
  if($created.ReturnValue -ne 0) { throw "独立重启助手创建失败（Windows 返回码 $($created.ReturnValue)），未关闭应用。" }
  $helper = Get-Process -Id $created.ProcessId -ErrorAction Stop
  $currentSession = (Get-Process -Id $PID).SessionId
  if($helper.SessionId -ne $currentSession) { throw '独立助手不在当前登录会话中，未提交重启。' }
  return @{pid=[int]$created.ProcessId;sessionId=$helper.SessionId;launchMethod='local-wmi'}
}
