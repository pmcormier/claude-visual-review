#Requires -Version 7
. "$PSScriptRoot/lib.ps1"
$installer = Join-Path $RepoRoot 'install.ps1'
$global = Join-Path $RepoRoot 'global'

# Runs the installer non-interactively against a temp Claude home, without the tool checks. The opener is built
# only when CVR_TEST_BUILD=1: security tools quarantine new .exe files appearing in %TEMP%.
$build = $env:CVR_TEST_BUILD -eq '1'
function Invoke-Install([string]$ClaudeHome, [string[]]$Extra = @()) {
  $skip = @(if (-not $build) { '-SkipBuild' })
  $out = pwsh -NonInteractive -NoProfile -File $installer -ClaudeHome $ClaudeHome -SkipToolCheck @skip @Extra 2>&1
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
  if ($build) { Assert-True (Test-Path "$h/visual-review/bin/open-in-vscode.exe") 'opener built' }
  else { Assert-True (-not (Test-Path "$h/visual-review/bin/open-in-vscode.exe")) 'opener not built with -SkipBuild' }
  Assert-True (-not (Test-Path "$h/rules/methods.md")) 'methods.md not installed'
  Assert-True (-not (Test-Path "$h/rules/fable.md")) 'fable.md not installed'
  Assert-True (-not (Test-Path "$h/bmad")) 'no BMAD files'
  $m = Read-Manifest $h
  Assert-True ($m.ContainsKey('rules/visual-review.md')) 'manifest lists visual-review.md'
  if ($build) { Assert-True ($m.ContainsKey('visual-review/bin/open-in-vscode.exe')) 'manifest lists the opener' }
}

Test 'FreshInstallAllCoversEveryGlobalFile' {
  $h = New-TempDir
  $r = Invoke-Install $h @('-Components', 'Review,Methods,Bmad,Fable,Rigor,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  foreach ($f in Get-ChildItem $global -Recurse -File) {
    $rel = [IO.Path]::GetRelativePath($global, $f.FullName) -replace '\\', '/' -replace '\.cs$', '.exe'
    if (-not $build -and $rel -like '*.exe') { continue }
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
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
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
  Assert-Equal 'my own methods' (Get-Content -Raw (Get-Item "$h/rules/methods.md.bak-*").FullName) 'backup kept'
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
  Assert-Equal 'old local methods' (Get-Content -Raw (Get-Item "$h/rules/methods.md.bak-*").FullName) 'bootstrap kept a .bak of a differing file'
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
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'uv not found') "reported: $($r.Out)"
  Assert-True ($r.Out -match 'Start a new Claude Code session') 'reached Done'
}

Test 'CleanRunExits0WithSummary' {
  $r = Invoke-Install (New-TempDir) @('-Components', 'Review')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match '== Summary') "summary: $($r.Out)"
  Assert-True ($r.Out -match 'Nothing left to do') "nothing left: $($r.Out)"
}

Test 'SummaryListsWhatIsLeft' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'my own methods'
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-True ($r.Out -match "== Summary") "summary: $($r.Out)"
  $summary = ($r.Out -split '== Summary')[-1]
  Assert-True ($summary -match '-Replace rules/methods\.md') "summary has the rerun command: $summary"
}

Test 'SettingsInvalidJsonReported' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ not json'
  $r = Invoke-Install $h @('-Components', 'Review')
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match "settings\.json isn't valid JSON") "reported: $($r.Out)"
  Assert-Equal '{ not json' (Get-Content -Raw "$h/settings.json") 'left as it was'
  Assert-True (Test-Path "$h/rules/visual-review.md") 'rules still installed'
}

Test 'SettingsEmptyOrNullEnvHandled' {
  $h = New-TempDir
  Set-File "$h/settings.json" ''
  $r = Invoke-Install $h @('-Components', 'Review')
  Assert-Equal 0 $r.Code "empty file ($($r.Out))"
  $h2 = New-TempDir
  Set-File "$h2/settings.json" '{ "env": null, "model": "opus" }'
  $r = Invoke-Install $h2 @('-Components', 'Review')
  Assert-Equal 0 $r.Code "env null ($($r.Out))"
  $s = Get-Content -Raw "$h2/settings.json" | ConvertFrom-Json -AsHashtable
  Assert-True ($s.env.PLANNOTATOR_BROWSER -like '*open-in-vscode.exe') 'PLANNOTATOR_BROWSER set'
  Assert-Equal 'opus' $s.model 'model kept'
}

Test 'BackupsDoNotOverwriteEachOther' {
  $h = New-TempDir
  Set-File "$h/rules/methods.md" 'first'
  Invoke-Install $h @('-Components', 'Review,Methods', '-Replace', 'rules/methods.md') | Out-Null
  Start-Sleep -Seconds 1
  Set-File "$h/rules/methods.md" 'second'
  Invoke-Install $h @('-Components', 'Review,Methods', '-Replace', 'rules/methods.md') | Out-Null
  Assert-Equal 2 @(Get-Item "$h/rules/methods.md.bak-*").Count 'two backups'
}

Test 'MissingToolsAreMissLines' {
  $h = New-TempDir
  $keep = foreach ($c in 'pwsh', 'git') { Split-Path (Get-Command $c).Source }
  $saved = $env:PATH, $env:WINDIR
  try {
    $env:PATH = ($keep | Select-Object -Unique) -join ';'
    $env:WINDIR = New-TempDir   # no C# compiler there
    $out = pwsh -NonInteractive -NoProfile -File $installer -ClaudeHome $h -Components Review 2>&1
    $code = $LASTEXITCODE; $out = $out -join "`n"
  } finally { $env:PATH, $env:WINDIR = $saved }
  Assert-Equal 3 $code "exit code ($out)"
  Assert-True ($out -match 'MISS.*C# compiler') "compiler reported: $out"
  Assert-True ($out -match 'MISS.*Claude Code') "claude reported: $out"
  Assert-True ($out -match 'MISS.*VS Code') "code reported: $out"
  Assert-True ($out -match '== Summary') 'reached the summary'
}

Test 'ComponentListInOrder' {
  $r = Invoke-Install (New-TempDir)
  $i = 'Methods', 'Bmad', 'Fable', 'Rigor', 'Dashboard' | ForEach-Object { $r.Out.IndexOf("    $_`:") }
  Assert-True ($i[0] -ge 0 -and $i[0] -lt $i[1] -and $i[1] -lt $i[2] -and $i[2] -lt $i[3] -and $i[3] -lt $i[4]) "order: $($r.Out)"
}

Test 'RigorHookAddedOnceAndOthersKept' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "other-hook" } ] } ], "Stop": [ { "hooks": [ { "type": "command", "command": "stop-hook" } ] } ] } }'
  $r = Invoke-Install $h @('-Components', 'Review,Rigor')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'added the Rigor hook') "announced: $($r.Out)"
  $r2 = Invoke-Install $h @('-Components', 'Review,Rigor')
  Assert-True ($r2.Out -match 'Rigor hook \(UserPromptSubmit\) already set') "rerun quiet: $($r2.Out)"
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  $cmds = @($s.hooks.UserPromptSubmit | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
  Assert-Equal 1 @($cmds | Where-Object { $_ -match 'pushback-check\.mjs' }).Count 'one Rigor hook'
  Assert-True ($cmds -contains 'other-hook') 'other UserPromptSubmit hook kept'
  Assert-Equal 'stop-hook' $s.hooks.Stop[0].hooks[0].command 'other events kept'
}

Test 'RemoveRigorRemovesHookAndRetiresFiles' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "other-hook" } ] } ] } }'
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review', '-Remove', 'Rigor')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'removed the Rigor hook') "announced: $($r.Out)"
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  $cmds = @($s.hooks.UserPromptSubmit | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
  Assert-Equal 0 @($cmds | Where-Object { $_ -match 'pushback-check\.mjs' }).Count 'Rigor hook gone'
  Assert-True ($cmds -contains 'other-hook') 'other hook kept'
  foreach ($f in 'rules/rigor.md', 'rigor/pushback.md', 'hooks/pushback-check.mjs') {
    Assert-True (-not (Test-Path "$h/$f")) "$f retired"
    Assert-True (Test-Path "$h/$f.retired") "$f kept as .retired"
  }
  $m = Get-Content -Raw "$h/visual-review/installed.json" | ConvertFrom-Json -AsHashtable
  Assert-True (-not $m.ContainsKey('rules/rigor.md')) 'manifest forgets rigor.md'
  $r2 = Invoke-Install $h @('-Components', 'Review')
  Assert-True ($r2.Out -notmatch 'Rigor') "rerun quiet: $($r2.Out)"
}

Test 'RemoveRigorKeepsEditedRule' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  Add-Content "$h/rules/rigor.md" 'my line'
  $r = Invoke-Install $h @('-Components', 'Review', '-Remove', 'Rigor')
  Assert-True (Test-Path "$h/rules/rigor.md") 'edited rule left in place'
  Assert-True ($r.Out -match 'rules/rigor\.md') "named: $($r.Out)"
  Assert-Equal 3 $r.Code "needs attention ($($r.Out))"
}

Test 'RigorKeptWhenLeftOut' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match '-Remove Rigor') "says how to remove it: $($r.Out)"
  foreach ($f in 'rules/rigor.md', 'rigor/pushback.md', 'hooks/pushback-check.mjs') { Assert-True (Test-Path "$h/$f") "$f kept" }
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  $cmds = @($s.hooks.UserPromptSubmit | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
  Assert-Equal 1 @($cmds | Where-Object { $_ -match 'pushback-check\.mjs' }).Count 'Rigor hook kept'
}

Test 'RemoveTakesOnlyRigor' {
  $r = Invoke-Install (New-TempDir) @('-Components', 'Review,Methods', '-Remove', 'Methods')
  Assert-True ($r.Code -ne 0) "refused ($($r.Out))"
  Assert-True ($r.Out -match '-Remove takes only Rigor') "says why: $($r.Out)"
}

Test 'RemoveRigorAloneOnAnUpdate' {
  # The README's form: no -Components, so last time's (Rigor included) are reused; that is not a conflict.
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  $r = Invoke-Install $h @('-Remove', 'Rigor')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True (-not (Test-Path "$h/rules/rigor.md")) 'rigor.md retired'
}

Test 'RigorInComponentsAndRemoveConflict' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review,Rigor', '-Remove', 'Rigor')
  Assert-True ($r.Code -ne 0) "refused ($($r.Out))"
  Assert-True ($r.Out -match 'both -Components and -Remove') "says why: $($r.Out)"
  Assert-True (Test-Path "$h/rules/rigor.md") 'nothing removed'
}

Test 'NoRigorNoHook' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Methods') | Out-Null
  $s = Get-Content -Raw "$h/settings.json" | ConvertFrom-Json -AsHashtable
  Assert-True (-not $s.ContainsKey('hooks')) 'no hooks key without Rigor'
}

Test 'RigorHookSendsTheCheck' {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '  (node not on PATH; skipped)'; return }
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Rigor') | Out-Null
  $out = '{}' | node "$h/hooks/pushback-check.mjs"
  $j = $out | ConvertFrom-Json -AsHashtable
  Assert-Equal 'UserPromptSubmit' $j.hookSpecificOutput.hookEventName 'event name'
  Assert-Equal (Get-Content -Raw "$global/rigor/pushback.md").Trim() $j.hookSpecificOutput.additionalContext 'sends pushback.md'
}

# Dashboard: two hooks found again by script name, and the status-line wrap (the tap found by its file name).
function Read-Settings([string]$ClaudeHome) { Get-Content -Raw "$ClaudeHome/settings.json" | ConvertFrom-Json -AsHashtable }
function Get-HookCommands($Settings, [string]$Event) { @($Settings.hooks[$Event] | ForEach-Object { $_.hooks } | ForEach-Object { $_.command }) }
function Read-Original([string]$ClaudeHome) { Get-Content -Raw "$ClaudeHome/dashboard/statusline-original.json" | ConvertFrom-Json -AsHashtable }
function Set-StatusLine([string]$ClaudeHome, [string]$Command) {
  $s = Read-Settings $ClaudeHome
  $s.statusLine = @{ type = 'command'; command = $Command }
  $s | ConvertTo-Json -Depth 20 | Set-Content "$ClaudeHome/settings.json"
}

Test 'DashboardInstallAddsHooksOnce' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-start" } ] } ], "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "other-post" } ] } ] } }'
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'added the Dashboard hook \(SessionStart\)') "announced: $($r.Out)"
  $r2 = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r2.Code "rerun exit code ($($r2.Out))"
  Assert-True ($r2.Out -notmatch 'written|updated|added') "rerun quiet: $($r2.Out)"
  $s = Read-Settings $h
  $start = Get-HookCommands $s 'SessionStart'
  $post = Get-HookCommands $s 'PostToolUse'
  Assert-Equal 1 @($start | Where-Object { $_ -match 'launcher\.mjs' }).Count 'one launcher hook'
  Assert-Equal 1 @($post | Where-Object { $_ -match 'plan-hook\.mjs' }).Count 'one plan hook'
  Assert-Equal 1 @(Get-HookCommands $s 'Stop' | Where-Object { $_ -match 'tidy-hook\.mjs' }).Count 'one tidy hook'
  Assert-True ($start -contains 'other-start') 'other SessionStart hook kept'
  Assert-True ($post -contains 'other-post') 'other PostToolUse hook kept'
  $launcher = @($start | Where-Object { $_ -match 'launcher\.mjs' })[0]
  Assert-Equal "node `"$("$h/dashboard/launcher.mjs" -replace '\\', '/')`"" $launcher 'launcher command'
  $g = @($s.hooks.PostToolUse | Where-Object { @($_.hooks | Where-Object { $_.command -match 'plan-hook\.mjs' }).Count })[0]
  Assert-Equal 'Read|Edit|Write' $g.matcher 'plan hook matcher'
  Assert-True (Test-Path "$h/commands/dashboard.md") 'command installed'
  Assert-True (Test-Path "$h/rules/dashboard.md") 'rule installed'
  Assert-True (Test-Path "$h/dashboard/lib/config.mjs") 'lib installed'
}

Test 'DashboardWrapsNoStatusLine' {
  $h = New-TempDir
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-Equal 'null' (Get-Content -Raw "$h/dashboard/statusline-original.json").Trim() 'original saved as null'
  $sl = (Read-Settings $h).statusLine
  Assert-Equal 'command' $sl.type 'type'
  Assert-Equal "node `"$("$h/dashboard/statusline-tap.mjs" -replace '\\', '/')`"" $sl.command 'tap command'
  Assert-True (-not $sl.ContainsKey('padding')) 'no padding invented'
}

Test 'DashboardWrapsObjectStatusLineKeepsPadding' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "statusLine": { "type": "command", "command": "my-line --x", "padding": 2, "refreshInterval": 5 } }'
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  $o = Read-Original $h
  Assert-Equal 'my-line --x' $o.command 'original command saved'
  Assert-Equal 2 $o.padding 'original padding saved'
  Assert-Equal 5 $o.refreshInterval 'original refreshInterval saved'
  $sl = (Read-Settings $h).statusLine
  Assert-True ($sl.command -match 'statusline-tap\.mjs') 'tap set'
  Assert-Equal 2 $sl.padding 'padding kept'
  Assert-Equal 5 $sl.refreshInterval 'refreshInterval kept'
}

Test 'DashboardRerunNeverSavesTapAsOriginal' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "statusLine": { "type": "command", "command": "my-line" } }'
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-Equal 'my-line' (Read-Original $h).command 'original still the user''s'
  # Even with -Replace statusLine, the tap is never saved as the original (it would run itself).
  Invoke-Install $h @('-Components', 'Review,Dashboard', '-Replace', 'statusLine') | Out-Null
  Assert-Equal 'my-line' (Read-Original $h).command 'original still the user''s after -Replace'
}

Test 'DashboardRemoveRestoresOriginalStatusLine' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "statusLine": { "type": "command", "command": "my-line", "padding": 1 }, "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "other-start" } ] } ] } }'
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review', '-Remove', 'Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  $s = Read-Settings $h
  Assert-Equal 'my-line' $s.statusLine.command 'original command restored'
  Assert-Equal 1 $s.statusLine.padding 'original padding restored'
  Assert-Equal 0 @(Get-HookCommands $s 'SessionStart' | Where-Object { $_ -match 'launcher\.mjs' }).Count 'launcher hook gone'
  Assert-True (-not $s.hooks.ContainsKey('PostToolUse')) 'empty PostToolUse removed'
  Assert-True (-not $s.hooks.ContainsKey('Stop')) 'tidy hook gone, empty Stop removed'
  Assert-True ((Get-HookCommands $s 'SessionStart') -contains 'other-start') 'other hook kept'
  foreach ($f in 'dashboard/launcher.mjs', 'dashboard/lib/config.mjs', 'commands/dashboard.md', 'rules/dashboard.md') {
    Assert-True (-not (Test-Path "$h/$f")) "$f retired"
    Assert-True (Test-Path "$h/$f.retired") "$f kept as .retired"
  }
  Assert-True (-not (Read-Manifest $h).ContainsKey('dashboard/launcher.mjs')) 'manifest forgets the launcher'
  # No original at all: removal takes the tap out and leaves no statusLine.
  $h2 = New-TempDir
  Invoke-Install $h2 @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h2 @('-Remove', 'Dashboard')
  Assert-Equal 0 $r.Code "exit code, no original ($($r.Out))"
  Assert-True (-not (Read-Settings $h2).ContainsKey('statusLine')) 'no statusLine left'
  $r3 = Invoke-Install $h2 @('-Components', 'Review')
  Assert-True ($r3.Out -notmatch 'Dashboard') "rerun quiet: $($r3.Out)"
}

Test 'DashboardRemoveLeavesChangedStatusLine' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  Set-StatusLine $h 'another-tool'
  $r = Invoke-Install $h @('-Components', 'Review', '-Remove', 'Dashboard')
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'MISS.*statusLine') "named: $($r.Out)"
  Assert-Equal 'another-tool' (Read-Settings $h).statusLine.command 'left alone'
}

Test 'DashboardRerunReportsRewrittenStatusLine' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  Set-StatusLine $h 'another-tool'
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'MISS.*usage') "says usage is unavailable: $($r.Out)"
  Assert-True ($r.Out -match '-Replace statusLine') "says how to re-wrap: $($r.Out)"
  Assert-Equal 'another-tool' (Read-Settings $h).statusLine.command 'not re-wrapped silently'
  $r2 = Invoke-Install $h @('-Components', 'Review,Dashboard', '-Replace', 'statusLine')
  Assert-Equal 0 $r2.Code "re-wrap exit code ($($r2.Out))"
  Assert-True ((Read-Settings $h).statusLine.command -match 'statusline-tap\.mjs') 're-wrapped'
  Assert-Equal 'another-tool' (Read-Original $h).command 'the new value is the original now'
}

Test 'DashboardKeptWhenLeftOut' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review,Methods')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match '-Remove Dashboard') "says how to remove it: $($r.Out)"
  Assert-True (Test-Path "$h/dashboard/launcher.mjs") 'files kept'
  $s = Read-Settings $h
  Assert-True ($s.statusLine.command -match 'statusline-tap\.mjs') 'tap kept'
  Assert-Equal 1 @(Get-HookCommands $s 'SessionStart' | Where-Object { $_ -match 'launcher\.mjs' }).Count 'hook kept'
}

Test 'DashboardInBothComponentsAndRemoveErrors' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard', '-Remove', 'Dashboard')
  Assert-True ($r.Code -ne 0) "refused ($($r.Out))"
  Assert-True ($r.Out -match 'Dashboard is in both -Components and -Remove') "says why: $($r.Out)"
  Assert-True (Test-Path "$h/dashboard/launcher.mjs") 'nothing removed'
}

Test 'DashboardRemoveIsIdempotent' {
  # A status line of the person's own is what a second removal must not mistake for a rewrite.
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "statusLine": { "type": "command", "command": "my-line" } }'
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $r = Invoke-Install $h @('-Remove', 'Dashboard')
  Assert-Equal 0 $r.Code "first remove ($($r.Out))"
  $r2 = Invoke-Install $h @('-Remove', 'Dashboard')
  Assert-Equal 0 $r2.Code "second remove ($($r2.Out))"
  Assert-True ($r2.Out -notmatch 'MISS') "no Miss on the second remove: $($r2.Out)"
  Assert-Equal 'my-line' (Read-Settings $h).statusLine.command 'status line untouched'
  # A home that never had the Dashboard: removal is a no-op.
  $h3 = New-TempDir
  Set-File "$h3/settings.json" '{ "statusLine": { "type": "command", "command": "my-line" } }'
  $r3 = Invoke-Install $h3 @('-Components', 'Review', '-Remove', 'Dashboard')
  Assert-Equal 0 $r3.Code "never installed ($($r3.Out))"
  Assert-True ($r3.Out -notmatch 'MISS') "no Miss when never installed: $($r3.Out)"
}

Test 'DashboardMatcherDriftLeavesOthersGroup' {
  $h = New-TempDir
  $plan = "node \`"$("$h/dashboard/plan-hook.mjs" -replace '\\', '/')\`""
  Set-File "$h/settings.json" "{ `"hooks`": { `"PostToolUse`": [ { `"matcher`": `"Bash`", `"hooks`": [ { `"type`": `"command`", `"command`": `"other-post`" }, { `"type`": `"command`", `"command`": `"$plan`" } ] } ] } }"
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  $s = Read-Settings $h
  $bash = @($s.hooks.PostToolUse | Where-Object { $_.matcher -eq 'Bash' })
  Assert-Equal 1 $bash.Count 'the Bash group is still there'
  Assert-Equal 'other-post' (@($bash[0].hooks | ForEach-Object { $_.command }) -join ',') 'the Bash group keeps only the other hook'
  $ours = @($s.hooks.PostToolUse | Where-Object { $_.matcher -eq 'Read|Edit|Write' })
  Assert-Equal 1 $ours.Count 'our own group'
  Assert-Equal 1 @(Get-HookCommands $s 'PostToolUse' | Where-Object { $_ -match 'plan-hook\.mjs' }).Count 'one plan hook'
}

Test 'DashboardRemoveWithoutSavedOriginalWritesSettings' {
  $h = New-TempDir
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  Remove-Item "$h/dashboard/statusline-original.json"
  $s = Read-Settings $h
  $s.Remove('hooks')   # so the status line is the only change
  $s | ConvertTo-Json -Depth 20 | Set-Content "$h/settings.json"
  $r = Invoke-Install $h @('-Remove', 'Dashboard')
  Assert-Equal 3 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'MISS.*missing or unreadable') "named: $($r.Out)"
  Assert-True (-not (Read-Settings $h).ContainsKey('statusLine')) 'the tap is really gone from settings.json'
}

Test 'DashboardLookalikeHooksSurvive' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \"/opt/my-dashboard/launcher.mjs\"" } ] } ] } }'
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $start = Get-HookCommands (Read-Settings $h) 'SessionStart'
  Assert-True ($start -contains 'node "/opt/my-dashboard/launcher.mjs"') "lookalike kept on install: $start"
  Assert-Equal 2 @($start | Where-Object { $_ -match 'launcher\.mjs' }).Count 'ours added beside it'
  Invoke-Install $h @('-Remove', 'Dashboard') | Out-Null
  $start = Get-HookCommands (Read-Settings $h) 'SessionStart'
  Assert-Equal 'node "/opt/my-dashboard/launcher.mjs"' ($start -join ',') 'lookalike kept on removal, ours gone'
}

Test 'DashboardRemoveAfterStatusLineDeleted' {
  $h = New-TempDir
  Set-File "$h/settings.json" '{ "statusLine": { "type": "command", "command": "my-line" } }'
  Invoke-Install $h @('-Components', 'Review,Dashboard') | Out-Null
  $s = Read-Settings $h
  $s.Remove('statusLine')
  $s | ConvertTo-Json -Depth 20 | Set-Content "$h/settings.json"
  $r = Invoke-Install $h @('-Remove', 'Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  Assert-True ($r.Out -match 'statusLine was already removed') "reported: $($r.Out)"
  Assert-True (-not (Test-Path "$h/dashboard/statusline-original.json")) 'saved original retired'
  Assert-True (Test-Path "$h/dashboard/statusline-original.json.retired") 'kept as .retired'
  Assert-True (-not (Read-Settings $h).ContainsKey('statusLine')) 'nothing restored'
}

Test 'DashboardShortcutMadeAndRemoved' {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '  (node not on PATH; skipped)'; return }
  $h = New-TempDir
  $menu = New-TempDir   # never the real Start menu
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard', '-ShortcutDir', $menu)
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  $lnk = Join-Path $menu 'Claude Dashboard.lnk'
  Assert-True (Test-Path $lnk) "shortcut made: $($r.Out)"
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  Assert-Equal (Get-Command node).Source $sc.TargetPath 'target is node'
  Assert-True ($sc.Arguments -match 'launcher\.mjs" --open$') "arguments: $($sc.Arguments)"
  $r2 = Invoke-Install $h @('-Components', 'Review,Dashboard', '-ShortcutDir', $menu)
  Assert-True ($r2.Out -notmatch 'written') "rerun quiet: $($r2.Out)"
  $r3 = Invoke-Install $h @('-Remove', 'Dashboard', '-ShortcutDir', $menu)
  Assert-Equal 0 $r3.Code "remove exit code ($($r3.Out))"
  Assert-True (-not (Test-Path $lnk)) 'shortcut deleted'
}

Test 'DashboardNoShortcutUnderSkipToolCheck' {
  # Without -ShortcutDir, -SkipToolCheck makes and deletes no shortcut, so tests never reach the real Start menu.
  $r = Invoke-Install (New-TempDir) @('-Components', 'Review,Dashboard')
  Assert-True ($r.Out -notmatch 'Claude Dashboard\.lnk') "no shortcut step: $($r.Out)"
}

Test 'DashboardInstallRecordsInstallDateOnce' {
  $h = New-TempDir
  $r = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r.Code "exit code ($($r.Out))"
  $f = "$h/dashboard/installed.json"
  Assert-True (Test-Path $f) 'install date written'
  $at = (Get-Content -Raw $f | ConvertFrom-Json -AsHashtable).installedAt
  Assert-True ($null -ne ([datetimeoffset]::Parse([string]$at))) "parsable: $at"
  Set-File $f '{ "installedAt": "2020-01-01T00:00:00Z" }'
  $r2 = Invoke-Install $h @('-Components', 'Review,Dashboard')
  Assert-Equal 0 $r2.Code "rerun exit code ($($r2.Out))"
  Assert-True ((Get-Content -Raw $f) -match '2020-01-01T00:00:00Z') 'kept on reinstall'
  $h2 = New-TempDir
  $r3 = Invoke-Install $h2 @('-Components', 'Review')
  Assert-Equal 0 $r3.Code "exit code ($($r3.Out))"
  Assert-True (-not (Test-Path "$h2/dashboard/installed.json")) 'no install date without Dashboard'
}

Complete-Tests
