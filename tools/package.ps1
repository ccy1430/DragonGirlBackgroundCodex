param([string]$DestinationDirectory = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $releaseRoot 'plugins\dragon-background'
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseVersion = $manifest.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$outputDirectory = if ([string]::IsNullOrWhiteSpace($DestinationDirectory)) { Join-Path $releaseRoot 'dist' } else { [IO.Path]::GetFullPath($DestinationDirectory) }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

function Write-ReleaseZip([string]$ArchivePath, [string]$BasePath, [string[]]$RelativeFiles, [switch]$IncludeReadme) {
  $actualArchive = [IO.Path]::GetFullPath($ArchivePath)
  if (-not $actualArchive.StartsWith($outputDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must stay inside this repository dist directory.' }
  if (Test-Path -LiteralPath $actualArchive) { throw "Release archive already exists: $actualArchive" }
  $stream = [IO.File]::Open($actualArchive, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($relative in @($RelativeFiles | Sort-Object -Unique)) {
      $zipPath = $relative.Replace('\', '/')
      if ([IO.Path]::IsPathRooted($relative) -or $zipPath.Split('/') -contains '..') { throw 'Unsafe archive entry.' }
      $source = [IO.Path]::GetFullPath((Join-Path $BasePath $relative))
      if (-not $source.StartsWith($BasePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source escaped package root.' }
      $entry = $archive.CreateEntry($zipPath, [IO.Compression.CompressionLevel]::Optimal)
      $inputStream = [IO.File]::OpenRead($source)
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
    if ($IncludeReadme -and $RelativeFiles -notcontains 'README.md') {
      $entry = $archive.CreateEntry('README.md', [IO.Compression.CompressionLevel]::Optimal)
      $inputStream = [IO.File]::OpenRead((Join-Path $releaseRoot 'README.md'))
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
  return $actualArchive
}

$pluginFiles = @(Get-ChildItem -LiteralPath $pluginRoot -File -Force -Recurse | ForEach-Object { $_.FullName.Substring($pluginRoot.Length + 1) })
$marketplaceFiles = @('.agents\plugins\marketplace.json', '.gitignore', '.gitattributes', 'package.json', 'README.md')
$marketplaceFiles += @($pluginFiles | ForEach-Object { 'plugins\dragon-background\' + $_ })
foreach ($folder in @('tools', 'tests')) {
  $marketplaceFiles += @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot $folder) -File -Force | Where-Object { $_.Extension -in @('.md', '.mjs', '.ps1') } | ForEach-Object { $_.FullName.Substring($releaseRoot.Length + 1) })
}
$archives = @(
  (Write-ReleaseZip (Join-Path $outputDirectory "DragonGirlBackground-$releaseVersion-plugin.zip") $pluginRoot $pluginFiles -IncludeReadme),
  (Write-ReleaseZip (Join-Path $outputDirectory "DragonGirlBackground-$releaseVersion-marketplace.zip") $releaseRoot $marketplaceFiles)
)
$hashes = @($archives | ForEach-Object { $hash = Get-FileHash -LiteralPath $_ -Algorithm SHA256; '{0}  {1}' -f $hash.Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_) })
[IO.File]::WriteAllText((Join-Path $outputDirectory 'SHA256SUMS.txt'), ($hashes -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
$archives | ForEach-Object { Get-Item -LiteralPath $_ } | Select-Object Name,Length,FullName | ConvertTo-Json
