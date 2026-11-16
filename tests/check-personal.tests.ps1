#Requires -Version 7
. "$PSScriptRoot/lib.ps1"
$check = Join-Path $RepoRoot 'tools/check-personal.ps1'
# Built at runtime, so this tracked file doesn't trip the check itself.
$drive = 'see ' + 'C' + ':\' + 'x'
$email = 'someone' + '@' + 'example.com'
$artifact = 'https://claude.ai/' + 'artifact/abc'

function Invoke-Check([string]$Root, [string[]]$Extra = @()) {
  $none = Join-Path (New-TempDir) 'no-terms.txt'
  $out = pwsh -NoProfile -File $check -Root $Root -TermsFile $none @Extra 2>&1
  @{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

Test 'CleanRepoPasses' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "nothing personal`n" })
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
}

Test 'DrivePathFails' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "$drive`n" })
  Assert-Equal 1 $r.Code 'exit code'
  Assert-True ($r.Out -match 'a\.md:1: drive-path') "output: $($r.Out)"
}

Test 'EmailFails' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "mail $email`n" })
  Assert-Equal 1 $r.Code 'exit code'
  Assert-True ($r.Out -match 'a\.md:1: email') "output: $($r.Out)"
}

Test 'ArtifactLinkFails' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "x`n$artifact`n" })
  Assert-Equal 1 $r.Code 'exit code'
  Assert-True ($r.Out -match 'a\.md:2: artifact-link') "output: $($r.Out)"
}

Test 'TermFails' {
  $repo = New-TempRepo @{ 'x.md' = "line one`nSecretProject here`n" }
  $terms = Join-Path (New-TempDir) 'terms.txt'
  Set-Content $terms "# comment`n`nsecretproject`n"
  $out = (pwsh -NoProfile -File $check -Root $repo -TermsFile $terms 2>&1) -join "`n"
  Assert-Equal 1 $LASTEXITCODE 'exit code'
  Assert-True ($out -match 'x\.md:2: term:1') "output: $out"
  Assert-True ($out -notmatch '(?i)secretproject') 'the term itself is not echoed'
}

Test 'StagedChecksIndexNotWorktree' {
  $repo = New-TempRepo @{ 'a.md' = "clean`n" }
  Set-Content (Join-Path $repo 'a.md') "clean v2`n"; git -C $repo add a.md
  Set-Content (Join-Path $repo 'a.md') "$drive`n"
  $r = Invoke-Check $repo @('-Staged')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
}

Test 'StagedFindsStagedHit' {
  $repo = New-TempRepo @{ 'a.md' = "clean`n" }
  Set-Content (Join-Path $repo 'a.md') "$drive`n"; git -C $repo add a.md
  $r = Invoke-Check $repo @('-Staged')
  Assert-Equal 1 $r.Code 'exit code'
}

Test 'GithubUrlPasses' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "https://github.com/someone/repo`n" })
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
}

Test 'BinarySkipped' {
  $repo = New-TempRepo @{ 'a.md' = "ok`n" }
  [IO.File]::WriteAllBytes((Join-Path $repo 'b.bin'), [byte[]](0, 1, 2) + [Text.Encoding]::ASCII.GetBytes($drive))
  git -C $repo add -A; git -C $repo commit -qm bin | Out-Null
  $r = Invoke-Check $repo
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
}

Test 'ForwardSlashDrivePathFails' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = ('see ' + 'D' + ':/' + "x`n") })
  Assert-Equal 1 $r.Code "exit code ($($r.Out))"
}

Test 'GitBashPathFails' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = ('cd /' + 'c/Users/someone' + "`n") })
  Assert-Equal 1 $r.Code "exit code ($($r.Out))"
}

Test 'MissingTermListWarns' {
  $r = Invoke-Check (New-TempRepo @{ 'a.md' = "ok`n" })
  Assert-True ($r.Out -match 'no term list') "warned: $($r.Out)"
}

Test 'FileNameChecked' {
  $repo = New-TempRepo @{ 'a.md' = "ok`n" }
  $terms = Join-Path (New-TempDir) 'terms.txt'
  Set-Content $terms 'secretproject'
  Set-Content (Join-Path $repo 'secretproject-notes.md') "ok`n"; git -C $repo add -A; git -C $repo commit -qm n | Out-Null
  $out = (pwsh -NoProfile -File $check -Root $repo -TermsFile $terms 2>&1) -join "`n"
  Assert-Equal 1 $LASTEXITCODE "exit code ($out)"
}

exit $script:Failures
