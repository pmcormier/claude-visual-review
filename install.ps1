#Requires -Version 7
<#
.SYNOPSIS
  Installs the visual-first review setup for Claude Code on this machine (Windows).

.DESCRIPTION
  Copies the chosen components from global/ into ~/.claude (building the VS Code opener), points
  PLANNOTATOR_BROWSER at it in ~/.claude/settings.json (and, with Rigor, adds its UserPromptSubmit hook there;
  with Dashboard, its SessionStart and PostToolUse hooks, the status-line wrap and a Start menu shortcut),
  checks the tools the rules rely on, and (optionally)
  adds the BMAD overrides to the projects you name.

  It never replaces a file you changed: a file in ~/.claude that differs from both this repo's copy and what
  the installer last wrote there is shown and asked about, or, when nobody can answer (an agent running it),
  kept and reported with the command that replaces it. What it wrote is recorded in
  ~/.claude/visual-review/installed.json. Safe to re-run; settings are merged, BMAD overrides never overwritten.

.PARAMETER Components
  Which parts to install: Review (always), Methods (how the planning method is picked, BMAD and superpowers),
  Bmad (the BMAD review layer), Fable (the Fable final review for BMAD planning docs; needs Fable access),
  Rigor (verification rules, and a hook that sends a pushback check with every message; needs Node.js),
  Dashboard (a live local page of all Claude Code work on this computer; needs Node.js).
  Without it, an interactive run asks; a non-interactive run stops and lists them.

.PARAMETER Owner
  For the maintainer's machines: every component, a manifest bootstrapped from the files already in place,
  and the personal-data pre-commit hook in this repo.

.PARAMETER OnConflict
  Ask (default), Skip or Replace, for files you changed.

.PARAMETER Replace
  Paths (as the installer prints them, e.g. rules/methods.md) to replace even though you changed them.
  The old file is kept as .bak.

.PARAMETER BmadProject
  Project roots that have a _bmad/ folder. Each gets personal (gitignored) overrides.

.PARAMETER InstallTools
  Also install the missing tools (Plannotator binary, Claude Code plugins, VS Code extension).
  Without it, missing tools are only reported.

.PARAMETER ClaudeHome
  Where to install. Default: ~/.claude. For tests.

.PARAMETER SkipToolCheck
  Skip the tool checks and the hook. For tests.

.PARAMETER Remove
  Rigor or Dashboard, to turn it off: its hooks are taken out of settings.json and its files retired as
  *.retired; for Dashboard, the status line it wrapped is restored and its Start menu shortcut deleted. Leaving
  either out of -Components never removes it once installed, so a partial -Components run can't switch off the
  pushback check or unwrap the status line by accident.

.PARAMETER ShortcutDir
  Where the Dashboard's Start menu shortcut goes. Default: the Start menu's Programs folder, or, with
  -SkipToolCheck, no shortcut at all (none made, none deleted). For tests.

.PARAMETER SkipBuild
  Don't compile the opener. For tests: security tools quarantine new .exe files appearing in %TEMP%.

.EXAMPLE
  ./install.ps1 -InstallTools -Components Review,Methods
  ./install.ps1 -Components Review,Methods,Bmad -BmadProject <project>, <project>
  ./install.ps1 -Components Review,Methods -Replace rules/methods.md
#>
param(
  [string[]]$Components = @(),
  [switch]$Owner,
  [ValidateSet('Ask', 'Skip', 'Replace')][string]$OnConflict = 'Ask',
  [string[]]$Replace = @(),
  [string[]]$BmadProject = @(),
  [switch]$InstallTools,
  [string]$ClaudeHome = (Join-Path $HOME '.claude'),
  [switch]$SkipToolCheck,
  [string[]]$Remove = @(),
  [switch]$SkipBuild,
  [string]$ShortcutDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$claude = $ClaudeHome
$home_vr = Join-Path $claude 'visual-review'
$manifestPath = Join-Path $home_vr 'installed.json'
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and
  -not ([Environment]::GetCommandLineArgs() -contains '-NonInteractive')

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ok    $msg" -ForegroundColor Green }
function Done($msg) { Write-Host "  $msg" -ForegroundColor Green }
# Everything left to do is collected for the Summary at the end; an agent running the installer relays it.
$script:pending = [Collections.Generic.List[string]]::new()
function Miss($msg) { Write-Host "  MISS  $msg" -ForegroundColor Yellow; $script:pending.Add($msg) }
function Skip($msg) { Write-Host "  skip  $msg" -ForegroundColor Yellow; $script:pending.Add($msg) }
# A backup never overwrites an earlier one.
function Backup([string]$Path) {
  $bak = "$Path.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $Path $bak -Force
  Split-Path $bak -Leaf
}
function Hash([string]$Path) { (Get-FileHash $Path -Algorithm SHA256).Hash }

# Every file under global/ belongs to exactly one component (paths relative to global/).
$componentFiles = [ordered]@{
  Review  = @('rules/visual-review.md', 'visual-review/bin/open-in-vscode.cs')
  Methods = @('rules/methods.md')
  Bmad    = @('bmad/interactive-review.md', 'bmad/write_overrides.py')
  Fable   = @('rules/fable.md', 'bmad/fable-final-review.md')
  Rigor   = @('rules/rigor.md', 'rigor/pushback.md', 'hooks/pushback-check.mjs')
  # Every file under global/dashboard/, listed at run time (server, launcher, hooks, lib/, page/, fonts).
  Dashboard = @(@(Get-ChildItem (Join-Path $repo 'global/dashboard') -Recurse -File | Sort-Object FullName |
        ForEach-Object { [IO.Path]::GetRelativePath((Join-Path $repo 'global'), $_.FullName) -replace '\\', '/' }) +
    'commands/dashboard.md' + 'rules/dashboard.md')
}
$about = [ordered]@{
  Methods = 'how the planning method is picked per task, work tracking, BMAD and superpowers'
  Bmad    = 'the review layer for BMAD workflows'
  Fable   = 'the Fable final review of BMAD planning docs (needs access to the Fable model)'
  Rigor   = 'verification rules, and a check sent with every message so Claude holds a correct answer under pushback (needs Node.js)'
  Dashboard = 'a live page of all Claude Code work on this computer: sessions, stalls, plans and usage (needs Node.js)'
}

Step 'Components'
# Lists may arrive as one comma-separated string (pwsh -File, or an agent's shell).
function Split-List([string[]]$List) { @($List | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Components = Split-List $Components
$askedFor = $Components   # as passed, before an update reuses last time's
$Replace = @(Split-List $Replace | ForEach-Object { $_ -replace '\\', '/' })
$BmadProject = Split-List $BmadProject
$hadManifest = Test-Path $manifestPath
$manifest = if ($hadManifest) { Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable } else { @{} }
if ($Owner) { $Components = @($componentFiles.Keys) }
elseif (-not $Components.Count -and $hadManifest) {
  # An update: the components installed last time.
  $Components = @($componentFiles.Keys | Where-Object {
      $c = $_; @($componentFiles[$c] | Where-Object { $manifest.ContainsKey(($_ -replace '\.cs$', '.exe')) }).Count })
  Write-Host '  (the components installed last time; choose others with -Components)'
}
elseif (-not $Components.Count) {
  if (-not $interactive) {
    Write-Host '  Choose components with -Components (Review is always installed):'
    foreach ($c in $about.Keys) { Write-Host "    $c`: $($about[$c])" }
    Write-Host '  Example: ./install.ps1 -Components Review,Methods'
    exit 2
  }
  foreach ($c in $about.Keys) {
    if ((Read-Host "  Install $c ($($about[$c]))? [y/N]") -match '^y') { $Components += $c }
  }
}
foreach ($c in $Components) { if (-not $componentFiles.Contains($c)) { throw "Unknown component '$c'; choose from $($componentFiles.Keys -join ', ')" } }
$Components = @('Review') + @($Components | Where-Object { $_ -ne 'Review' }) | Select-Object -Unique
# Rigor acts on every message and Dashboard wraps the status line, so each is removed only on request (decision
# 29): a partial -Components list copied from an example must not quietly turn either off.
$removable = @('Rigor', 'Dashboard')
$Remove = Split-List $Remove
foreach ($c in $Remove) { if ($removable -notcontains $c) { throw "-Remove takes only Rigor or Dashboard; leaving another component out of -Components leaves its files in place" } }
$installedBefore = @{}
foreach ($c in $removable) {
  if ($Remove -contains $c -and $askedFor -contains $c -and -not $Owner) {
    throw "$c is in both -Components and -Remove; drop it from one of them and run again"
  }
  $installedBefore[$c] = @($componentFiles[$c] | Where-Object { $manifest.ContainsKey($_) }).Count -gt 0
  if ($Remove -contains $c) { $Components = @($Components | Where-Object { $_ -ne $c }) }
  elseif ($installedBefore[$c] -and $Components -notcontains $c) {
    $Components += $c
    Write-Host "  ($c kept: it is installed here, and leaving it out of -Components does not remove it; to turn it off, add -Remove $c)"
  }
}
Ok ($Components -join ', ')

Step 'Files'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$skipped = @{}
$rerun = if ($Owner) { './install.ps1 -Owner' } else { "./install.ps1 -Components $($Components -join ',')" }
foreach ($c in $Components) {
  foreach ($srcRel in $componentFiles[$c]) {
    if ($SkipBuild -and $srcRel -like '*.cs') { continue }
    $src = Join-Path $repo "global/$srcRel"
    $rel = $srcRel -replace '\.cs$', '.exe'
    $dest = Join-Path $claude $rel
    $srcHash = Hash $src
    $entry = $manifest[$rel]
    $destHash = if (Test-Path $dest) { Hash $dest }
    # Bootstrap, on the maintainer's first run only: files in place count as installed by this repo. A file
    # that differs is kept as .bak before it's updated.
    $bootstrap = $Owner -and -not $hadManifest -and $destHash -and -not $entry
    if ($bootstrap) {
      $entry = @{ hash = $destHash; source = '' }
      if ($srcRel -notlike '*.cs' -and $destHash -ne $srcHash) { Write-Host "  (previous $rel kept as $(Backup $dest))" }
    }
    $ours = $entry -and $destHash -eq $entry.hash
    $current = if ($srcRel -like '*.cs') { $ours -and $entry.source -eq $srcHash } else { $destHash -eq $srcHash }
    if ($current) { $manifest[$rel] = @{ hash = $destHash; source = $srcHash }; Ok "$rel"; continue }
    if ($destHash -and -not $ours) {
      $replaceIt = $OnConflict -eq 'Replace' -or $Replace -contains $rel
      if (-not $replaceIt) {
        Write-Host "  $rel differs from this repo's copy and from what this installer last wrote (you or another tool changed it):" -ForegroundColor Yellow
        if ($srcRel -like '*.cs') { Write-Host '    (a program; no diff to show)' }
        else { git --no-pager diff --no-index --no-color -- $dest $src | ForEach-Object { Write-Host "    $_" } }
        if ($OnConflict -eq 'Ask' -and $interactive) { $replaceIt = (Read-Host "  Replace $rel with this repo's copy? [y/N]") -match '^y' }
      }
      if (-not $replaceIt) {
        Skip "$rel kept as yours. To replace it: $rerun -Replace $rel"
        $skipped[$c] += @($rel); continue
      }
      Write-Host "  (previous $rel kept as $(Backup $dest))"
    }
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    if ($srcRel -like '*.cs') {
      if (-not (Test-Path $csc)) { Miss "$rel not built: the C# compiler that ships with Windows (.NET Framework 4) wasn't found at $csc"; continue }
      $out = & $csc /nologo /target:winexe /optimize+ "/out:$dest" $src 2>&1
      if ($LASTEXITCODE) { Miss "$rel did not build: $out"; continue }
    } else { Copy-Item $src $dest -Force }
    $manifest[$rel] = @{ hash = (Hash $dest); source = $srcHash }
    Done "$(if ($destHash) { 'updated' } else { 'written' })  $rel"
  }
}
# Files this repo used to install and has since replaced. A stale copy would keep loading in every session.
foreach ($rel in @('rules/bmad.md')) {   # replaced by rules/methods.md (decision 23)
  $old = Join-Path $claude $rel
  if ((Test-Path $old) -and ($Owner -or $manifest.ContainsKey($rel))) {
    Move-Item $old "$old.retired" -Force; $manifest.Remove($rel); Ok "$rel retired (kept as $rel.retired)"
  }
}
# -Remove turns Rigor or Dashboard off: its files are retired and its hooks removed (below). A file you changed
# stays where it is, and is named once.
foreach ($c in $Remove) {
  foreach ($rel in $componentFiles[$c]) {
    if (-not $manifest.ContainsKey($rel)) { continue }
    $old = Join-Path $claude $rel
    if ((Test-Path $old) -and (Hash $old) -eq $manifest[$rel].hash) {
      Move-Item $old "$old.retired" -Force; Done "$rel retired (-Remove $c; kept as $rel.retired)"
    } elseif (Test-Path $old) {
      Miss "$rel left in place because you changed it, so $c is still partly on: delete it to turn $c off"
    }
    $manifest.Remove($rel)
  }
}
New-Item -ItemType Directory -Force $home_vr | Out-Null
$sorted = [ordered]@{}
foreach ($k in $manifest.Keys | Sort-Object) { $sorted[$k] = [ordered]@{ hash = $manifest[$k].hash; source = $manifest[$k].source } }
$json = $sorted | ConvertTo-Json -Depth 5
if (-not (Test-Path $manifestPath) -or (Get-Content -Raw $manifestPath) -ne $json) { Set-Content $manifestPath $json -NoNewline }
foreach ($c in $skipped.Keys) { Miss "$c partly inactive: $($skipped[$c] -join ', ') kept as yours" }

Step 'Settings (settings.json)'
$settingsPath = Join-Path $claude 'settings.json'
$opener = Join-Path $home_vr 'bin\open-in-vscode.exe'
$settings = @{}
$settingsOk = $true
if (Test-Path $settingsPath) {
  $raw = Get-Content $settingsPath -Raw
  if ($raw -and $raw.Trim()) {
    try { $settings = $raw | ConvertFrom-Json -AsHashtable } catch { $settingsOk = $false }
    if ($settingsOk -and $settings -isnot [Collections.IDictionary]) { $settingsOk = $false }
  }
}
# The hooks each component adds. Each is found again on a rerun by its script's file name (Dashboard's with its
# whole folder name, since launcher.mjs is a common name and my-dashboard/ is not ours), so it is never added
# twice; any other hooks are left as they are.
$dashFind = { param($File) "(^|[\\/`"\s])dashboard[\\/]$([regex]::Escape($File))" }
$hookSpecs = @(
  @{ Component = 'Rigor'; Event = 'UserPromptSubmit'; Script = 'hooks/pushback-check.mjs'; Find = 'pushback-check\.mjs' }
  @{ Component = 'Dashboard'; Event = 'SessionStart'; Script = 'dashboard/launcher.mjs'; Find = (& $dashFind 'launcher.mjs') }
  @{ Component = 'Dashboard'; Event = 'PostToolUse'; Script = 'dashboard/plan-hook.mjs'; Find = (& $dashFind 'plan-hook.mjs'); Matcher = 'Read|Edit|Write' }
)
# Adds or updates one hook; returns what changed, or nothing when it was already set.
function Set-Hook($Spec) {
  $label = "$($Spec.Component) hook ($($Spec.Event))"
  $cmd = "node `"$((Join-Path $claude $Spec.Script) -replace '\\', '/')`""
  if ($settings['hooks'] -isnot [Collections.IDictionary]) { $settings['hooks'] = [ordered]@{} }
  $isOurs = { $_ -is [Collections.IDictionary] -and "$($_['command'])" -match $Spec.Find }
  $groups = @($settings['hooks'][$Spec.Event] | Where-Object { $_ })
  # Ours in a group with another matcher (often shared with another tool's hooks): changing that group's matcher
  # would change when the other hooks run, so ours moves out to a group of its own instead.
  $moved = $false
  if ($Spec.Matcher) {
    foreach ($g in $groups) {
      if ($g['matcher'] -eq $Spec.Matcher -or -not @($g['hooks'] | Where-Object $isOurs).Count) { continue }
      $g['hooks'] = @($g['hooks'] | Where-Object { -not (& $isOurs) })
      $moved = $true
    }
    if ($moved) { $groups = @($groups | Where-Object { @($_['hooks']).Count }); $settings['hooks'][$Spec.Event] = $groups }
  }
  foreach ($g in $groups) {
    $hk = @($g['hooks'] | Where-Object $isOurs)
    if (-not $hk.Count) { continue }
    if ($hk[0]['command'] -eq $cmd) {
      if ($moved) { return "moved the $label out of a group with another matcher" }
      Ok "$label already set"; return
    }
    $hk[0]['command'] = $cmd
    return "updated the $label command"
  }
  $entry = [ordered]@{}
  if ($Spec.Matcher) { $entry['matcher'] = $Spec.Matcher }
  $entry['hooks'] = @([ordered]@{ type = 'command'; command = $cmd })
  $settings['hooks'][$Spec.Event] = @($groups) + @($entry)
  if ($moved) { "moved the $label into its own group (matcher $($Spec.Matcher))" } else { "added the $label" }
}
# Takes one hook out, keeping every other one; returns what changed, or nothing.
function Remove-Hook($Spec) {
  if ($settings['hooks'] -isnot [Collections.IDictionary] -or -not $settings['hooks'][$Spec.Event]) { return }
  $isOurs = { "$($_['command'])" -match $Spec.Find }
  $groups = @($settings['hooks'][$Spec.Event] | Where-Object { $_ })
  if (-not @($groups | ForEach-Object { $_['hooks'] } | Where-Object $isOurs).Count) { return }
  $kept = @(foreach ($g in $groups) {
      $g['hooks'] = @($g['hooks'] | Where-Object { -not (& $isOurs) })
      if ($g['hooks'].Count) { $g }
    })
  if ($kept.Count) { $settings['hooks'][$Spec.Event] = $kept } else { $settings['hooks'].Remove($Spec.Event) }
  if ($Spec.Component -eq 'Rigor') { "removed the Rigor hook (-Remove Rigor)" }
  else { "removed the $($Spec.Component) hook ($($Spec.Event)) (-Remove $($Spec.Component))" }
}

# Dashboard wraps the user-level status line: the whole original object (or null) is saved, and the tap, which
# records plan usage and then runs the original's command, takes its place. padding and refreshInterval are
# kept on the tap, since Claude Code reads them from the setting, not from the command. The tap is found by its
# file name and is never saved as the original (it would run itself).
$tapCmd = "node `"$((Join-Path $claude 'dashboard/statusline-tap.mjs') -replace '\\', '/')`""
$originalPath = Join-Path $claude 'dashboard/statusline-original.json'
$retireOriginal = $false
$tapFind = & $dashFind 'statusline-tap.mjs'
function Test-Tap($Value) { $Value -is [Collections.IDictionary] -and "$($Value['command'])" -match $tapFind }

if (-not $settingsOk) {
  $what = @('PLANNOTATOR_BROWSER')
  if ($Components -contains 'Rigor') { $what += 'the Rigor hook' }
  if ($Components -contains 'Dashboard') { $what += 'the Dashboard hooks and status line' }
  Miss "settings.json isn't valid JSON, so $($what -join ' and ') weren't set: fix or remove $settingsPath, then rerun"
} else {
  $changes = @()
  if ($settings['env'] -isnot [Collections.IDictionary]) { $settings['env'] = @{} }
  if ($settings['env']['PLANNOTATOR_BROWSER'] -ne $opener) {
    $settings['env']['PLANNOTATOR_BROWSER'] = $opener
    $changes += "set PLANNOTATOR_BROWSER = $opener"
  } else { Ok 'PLANNOTATOR_BROWSER already set' }
  foreach ($spec in $hookSpecs) {
    if ($Components -contains $spec.Component) { $changes += @(Set-Hook $spec) }
    elseif ($Remove -contains $spec.Component) { $changes += @(Remove-Hook $spec) }
  }
  $current = $settings['statusLine']
  if ($Components -contains 'Dashboard') {
    if (Test-Tap $current) {
      if ($current['command'] -eq $tapCmd) { Ok 'status line wrapped by the Dashboard tap' }
      else { $current['command'] = $tapCmd; $changes += 'updated the Dashboard status-line tap command' }
    } elseif ($installedBefore['Dashboard'] -and (Test-Path $originalPath) -and $Replace -notcontains 'statusLine') {
      # Something rewrote it after install. Wrapping it again silently would take over a choice someone just made.
      Miss "statusLine is no longer the Dashboard's tap (something rewrote it), so plan usage is unavailable on the dashboard. To wrap it again: $rerun -Replace statusLine"
    } else {
      New-Item -ItemType Directory -Force (Split-Path $originalPath) | Out-Null
      ConvertTo-Json -InputObject $current -Depth 50 | Set-Content $originalPath -Encoding utf8NoBOM
      $tap = [ordered]@{ type = 'command'; command = $tapCmd }
      foreach ($k in 'padding', 'refreshInterval') {
        if ($current -is [Collections.IDictionary] -and $current.Contains($k)) { $tap[$k] = $current[$k] }
      }
      $settings['statusLine'] = $tap
      $changes += if ($null -eq $current) { 'set the status line to the Dashboard tap (there was none)' }
      else { 'wrapped the status line with the Dashboard tap (original saved in dashboard/statusline-original.json)' }
    }
  } elseif ($Remove -contains 'Dashboard') {
    if (Test-Tap $current) {
      $original = $null
      $known = Test-Path $originalPath
      if ($known) { try { $original = Get-Content -Raw $originalPath | ConvertFrom-Json -AsHashtable } catch { $known = $false } }
      if ($null -eq $original) { $settings.Remove('statusLine') } else { $settings['statusLine'] = $original }
      if (-not $known) {
        Miss "statusLine was the Dashboard tap, but the original saved in $originalPath is missing or unreadable, so the tap was removed and no status line restored"
        $changes += 'removed the Dashboard tap from the status line'
      } elseif ($null -eq $original) { $changes += 'removed the Dashboard tap from the status line (there was none before)' }
      else { $changes += 'restored the original status line' }
      $retireOriginal = $known
    } elseif (-not ($installedBefore['Dashboard'] -or (Test-Path $originalPath))) {
      Ok 'status line not wrapped by the Dashboard (nothing to restore)'
    } elseif ($null -ne $current) {
      Miss "statusLine was changed after the Dashboard wrapped it, so it was left as it is (the status line from before the Dashboard is in $originalPath)"
    } elseif (Test-Path $originalPath) {
      # Someone deleted the setting since; restoring the old one would undo that.
      Done "statusLine was already removed, so the one from before the Dashboard was not restored (kept in $originalPath.retired)"
      $retireOriginal = $true
    }
  }
  if ($changes.Count) {
    $note = if (Test-Path $settingsPath) { "; backup: $(Backup $settingsPath)" } else { '' }
    $settings | ConvertTo-Json -Depth 50 | Set-Content $settingsPath -Encoding utf8NoBOM
    Done "$($changes -join '; ') (other settings kept$note)"
  }
  if ($retireOriginal) { Move-Item $originalPath "$originalPath.retired" -Force }
}
$needNode = @('Rigor', 'Dashboard' | Where-Object { $Components -contains $_ })
if ($needNode.Count -and -not $SkipToolCheck -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
  Miss "Node.js (``node``) not on PATH, so the $($needNode -join ' and ') hooks cannot run: install Node.js, then start a new session"
}

# Dashboard's install date, written once and never changed (a reinstall keeps it; -Remove leaves it, like the other
# runtime files). Plans added to a repo before it fold as "Before the dashboard" until they show progress
# (decision 32). It marks nothing done.
$installedPath = Join-Path $claude 'dashboard/installed.json'
if ($Components -contains 'Dashboard' -and -not (Test-Path $installedPath)) {
  New-Item -ItemType Directory -Force (Split-Path $installedPath) | Out-Null
  $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  Set-Content -Path $installedPath -Value (@{ installedAt = $stamp } | ConvertTo-Json -Compress) -NoNewline
  Done "written  dashboard/installed.json (install date $stamp)"
}

# Dashboard's Start menu shortcut runs Node (its absolute path, resolved now) on the launcher with --open. With
# -SkipToolCheck and no -ShortcutDir, none is made or deleted, so tests never reach the real Start menu.
$scDir = if ($ShortcutDir) { $ShortcutDir } elseif (-not $SkipToolCheck) { [Environment]::GetFolderPath('Programs') }
if ($scDir -and ($Components -contains 'Dashboard' -or $Remove -contains 'Dashboard')) {
  Step 'Start menu shortcut'
  $lnk = Join-Path $scDir 'Claude Dashboard.lnk'
  $dashDir = [IO.Path]::GetFullPath((Join-Path $claude 'dashboard'))
  $wsh = New-Object -ComObject WScript.Shell
  if ($Components -contains 'Dashboard') {
    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { Miss 'Claude Dashboard.lnk not made: Node.js (`node`) not on PATH; install Node.js, then rerun' }
    else {
      $scArgs = "`"$(Join-Path $dashDir 'launcher.mjs')`" --open"
      $had = Test-Path $lnk
      $sc = $wsh.CreateShortcut($lnk)
      if ($had -and $sc.TargetPath -eq $node -and $sc.Arguments -eq $scArgs) { Ok 'Claude Dashboard.lnk' }
      else {
        New-Item -ItemType Directory -Force $scDir | Out-Null
        $sc.TargetPath = $node
        $sc.Arguments = $scArgs
        $sc.WorkingDirectory = $dashDir
        $sc.Description = 'Open the live dashboard of Claude Code work on this computer'
        $sc.WindowStyle = 7   # minimized: Node is a console program; the launcher exits at once
        $sc.Save()
        Done "$(if ($had) { 'updated' } else { 'written' })  Claude Dashboard.lnk ($scDir)"
      }
    }
  } elseif (Test-Path $lnk) {
    # Only ours: one whose arguments run the dashboard launcher.
    if ($wsh.CreateShortcut($lnk).Arguments -match (& $dashFind 'launcher.mjs')) {
      Remove-Item $lnk -Force; Done 'deleted  Claude Dashboard.lnk (-Remove Dashboard)'
    } else { Miss "$lnk was left in place: it doesn't run the dashboard launcher, so it isn't this installer's" }
  }
}

$restartVsCode = $false
if (-not $SkipToolCheck) {
  Step 'Tools'
  # The rules call a bare `plannotator`, so it must resolve on this shell's PATH. Plannotator's installer adds
  # its folder to the user PATH, but terminals inherit VS Code's environment from when VS Code started; a
  # binary installed later stays invisible until every VS Code window is closed and VS Code is reopened.
  $plannotatorExe = "$env:LOCALAPPDATA\plannotator\plannotator.exe"
  $plannotator = (Get-Command plannotator -ErrorAction SilentlyContinue).Source
  if ($plannotator) { Ok "Plannotator binary: $(& $plannotator --version 2>$null)" }
  elseif (Test-Path $plannotatorExe) {
    Miss "Plannotator binary is installed ($(& $plannotatorExe --version 2>$null)) but not on this shell's PATH: close every VS Code window and reopen VS Code"
    $restartVsCode = $true
  }
  elseif ($InstallTools) { Invoke-RestMethod https://plannotator.ai/install.ps1 | Invoke-Expression; $restartVsCode = $true }
  else { Miss 'Plannotator binary (irm https://plannotator.ai/install.ps1 | iex)' }
  $hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
  $hasCode = [bool](Get-Command code -ErrorAction SilentlyContinue)
  if (-not $hasClaude) { Miss 'Claude Code CLI (`claude`) not on PATH, so its plugins were not checked: install Claude Code, then rerun' }
  if (-not $hasCode) { Miss 'VS Code''s `code` command not on PATH, so the WebView extension was not checked: install VS Code, reopen the terminal, then rerun' }
  $plugins = if ($hasClaude) { (& claude plugin list 2>$null) -join "`n" }
  foreach ($p in @(if ($hasClaude) {
      @{ Name = 'plannotator@plannotator'; Market = 'backnotprop/plannotator' },
      @{ Name = 'visualizer@visualizer';   Market = 'stemado/visualizer-plugin' } })) {
    if ($plugins -match [regex]::Escape(($p.Name -split '@')[0])) { Ok "plugin $($p.Name)" }
    elseif ($InstallTools) {
      & claude plugin marketplace add $p.Market
      & claude plugin install $p.Name
    } else { Miss "plugin $($p.Name) (claude plugin marketplace add $($p.Market); claude plugin install $($p.Name))" }
  }
  if ($hasCode) {
    $ext = (& code --list-extensions 2>$null) -join "`n"
    if ($ext -match 'backnotprop\.plannotator-webview') { Ok 'VS Code extension backnotprop.plannotator-webview' }
    elseif ($InstallTools) { & code --install-extension backnotprop.plannotator-webview }
    else { Miss 'VS Code extension (code --install-extension backnotprop.plannotator-webview)' }
  }
  # The rule uses Board cards and thread checklists; both are Inbox capabilities, off by default and kept in
  # Plannotator's own config. Check them here; turning them on stays in the Inbox's Settings.
  $pn = if ($plannotator) { $plannotator } elseif (Test-Path $plannotatorExe) { $plannotatorExe }
  if ($pn) {
    $cfgPath = Join-Path (& $pn data-dir 2>$null) 'config.json'
    $cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { $null }
    foreach ($c in @(@{ Key = 'inboxBoard'; Name = 'Board' }, @{ Key = 'inboxSteps'; Name = 'Steps' })) {
      if ($cfg -and $cfg.($c.Key) -eq $true) { Ok "Inbox capability $($c.Name) is on" }
      else { Miss "Inbox capability $($c.Name) is off: plannotator inbox --open, then Settings > Capabilities" }
    }
  }
  if ($Owner -and (Test-Path (Join-Path $repo '.git'))) {
    # The maintainer's guard: commits to this repo must not carry personal data (tools/check-personal.ps1).
    $hook = Join-Path $repo '.git/hooks/pre-commit'
    $body = "#!/bin/sh`nexec pwsh -NoProfile -File tools/check-personal.ps1 -Staged`n"
    if (-not (Test-Path $hook) -or (Get-Content -Raw $hook) -ne $body) { Set-Content $hook $body -NoNewline; Done 'written  pre-commit hook (personal-data check)' }
    else { Ok 'pre-commit hook (personal-data check)' }
  }
}

if ($BmadProject.Count) {
  Step 'BMAD overrides'
  $py = Join-Path $claude 'bmad/write_overrides.py'
  # Personal overrides only: the review policy and, when the Fable component is installed, the Fable final
  # review for the planning skills (decision 21). Never overwrites.
  if (-not (Test-Path $py)) { Miss 'BMAD overrides need the Bmad component (-Components ...,Bmad)'; $BmadProject = @() }
  else { & python -I $py @BmadProject }
  $fable = Test-Path (Join-Path $claude 'bmad/fable-final-review.md')
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if ($BmadProject.Count -and -not $uv) { Miss 'uv not found: overrides written, but not checked with BMAD''s resolver (install uv to check)' }
  foreach ($p in $BmadProject) {
    if (-not $uv) { break }
    $resolver = Join-Path $p '_bmad/scripts/resolve_customization.py'
    if (-not (Test-Path $resolver)) { Miss "$p has no BMAD resolver"; continue }
    $out = & uv run $resolver --skill (Join-Path $claude 'skills/bmad-prd') --project-root $p --key workflow.persistent_facts 2>&1
    $joined = $out -join ''
    if ($joined -match 'interactive-review\.md') { Ok "$p resolves the review policy (checked bmad-prd)" }
    else { Miss "$p does not resolve the review policy: $out" }
    if (-not $fable) { continue }
    # The personal copy only: a team copy committed in the project (before decision 21) must not satisfy it.
    if ($joined -match '\.claude/bmad/fable-final-review\.md') { Ok "$p resolves the personal Fable final review (checked bmad-prd)" }
    else { Miss "$p does not resolve the Fable final review: $out" }
  }
}

# The Summary is what an agent running this relays to the person. Exit 0: done. Exit 3: installed, but
# something below needs attention.
Step 'Summary'
if ($script:pending.Count) {
  Write-Host "  $($script:pending.Count) thing(s) left to do:"
  foreach ($m in $script:pending) { Write-Host "    - $m" }
} else { Write-Host '  Nothing left to do.' }
if ($restartVsCode) { Write-Host '  Then: close every VS Code window, reopen VS Code, then start a new Claude Code session in its terminal (a new terminal alone keeps the old PATH).' }
else { Write-Host '  Then: start a new Claude Code session (in a VS Code terminal) so the settings and rules load.' }
exit ($script:pending.Count ? 3 : 0)
