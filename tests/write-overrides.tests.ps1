#Requires -Version 7
. "$PSScriptRoot/lib.ps1"
$script = Join-Path $RepoRoot 'global/bmad/write_overrides.py'

# Runs write_overrides.py against a fresh BMAD project with a temp home. Returns the project root.
function Invoke-Overrides([string]$TempHome, [string]$Project) {
  if (-not $Project) { $Project = New-TempDir; New-Item -ItemType Directory (Join-Path $Project '_bmad/custom') | Out-Null }
  $saved = $env:USERPROFILE, $env:HOME
  try { $env:USERPROFILE = $TempHome; $env:HOME = $TempHome; python -I $script $Project | Out-Null }
  finally { $env:USERPROFILE, $env:HOME = $saved }
  $Project
}

function New-TempHome([switch]$WithFable) {
  $h = New-TempDir
  New-Item -ItemType Directory (Join-Path $h '.claude/bmad') | Out-Null
  if ($WithFable) { Set-Content (Join-Path $h '.claude/bmad/fable-final-review.md') 'fable' }
  $h
}

Test 'NoFableWithoutComponent' {
  $p = Invoke-Overrides (New-TempHome)
  $hits = Get-ChildItem (Join-Path $p '_bmad/custom') | Select-String 'fable-final-review'
  Assert-Equal 0 @($hits).Count 'override files mentioning fable-final-review'
  Assert-True (Test-Path (Join-Path $p '_bmad/custom/bmad-prd.user.toml')) 'review overrides still written'
}

Test 'FableWithComponent' {
  $p = Invoke-Overrides (New-TempHome -WithFable)
  Assert-True ((Get-Content -Raw (Join-Path $p '_bmad/custom/bmad-prd.user.toml')) -match 'fable-final-review') 'bmad-prd has the Fable line'
}

Test 'ExistingOverrideGainsFableLineOnce' {
  $h = New-TempHome
  $p = Invoke-Overrides $h
  Set-Content (Join-Path $h '.claude/bmad/fable-final-review.md') 'fable'
  Invoke-Overrides $h $p | Out-Null
  Invoke-Overrides $h $p | Out-Null
  $n = @(Select-String -Path (Join-Path $p '_bmad/custom/bmad-prd.user.toml') -Pattern 'fable-final-review').Count
  Assert-Equal 1 $n 'Fable lines in bmad-prd'
}

exit $script:Failures
