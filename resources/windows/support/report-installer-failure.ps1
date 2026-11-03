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
$messages = $null
try {
  # These keys mirror all configured renderer locales; no reporting service is used.
  $localized = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'report-localization.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $culture = [Globalization.CultureInfo]::CurrentUICulture.Name
  $language = $culture.Split('-')[0]
  $messages = $localized.PSObject.Properties[$culture].Value
  if (-not $messages -and $culture -match '^zh.*(TW|HK|Hant)') { $messages = $localized.'zh-TW' }
  if (-not $messages) {
    $fallback = $localized.PSObject.Properties | Where-Object { $_.Name.StartsWith($language + '-') } | Select-Object -First 1
    if ($fallback) { $messages = $fallback.Value }
  }
  if (-not $messages) { $messages = $localized.'en-US' }

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
    [System.Windows.Forms.MessageBox]::Show(($messages.'settings.bugReportSuccess' + "`r`n" + $archive), 'Aelix Studio', 'OK', 'Information') | Out-Null
  }
} catch {
  @{ status = 'failed'; code = $Code; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  if (-not $NoUi) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(($(if ($messages) { $messages.'settings.bugReportError' } else { $_.Exception.Message }) + "`r`n" + $LogPath), 'Aelix Studio', 'OK', 'Error') | Out-Null
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
