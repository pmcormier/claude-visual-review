#Requires -Version 7
. "$PSScriptRoot/lib.ps1"

# The dashboard's Node tests live in tests/dashboard/ (not under global/, which is installed).
Test 'DashboardNodeTests' {
  $out = node --test (Join-Path $PSScriptRoot 'dashboard') 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "node --test exited $code`n$($out -join "`n")" }
}

Complete-Tests
