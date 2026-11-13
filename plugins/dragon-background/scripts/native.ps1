param(
  [ValidateSet('Status','Confirm','Pick')][string]$Action,
  [ValidateRange(1024,65535)][int]$Port = 9236
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Action -eq 'Status') {
  . (Join-Path $PSScriptRoot 'host.ps1')
  Get-BackgroundHostStatus -Port $Port | ConvertTo-Json -Compress
  exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object Drawing.Size(1,1)
$owner.Opacity = 0
$owner.Show()
try {
  if ($Action -eq 'Confirm') {
    $message = "当前 ChatGPT / Codex 是普通启动，背景需要重启后才能开启。`n`n重启可能中断正在运行的任务，未发送的输入可能丢失。将关闭原实例后再启动一个实例，不会双开。`n`n是否现在重启？"
    $answer = [Windows.Forms.MessageBox]::Show($owner,$message,'启用背景需要重启',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question,[Windows.Forms.MessageBoxDefaultButton]::Button2)
    @{accepted=($answer -eq [Windows.Forms.DialogResult]::Yes)} | ConvertTo-Json -Compress
  } else {
    $dialog = New-Object Windows.Forms.OpenFileDialog
    $dialog.Title = '选择 Codex 背景图片（只在本机使用）'
    $dialog.Filter = '图片 (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    $selected = if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { $dialog.FileName } else { $null }
    @{path=$selected} | ConvertTo-Json -Compress
    $dialog.Dispose()
  }
} finally { $owner.Close(); $owner.Dispose() }
