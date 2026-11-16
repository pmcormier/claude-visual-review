#Requires -Version 7
. "$PSScriptRoot/lib.ps1"
$installer = Join-Path $RepoRoot 'install.ps1'
$global = Join-Path $RepoRoot 'global'

# Runs the installer non-interactively against a temp Claude home, without the tool checks.
function Invoke-Install([string]$ClaudeHome, [string[]]$Extra = @()) {
  $out = pwsh -NonInteractive -NoProfile -File $installer -ClaudeHome $ClaudeHome -SkipToolCheck @Extra 2>&1
  @{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}
function Hash([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash }
function Read-Manifest([string]$ClaudeHome) {
  Get-Content -Raw (Join-Path $ClaudeHome 'visual-review/installed.json') | ConvertFrom-Json -AsHashtable
}
function Set-File([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  Set-Content -Path $Path -Value $Text -NoNewline
}

Test 'FreshInstallReviewOnly' {
  $h = New-TempDir
  $r = Invoke-Install $h @('-Components', 'Review')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-Equal (Hash "$global/rules/visual-review.md") (Hash "$h/rules/visual-review.md") 'visual-review.md installed'
  Assert-True (Test-Path "$h/visual-review/bin/open-in-vscode.exe") 'opener built'
  Assert-True (-not (Test-Path "$h/rules/methods.md")) 'methods.md not installed'
  Assert-True (-not (Test-Path "$h/rules/fable.md")) 'fable.md not installed'
  Assert-True (-not (Test-Path "$h/bmad")) 'no BMAD files'
  $m = Read-Manifest $h
  Assert-True ($m.ContainsKey('rules/visual-review.md')) 'manifest lists visual-review.md'
  Assert-True ($m.ContainsKey('visual-review/bin/open-in-vscode.exe')) 'manifest lists the opener'
}

Test 'FreshInstallAllCoversEveryGlobalFile' {
  $h = New-TempDir
  $r = Invoke-Install $h @('-Components', 'Review,Methods,Bmad,Fable')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  foreach ($f in Get-ChildItem $global -Recurse -File) {
    $rel = [IO.Path]::GetRelativePath($global, $f.FullName) -replace '\\', '/' -replace '\.cs$', '.exe'
    Assert-True (Test-Path "$h/$rel") "$rel installed"
  }
}

Test 'NonInteractiveNoComponentsExits2' {
  $r = Invoke-Install (New-TempDir)
  Assert-Equal 2 $r.Code 'exit code'
  Assert-True ($r.Out -match '-Components') "output names -Components: $($r.Out)"
}

Test 'NonInteractiveConflictSkips' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'my own methods'
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-Equal 'my own methods' (Get-Content -Raw "$h/rules/methods.md") 'methods.md kept'
  Assert-True ($r.Out -match '-Replace rules/methods\.md') "rerun hint: $($r.Out)"
  Assert-True ($r.Out -match 'Methods partly inactive') "partial report: $($r.Out)"
  Assert-True (-not (Read-Manifest $h).ContainsKey('rules/methods.md')) 'skipped file not in manifest'
}

Test 'ReplaceFlagReplaces' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'my own methods'
  $r = Invoke-Install $h @('-Components', 'Review,Methods', '-Replace', 'rules/methods.md')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-Equal (Hash "$global/rules/methods.md") (Hash "$h/rules/methods.md") 'methods.md replaced'
  Assert-Equal 'my own methods' (Get-Content -Raw "$h/rules/methods.md.bak") 'backup kept'
}

Test 'RerunIsQuiet' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Methods') | Out-Null
  $before = Get-Content -Raw "$h/visual-review/installed.json"
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -notmatch 'skip|updated|written') "nothing changed: $($r.Out)"
  Assert-Equal $before (Get-Content -Raw "$h/visual-review/installed.json") 'manifest unchanged'
}

Test 'UpdateOfUntouchedFile' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Methods') | Out-Null
  # Simulate an older install: the file and its manifest entry describe an older version of the source.
  Set-File "$h/rules/methods.md" 'older methods'
  $m = Read-Manifest $h
  $m['rules/methods.md'] = @{ hash = (Hash "$h/rules/methods.md"); source = 'older' }
  $m | ConvertTo-Json | Set-Content "$h/visual-review/installed.json"
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-Equal (Hash "$global/rules/methods.md") (Hash "$h/rules/methods.md") "updated without asking ($($r.Out))"
}

Test 'EditAfterInstallIsAsked' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review') | Out-Null
  Add-Content "$h/rules/visual-review.md" 'my local edit'
  $r = Invoke-Install $h @('-Components', 'Review')
  Assert-True ((Get-Content -Raw "$h/rules/visual-review.md") -match 'my local edit') 'edit kept'
  Assert-True ($r.Out -match '-Replace rules/visual-review\.md') "rerun hint: $($r.Out)"
}

Test 'OwnerBootstrap' {
  $h = New-TempDir
  Set-File "$h/rules/visual-review.md" 'an older install, no manifest'
  Set-File "$h/rules/methods.md" 'an older methods'
  $r = Invoke-Install $h @('-Owner')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -notmatch '-Replace') "no conflicts: $($r.Out)"
  Assert-Equal (Hash "$global/rules/methods.md") (Hash "$h/rules/methods.md") 'methods.md updated'
  Assert-True (Test-Path "$h/rules/fable.md") 'all components installed'
  Assert-True (Test-Path "$h/visual-review/installed.json") 'manifest written'
}

Test 'SettingsMerged' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "model": "opus", "env": { "FOO": "1" } }'
  Invoke-Install $h @('-Components', 'Review') | Out-Null
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  Assert-Equal 'opus' $s.model 'model kept'
  Assert-Equal '1' $s.env.FOO 'env.FOO kept'
  Assert-True ($s.env.PLANNOTATOR_BROWSER -like '*open-in-vscode.exe') 'PLANNOTATOR_BROWSER set'
}

Test 'SettingsCreatedWhenAbsent' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review') | Out-Null
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  Assert-True ($s.env.PLANNOTATOR_BROWSER -like '*open-in-vscode.exe') 'PLANNOTATOR_BROWSER set'
}

Test 'BmadRetiredOnlyWhenOurs' {
  $h = New-TempDir
  Set-File "$h/rules/bmad.md" 'someone else''s bmad rule'
  Invoke-Install $h @('-Components', 'Review') | Out-Null
  Assert-True (Test-Path "$h/rules/bmad.md") 'a bmad.md this repo never installed stays'
  $h2 = New-TempDir
  Set-File "$h2/rules/bmad.md" 'the old rule from this repo'
  Invoke-Install $h2 @('-Owner') | Out-Null
  Assert-True (-not (Test-Path "$h2/rules/bmad.md")) 'owner: bmad.md retired'
  Assert-True (Test-Path "$h2/rules/bmad.md.retired") 'kept as .retired'
}

Test 'OwnerBootstrapKeepsBak' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'old local methods'
  Invoke-Install $h @('-Owner') | Out-Null
  Assert-Equal 'old local methods' (Get-Content -Raw "$h/rules/methods.md.bak") 'bootstrap kept a .bak of a differing file'
}

Test 'BootstrapOnlyWithoutManifest' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review') | Out-Null
  Set-File "$h/rules/methods.md" 'my own methods'
  $r = Invoke-Install $h @('-Owner')
  Assert-Equal 'my own methods' (Get-Content -Raw "$h/rules/methods.md") "a file new to the manifest is a conflict once a manifest exists ($($r.Out))"
}

Test 'NoComponentsUsesManifest' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Methods') | Out-Null
  $r = Invoke-Install $h
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'Review, Methods') "components from the manifest: $($r.Out)"
  Assert-True (-not (Test-Path "$h/bmad")) 'no new components'
}

Test 'ReplaceCommaList' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'mine'
  Set-File "$h/rules/visual-review.md" 'mine too'
  Invoke-Install $h @('-Components', 'Review,Methods', '-Replace', 'rules/methods.md,rules\visual-review.md') | Out-Null
  Assert-Equal (Hash "$global/rules/methods.md") (Hash "$h/rules/methods.md") 'methods.md replaced'
  Assert-Equal (Hash "$global/rules/visual-review.md") (Hash "$h/rules/visual-review.md") 'visual-review.md replaced'
}

Test 'BmadProjectWithoutUvDoesNotCrash' {
  $h = New-TempDir
  $p = New-TempDir
  New-Item -ItemType Directory "$p/_bmad/custom", "$p/_bmad/scripts" | Out-Null
  Set-Content "$p/_bmad/scripts/resolve_customization.py" '# stub'
  $keep = foreach ($c in 'pwsh', 'git', 'python') { Split-Path (Get-Command $c).Source }
  $saved = $env:PATH
  try {
    $env:PATH = ($keep | Select-Object -Unique) -join ';'
    if (Get-Command uv -ErrorAction SilentlyContinue) { throw 'uv still on PATH; test cannot run' }
    $r = Invoke-Install $h @('-Components', 'Review,Bmad', '-BmadProject', $p)
  } finally { $env:PATH = $saved }
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'uv not found') "reported: $($r.Out)"
  Assert-True ($r.Out -match 'Start a new Claude Code session') 'reached Done'
}

exit $script:Failures
