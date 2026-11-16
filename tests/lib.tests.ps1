#Requires -Version 7
. "$PSScriptRoot/lib.ps1"

Test 'TestFileRemovesItsTempFolders' {
  $work = New-TempDir
  $script = Join-Path $work 'one.tests.ps1'
  $lib = (Join-Path $PSScriptRoot 'lib.ps1') -replace "'", "''"
  Set-Content $script ". '$lib'`n`$d = New-TempDir`nSet-Content (Join-Path `$d 'f.txt') 'x'`nWrite-Output `$d`nComplete-Tests"
  $made = pwsh -NoProfile -File $script
  Assert-Equal 0 $LASTEXITCODE 'exit code'
  Assert-True ($made -and -not (Test-Path $made)) "temp folder removed: $made"
}

Complete-Tests
