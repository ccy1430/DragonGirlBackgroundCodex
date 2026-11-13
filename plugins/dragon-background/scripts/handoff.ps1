function Wait-BackgroundRestartCommit([string]$CommitPath,[string]$ExpectedId,[int]$TimeoutMilliseconds=15000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while([DateTime]::UtcNow -lt $deadline) {
    if(Test-Path -LiteralPath $CommitPath) {
      $receipt = [IO.File]::ReadAllText($CommitPath).Trim()
      if($receipt -ne $ExpectedId) { throw '设置保存回执不匹配，已取消重启。' }
      return
    }
    Start-Sleep -Milliseconds 50
  }
  throw '未收到设置保存回执，已取消重启。'
}
