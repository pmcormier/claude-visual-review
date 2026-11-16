#Requires -Version 7
<#
.SYNOPSIS
  Installs the visual-first review setup for Claude Code on this machine (Windows).

.DESCRIPTION
  Copies the chosen components from global/ into ~/.claude (building the VS Code opener), points
  PLANNOTATOR_BROWSER at it in ~/.claude/settings.json (and, with Rigor, adds its UserPromptSubmit hook there),
  checks the tools the rules rely on, and (optionally)
  adds the BMAD overrides to the projects you name.

  It never replaces a file you changed: a file in ~/.claude that differs from both this repo's copy and what
  the installer last wrote there is shown and asked about, or, when nobody can answer (an agent running it),
  kept and reported with the command that replaces it. What it wrote is recorded in
  ~/.claude/visual-review/installed.json. Safe to re-run; settings are merged, BMAD overrides never overwritten.

.PARAMETER Components
  Which parts to install: Review (always), Methods (how the planning method is picked, BMAD and superpowers),
  Bmad (the BMAD review layer), Fable (the Fable final review for BMAD planning docs; needs Fable access),
  Rigor (verification rules, and a hook that sends a pushback check with every message; needs Node.js).
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
  [switch]$SkipToolCheck
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
}
$about = [ordered]@{
  Methods = 'how the planning method is picked per task, work tracking, BMAD and superpowers'
  Bmad    = 'the review layer for BMAD workflows'
  Fable   = 'the Fable final review of BMAD planning docs (needs access to the Fable model)'
  Rigor   = 'verification rules, and a check sent with every message so Claude holds a correct answer under pushback (needs Node.js)'
}

Step 'Components'
# Lists may arrive as one comma-separated string (pwsh -File, or an agent's shell).
function Split-List([string[]]$List) { @($List | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Components = Split-List $Components
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
Ok ($Components -join ', ')

Step 'Files'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$skipped = @{}
$rerun = if ($Owner) { './install.ps1 -Owner' } else { "./install.ps1 -Components $($Components -join ',')" }
foreach ($c in $Components) {
  foreach ($srcRel in $componentFiles[$c]) {
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
if (-not $settingsOk) {
  Miss "settings.json isn't valid JSON, so PLANNOTATOR_BROWSER$(if ($Components -contains 'Rigor') { ' and the Rigor hook' }) weren't set: fix or remove $settingsPath, then rerun"
} else {
  $changes = @()
  if ($settings['env'] -isnot [Collections.IDictionary]) { $settings['env'] = @{} }
  if ($settings['env']['PLANNOTATOR_BROWSER'] -ne $opener) {
    $settings['env']['PLANNOTATOR_BROWSER'] = $opener
    $changes += "set PLANNOTATOR_BROWSER = $opener"
  } else { Ok 'PLANNOTATOR_BROWSER already set' }
  if ($Components -contains 'Rigor') {
    # One UserPromptSubmit entry that runs the pushback check; any other hooks are left as they are. Found again
    # on a rerun by the script's file name, so it is never added twice.
    $hookCmd = "node `"$((Join-Path $claude 'hooks/pushback-check.mjs') -replace '\\', '/')`""
    if ($settings['hooks'] -isnot [Collections.IDictionary]) { $settings['hooks'] = [ordered]@{} }
    $groups = @($settings['hooks']['UserPromptSubmit'] | Where-Object { $_ })
    $existing = @($groups | ForEach-Object { $_['hooks'] } | Where-Object { "$($_['command'])" -match 'pushback-check\.mjs' })
    if ($existing.Count -and $existing[0]['command'] -eq $hookCmd) { Ok 'Rigor hook (UserPromptSubmit) already set' }
    elseif ($existing.Count) {
      $existing[0]['command'] = $hookCmd
      $changes += 'updated the Rigor hook command'
    } else {
      $settings['hooks']['UserPromptSubmit'] = @($groups) + @([ordered]@{ hooks = @([ordered]@{ type = 'command'; command = $hookCmd }) })
      $changes += 'added the Rigor hook (UserPromptSubmit)'
    }
    if (-not $SkipToolCheck -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
      Miss 'Node.js (`node`) not on PATH, so the Rigor hook cannot run: install Node.js, then start a new session'
    }
  }
  if ($changes.Count) {
    $note = if (Test-Path $settingsPath) { "; backup: $(Backup $settingsPath)" } else { '' }
    $settings | ConvertTo-Json -Depth 50 | Set-Content $settingsPath -Encoding utf8NoBOM
    Done "$($changes -join '; ') (other settings kept$note)"
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
