param([int]$InstallerPid, [string]$Output)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$all = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($InstallerPid)
for ($i = 0; $i -lt 8; $i++) {
  foreach ($p in $all) { if ($owned.Contains([int]$p.ParentProcessId)) { [void]$owned.Add([int]$p.ProcessId) } }
}
$all | Where-Object { $owned.Contains([int]$_.ProcessId) } |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Output 'processes.json')
Get-ChildItem $env:TEMP -Filter 'aionui-installer-*-log.jsonl' |
  ForEach-Object { Copy-Item $_.FullName -Destination $Output -Force }
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image = [System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
  $image.Save((Join-Path $Output 'desktop.png'))
  $graphics.Dispose(); $image.Dispose()
} catch { $_.Exception.Message | Set-Content (Join-Path $Output 'screenshot-error.txt') }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$InstallerPid)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  $windows | ForEach-Object { @{ name=$_.Current.Name; class=$_.Current.ClassName; type=$_.Current.ControlType.ProgrammaticName } } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Output 'windows.json')
} catch { $_.Exception.Message | Set-Content (Join-Path $Output 'uia-error.txt') }
