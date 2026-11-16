#Requires -Version 7
<#
.SYNOPSIS
  Fails when a tracked file holds personal data: a local drive path, an email address, a claude.ai artifact
  link, or a term from your own term list.

.DESCRIPTION
  Prints `path:line: rule` per hit and exits 1 on any hit, 0 otherwise. A term hit is reported by its number
  in the term list (`term:3`), never by the term itself, so the output never leaks it. Binary files are skipped.

.PARAMETER Root
  The repo to check. Default: this repo.

.PARAMETER TermsFile
  One term per line, matched case-insensitively; blank lines and lines starting with # are ignored. Keep it
  outside the repo. Default: ~/.claude/visual-review/personal-terms.txt. If it's missing, only the generic
  rules run.

.PARAMETER Staged
  Check the staged content of staged files (for a pre-commit hook) instead of every tracked file.
#>
param(
  [string]$Root = (Split-Path $PSScriptRoot),
  [string]$TermsFile = (Join-Path $HOME '.claude/visual-review/personal-terms.txt'),
  [switch]$Staged
)
$ErrorActionPreference = 'Stop'

$rules = [ordered]@{
  'drive-path'    = '\b[A-Za-z]:[\\/]'
  'bash-path'     = '(^|[\s"''(=`])/[A-Za-z]/(Users|Development|home)\b'
  'email'         = '[\w.+-]+@[\w-]+\.[A-Za-z][\w.]*'
  'artifact-link' = 'claude\.ai/(code/)?artifact/'
}
if (-not (Test-Path $TermsFile)) { [Console]::Error.WriteLine("warning: no term list at $TermsFile; generic rules only") }
else {
  $n = 0
  foreach ($t in Get-Content $TermsFile) {
    $t = $t.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $rules["term:$((++$n))"] = '(?i)' + [regex]::Escape($t)
  }
}

$paths = if ($Staged) { git -c core.quotePath=false -C $Root diff --cached --name-only --diff-filter=ACMR }
         else { git -c core.quotePath=false -C $Root ls-files }
$hits = 0
foreach ($p in $paths) {
  foreach ($name in $rules.Keys) {
    if ($p -match $rules[$name]) { Write-Output "${p}: file name: $name"; $hits++ }
  }
  $bytes = if ($Staged) {
    $tmp = New-TemporaryFile
    cmd /c "git -C `"$Root`" show `":$p`" > `"$tmp`""
    if ($LASTEXITCODE) { Write-Output "${p}: could not read the staged copy"; $hits++ }
    [IO.File]::ReadAllBytes($tmp); Remove-Item $tmp
  } else {
    $full = Join-Path $Root $p
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    [IO.File]::ReadAllBytes($full)
  }
  if ([Array]::IndexOf($bytes, [byte]0, 0, [Math]::Min($bytes.Length, 8000)) -ge 0) { continue }
  $lines = [Text.Encoding]::UTF8.GetString($bytes) -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    foreach ($name in $rules.Keys) {
      if ($lines[$i] -match $rules[$name]) { Write-Output "${p}:$($i + 1): $name"; $hits++ }
    }
  }
}
exit ([int]($hits -gt 0))
