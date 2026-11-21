# Bring a Claude Code session's window to the front (decision 49). Called by the dashboard server with the session's
# process id, its title and its folder as separate arguments. Prints one JSON line: {"result": ..., "host": ...}.
#   front: raised (in Windows Terminal, after selecting the tab named after the session)
#   dup: raised, but more than one tab matches the title, so no tab was picked
#   window: raised the window without picking a tab (VS Code: the window with the folder open)
#   flash: Windows kept focus elsewhere; nowindow: no window found up the process chain
param([int]$ProcessId, [string]$Title = '', [string]$Folder = '')
$ErrorActionPreference = 'Stop'
function Out-Result($result, $hostName) { [pscustomobject]@{ result = $result; host = $hostName } | ConvertTo-Json -Compress; exit 0 }

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class DashFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

# Up the parent chain to the first process with a window.
$win = $null; $p = $ProcessId
for ($i = 0; $i -lt 10 -and $p; $i++) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) { $win = $proc; break }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if (-not $cim) { break }
  $p = [int]$cim.ParentProcessId
}
if (-not $win) { Out-Result 'nowindow' $null }
$hostName = $win.ProcessName

function Raise([IntPtr]$h) {
  if ([DashFocus]::IsIconic($h)) { [DashFocus]::ShowWindow($h, 9) | Out-Null }
  [DashFocus]::SetForegroundWindow($h) | Out-Null
  if ([DashFocus]::GetForegroundWindow() -ne $h) {
    # Windows lets the program that last had input take focus; a tap of Alt counts as input.
    [DashFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DashFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [DashFocus]::SetForegroundWindow($h) | Out-Null
  }
  return ([DashFocus]::GetForegroundWindow() -eq $h)
}

if ($hostName -eq 'Code') {
  # VS Code shares one process for all its windows: open the folder, which brings up the window that has it.
  # The folder must be an existing absolute directory, and goes to Code.exe itself as one argument (no shell, no
  # code.cmd shim), so cmd.exe never reads it.
  if ($Folder -and -not $Folder.StartsWith('-') -and [IO.Path]::IsPathRooted($Folder) -and (Test-Path -LiteralPath $Folder -PathType Container) -and $win.Path) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($win.Path)
    $psi.UseShellExecute = $false
    $psi.ArgumentList.Add('--reuse-window')
    $psi.ArgumentList.Add([IO.Path]::GetFullPath($Folder))
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  }
  Out-Result 'window' 'Code'
}

$result = 'window'
if ($hostName -eq 'WindowsTerminal' -and $Title) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($win.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  # A tab is named after its session, after a spinner or status mark ("◐ Fix the cart").
  $want = $Title.Trim()
  $tabs = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) | Where-Object { ($_.Current.Name -replace '^[^\p{L}\p{N}]+', '').Trim() -eq $want })
  if ($tabs.Count -eq 1) {
    $tabs[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $result = 'front'
  } elseif ($tabs.Count -gt 1) { $result = 'dup' }
}
if (-not (Raise $win.MainWindowHandle)) { Out-Result 'flash' $hostName }
Out-Result $result $hostName
