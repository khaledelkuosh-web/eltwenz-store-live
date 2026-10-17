$ErrorActionPreference = 'Stop'
$BundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$InstalledNode = Get-Command node -ErrorAction SilentlyContinue
$ServerFile = Join-Path $PSScriptRoot 'server.js'
if (Test-Path -LiteralPath $BundledNode) {
  & $BundledNode $ServerFile
} elseif ($InstalledNode) {
  & $InstalledNode.Source $ServerFile
} else {
  Write-Host 'محتاج تثبّت Node.js LTS الأول. بعد التثبيت شغّل start-store.cmd تاني.' -ForegroundColor Yellow
  Read-Host 'اضغط Enter للإغلاق'
}
