param(
  [string]$LogPath,
  [string]$Code,
  [string]$Detail,
  [string]$Release,
  [string]$Arch,
  [string]$Session,
  [string]$Updated,
  [switch]$NoUi
)

# Installer diagnostics stay on this computer. No reporting endpoint or device ID.
$ErrorActionPreference = 'Stop'
$statusPath = Join-Path $env:TEMP 'aionui-installer-report.json'
$staging = Join-Path $env:TEMP ('aelix-studio-report-' + [Guid]::NewGuid().ToString('N'))
$archive = $staging + '.zip'
try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $report = [ordered]@{
    schema = 'aelix-studio.installer-report/1'
    createdAt = (Get-Date -Format o)
    code = $Code
    detail = $Detail
    release = $Release
    arch = $Arch
    session = $Session
    updated = $Updated
    logIncluded = ($LogPath -and (Test-Path -LiteralPath $LogPath -PathType Leaf))
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging 'diagnostics.json') -Encoding UTF8
  if ($report.logIncluded) {
    Copy-Item -LiteralPath $LogPath -Destination (Join-Path $staging 'installer.log')
  }
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $archive
  @{ status = 'saved'; path = $archive; code = $Code } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  if (-not $NoUi) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Report saved locally / 报告已保存到本地：`r`n$archive`r`nNothing was sent. / 未发送任何信息。", 'Aelix Studio', 'OK', 'Information') | Out-Null
  }
} catch {
  @{ status = 'failed'; code = $Code; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  if (-not $NoUi) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Could not save the report. The installer log is at / 无法保存报告。安装日志位于：`r`n$LogPath", 'Aelix Studio', 'OK', 'Error') | Out-Null
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
