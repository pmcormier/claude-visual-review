# Shared helpers for tests/*.tests.ps1. Each test file dot-sources this, calls Test for each case, and ends
# with `exit $script:Failures`.
$ErrorActionPreference = 'Stop'
$script:Failures = 0
$script:RepoRoot = Split-Path $PSScriptRoot

function Test([string]$Name, [scriptblock]$Body) {
  try { & $Body; Write-Host "  pass  $Name" -ForegroundColor Green }
  catch { $script:Failures++; Write-Host "  FAIL  $Name`: $_" -ForegroundColor Red }
}

function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw "assert failed: $Message" }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -ne $Actual) { throw "$Message`: expected <$Expected>, got <$Actual>" }
}

function New-TempDir {
  $d = Join-Path ([IO.Path]::GetTempPath()) ('cvr-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory $d | Out-Null
  $d
}

# A temp git repo holding the given files ({ relpath = content }), committed.
function New-TempRepo([hashtable]$Files) {
  $r = New-TempDir
  git -C $r init -q
  git -C $r config user.name test; git -C $r config user.email test; git -C $r config core.autocrlf false
  foreach ($k in $Files.Keys) {
    $p = Join-Path $r $k
    New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
    Set-Content -Path $p -Value $Files[$k] -NoNewline
  }
  git -C $r add -A; git -C $r commit -qm init 2>$null | Out-Null
  $r
}
