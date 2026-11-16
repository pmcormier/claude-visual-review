#Requires -Version 7
# Runs every tests/*.tests.ps1 in its own process; exits non-zero if any test failed.
$failed = 0
foreach ($f in Get-ChildItem $PSScriptRoot -Filter *.tests.ps1) {
  Write-Host "`n== $($f.Name)" -ForegroundColor Cyan
  pwsh -NoProfile -File $f.FullName
  if ($LASTEXITCODE) { $failed += [Math]::Max(1, $LASTEXITCODE) }
}
Write-Host "`n$failed failed" -ForegroundColor ($failed ? 'Red' : 'Green')
exit $failed
