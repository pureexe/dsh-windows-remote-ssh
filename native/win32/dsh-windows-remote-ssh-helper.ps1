#Requires -Version 5.1
<#
  dsh-windows-remote-ssh native helper (Windows PowerShell 5.1).

  One invocation = one request = one process. The harness stages a JSON
  request file over SFTP, runs this script once via an SSH exec channel
  (`powershell.exe -File ... -RequestPath ... -ResponsePath ...`), and reads
  the JSON response file back over SFTP. File-based I/O (rather than
  stdin/stdout across the SSH channel) sidesteps Windows console code-page
  and UTF-16/UTF-8 encoding pitfalls entirely. Exit code is always 0 even for
  handled failures; the error envelope IS the response.

  Nothing here is pre-installed beyond stock Windows: only .NET Framework
  types already on the box (UIAutomationClient/Types, System.Drawing) and
  user32/kernel32 P/Invoke. No third-party modules, no Python, no helper EXE.

  This file is NOT a security boundary by itself - the harness-side
  freshness check, approval gate, and process-identity check are (see
  src/actions.ts). This script only refuses to invent global input: actions
  address one window by handle, and it never moves the physical mouse cursor
  or steals keyboard focus unless the caller explicitly set focusFallback.

  Operations: windows, apps, shot, tree, snapshot, click, type, scroll, key,
  move, windowControl, invokePattern, readText, readTable, launch,
  powershell, clipboard, process, displays, notify.
#>
param(
  # Workdir NAME only (not a full path): resolved against $env:TEMP here so
  # the Scheduled Task that runs this script (see src/platform/runner.ts)
  # only has to carry this short name, plus $Id, on its /TR command line -
  # not two full request/response paths repeated. /TR is capped at 261
  # characters by schtasks itself.
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Id
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$WorkDir = Join-Path $env:TEMP $Dir
$RequestPath = Join-Path $WorkDir "req-$Id.json"
$ResponsePath = Join-Path $WorkDir "resp-$Id.json"

# ---------------------------------------------------------------------------
# Win32 interop (one Add-Type block; PS 5.1-safe C#).
# ---------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshRemoteWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder buffer, ref uint size);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left; public int Top; public int Right; public int Bottom;
  }

  public static IntPtr[] EnumVisibleWindows() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (IsWindowVisible(hWnd)) list.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static string WindowTitle(IntPtr hWnd) {
    var sb = new StringBuilder(1024);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string WindowClass(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetClassName(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@ | Out-Null

try {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
} catch {
  $body = @{ ok = $false; error = @{ code = 'UIA_FAILED'; message = "cannot load UIAutomation/System.Drawing: $($_.Exception.Message)" } } | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText($ResponsePath, $body, $Utf8NoBom)
  exit 0
}

# ---------------------------------------------------------------------------
# Small helpers.
# ---------------------------------------------------------------------------
function Get-WindowRectInfo($hwnd) {
  $rect = New-Object DshRemoteWin32+RECT
  [void][DshRemoteWin32]::GetWindowRect($hwnd, [ref]$rect)
  return @{
    x = [int]$rect.Left; y = [int]$rect.Top
    width = [int]($rect.Right - $rect.Left); height = [int]($rect.Bottom - $rect.Top)
  }
}

function Get-ProcessFacts($hwnd) {
  $pidValue = 0
  [void][DshRemoteWin32]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
  $pidInt = [int]$pidValue
  $path = $null
  if ($pidInt -gt 0) {
    $handle = [DshRemoteWin32]::OpenProcess(0x1000, $false, [uint32]$pidInt)  # PROCESS_QUERY_LIMITED_INFORMATION
    if ($handle -ne [IntPtr]::Zero) {
      try {
        $size = [uint32]1024
        $buffer = New-Object System.Text.StringBuilder 1024
        if ([DshRemoteWin32]::QueryFullProcessImageName($handle, 0, $buffer, [ref]$size)) {
          $path = $buffer.ToString()
        }
      } finally {
        [void][DshRemoteWin32]::CloseHandle($handle)
      }
    }
  }
  return @{ pid = $pidInt; executablePath = $path }
}

function Get-StringHash($text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $hashBytes = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-BitmapHash($bitmap) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
  $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $byteCount = [Math]::Abs($data.Stride) * $bitmap.Height
    $bytes = New-Object byte[] $byteCount
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $byteCount)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha.ComputeHash($bytes)
      return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $bitmap.UnlockBits($data)
  }
}

function Get-UiaElement($hwnd) {
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
}

function ConvertTo-Hwnd($value) {
  if ($null -eq $value) { return [IntPtr]::Zero }
  if ($value -is [int]) { return [IntPtr][int64]$value }
  if ($value -is [int64]) { return [IntPtr]$value }
  if ($value -is [double]) { return [IntPtr][int64]$value }
  return [IntPtr]::Zero
}

function Resolve-Window($target) {
  if ($null -eq $target) { $target = @{} }
  $hwnd = ConvertTo-Hwnd $target.windowId
  if ($hwnd -ne [IntPtr]::Zero) {
    $rect = Get-WindowRectInfo $hwnd
    if ($rect.width -le 0 -and $rect.height -le 0) {
      throw "window $($target.windowId) not found"
    }
    return $hwnd
  }
  $title = $target.windowTitle
  if ($null -ne $title -and $title -is [string] -and $title.Length -gt 0) {
    foreach ($candidate in [DshRemoteWin32]::EnumVisibleWindows()) {
      if ([DshRemoteWin32]::WindowTitle($candidate) -like "*$title*") { return $candidate }
    }
    throw "no visible window matches title '$title'"
  }
  $processId = $target.processId
  if ($null -ne $processId -and $processId -is [int] -and $processId -gt 0) {
    foreach ($candidate in [DshRemoteWin32]::EnumVisibleWindows()) {
      $pidValue = 0
      [void][DshRemoteWin32]::GetWindowThreadProcessId($candidate, [ref]$pidValue)
      if ([int]$pidValue -eq [int]$processId) { return $candidate }
    }
    throw "no visible window owned by process $processId"
  }
  $foreground = [DshRemoteWin32]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { throw 'no foreground window and no target given' }
  return $foreground
}

# ---------------------------------------------------------------------------
# Accessibility walk (canonical: the same walk builds treeHash everywhere).
# ---------------------------------------------------------------------------
$script:TreeNodes = @()

function Get-RuntimeIdString($element) {
  try {
    $ids = $element.GetRuntimeId()
    $parts = @()
    foreach ($id in $ids) { $parts += [string][int]$id }
    return ($parts -join '.')
  } catch {
    return ''
  }
}

function Get-ElementPatterns($element) {
  $patterns = @()
  $probe = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$probe)) { $patterns += 'value' }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$probe)) { $patterns += 'invoke' }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$probe)) { $patterns += 'scroll' }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$probe)) { $patterns += 'toggle' }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$probe)) { $patterns += 'selection-item' }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$probe)) { $patterns += 'expand-collapse' }
  return $patterns
}

function Get-ElementRecord($element) {
  $name = ''
  $controlType = ''
  $automationId = ''
  $enabled = $false
  $rect = @{ x = 0; y = 0; width = 0; height = 0 }
  try {
    $name = [string]$element.Current.Name
    $controlType = [string]$element.Current.ControlType.ProgrammaticName
    if ($controlType -like 'ControlType.*') { $controlType = $controlType.Substring(12) }
    $automationId = [string]$element.Current.AutomationId
    $enabled = [bool]$element.Current.IsEnabled
    $bounds = $element.Current.BoundingRectangle
    if (-not $bounds.IsEmpty) {
      $rect = @{ x = [int]$bounds.X; y = [int]$bounds.Y; width = [int]$bounds.Width; height = [int]$bounds.Height }
    }
  } catch { }
  return @{
    elementId = (Get-RuntimeIdString $element)
    controlType = $controlType
    name = $name
    automationId = $automationId
    rect = $rect
    enabled = $enabled
    patterns = @(Get-ElementPatterns $element)
  }
}

function Walk-UiaTree($element, $depth, $maxDepth, $maxElements) {
  if ($script:TreeNodes.Count -ge $maxElements -or $depth -gt $maxDepth -or $null -eq $element) { return }
  $record = Get-ElementRecord $element
  if ($record.elementId -ne '') {
    $script:TreeNodes += $record
  }
  if ($script:TreeNodes.Count -ge $maxElements) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try {
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child -and $script:TreeNodes.Count -lt $maxElements -and $depth -lt $maxDepth) {
      Walk-UiaTree $child ($depth + 1) $maxDepth $maxElements
      if ($script:TreeNodes.Count -ge $maxElements) { break }
      $child = $walker.GetNextSibling($child)
    }
  } catch { }
}

function Get-TreeHashText($nodes) {
  $material = @()
  foreach ($node in $nodes) {
    $r = $node.rect
    $material += "$($node.elementId)|$($node.controlType)|$($node.name)|$($r.x),$($r.y),$($r.width),$($r.height)"
  }
  return ($material -join ';')
}

# ---------------------------------------------------------------------------
# Screenshot.
# ---------------------------------------------------------------------------
function Get-WindowBitmap($hwnd) {
  $rectInfo = Get-WindowRectInfo $hwnd
  if ($rectInfo.width -le 0 -or $rectInfo.height -le 0) { throw "window $hwnd has no drawable rect" }
  $bitmap = New-Object System.Drawing.Bitmap($rectInfo.width, $rectInfo.height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rectInfo.x, $rectInfo.y, 0, 0, (New-Object System.Drawing.Size($rectInfo.width, $rectInfo.height)))
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Get-PrimaryBitmap() {
  $width = [DshRemoteWin32]::GetSystemMetrics(0)   # SM_CXSCREEN
  $height = [DshRemoteWin32]::GetSystemMetrics(1)  # SM_CYSCREEN
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Resize-BitmapIfNeeded($bitmap, $maxSide) {
  $longest = [Math]::Max($bitmap.Width, $bitmap.Height)
  if ($longest -le $maxSide) { return $bitmap }
  $scale = $maxSide / $longest
  $newWidth = [int][Math]::Max(1, [Math]::Round($bitmap.Width * $scale))
  $newHeight = [int][Math]::Max(1, [Math]::Round($bitmap.Height * $scale))
  $resized = New-Object System.Drawing.Bitmap($newWidth, $newHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($resized)
  try {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
  } finally {
    $graphics.Dispose()
  }
  $bitmap.Dispose()
  return $resized
}

function Get-BitmapBase64($bitmap) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return [Convert]::ToBase64String($stream.ToArray())
  } finally {
    $stream.Dispose()
  }
}

function Get-PixelColorText($bitmap, $x, $y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bitmap.Width -or $y -ge $bitmap.Height) { return $null }
  $color = $bitmap.GetPixel($x, $y)
  return "rgb($($color.R), $($color.G), $($color.B))"
}

# ---------------------------------------------------------------------------
# Element lookup + input synthesis.
# ---------------------------------------------------------------------------
function Find-ElementByRuntimeId($windowElement, $runtimeIdText) {
  $parts = @()
  foreach ($part in ($runtimeIdText -split '\.')) { $parts += [int]$part }
  if ($parts.Count -eq 0) { return $null }
  # PropertyCondition insists on a value that IS-A Int32[]; PowerShell's `+=`
  # produces a plain Object[] even when every element is boxed as [int], so
  # an explicit [int[]] cast is required here or the constructor throws.
  $ids = [int[]]$parts
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::RuntimeIdProperty, $ids)
  try {
    return $windowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  } catch {
    return $null
  }
}

function Get-ElementCenter($element) {
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.IsEmpty) { throw 'element has no bounding rectangle' }
  return @{ x = [int]($bounds.X + $bounds.Width / 2); y = [int]($bounds.Y + $bounds.Height / 2) }
}

function Get-ClientPoint($windowRect, $screenX, $screenY) {
  $cx = $screenX - $windowRect.x
  $cy = $screenY - $windowRect.y
  if ($cx -lt 0 -or $cy -lt 0 -or $cx -ge $windowRect.width -or $cy -ge $windowRect.height) {
    throw "point ($screenX, $screenY) lies outside the target window"
  }
  return @{ x = $cx; y = $cy }
}

function Get-LParam($cx, $cy) {
  return [IntPtr](($cy -shl 16) -bor ($cx -band 0xFFFF))
}

function Post-Click($hwnd, $cx, $cy, $button) {
  $down = if ($button -eq 'right') { 0x204 } else { 0x201 }
  $up = if ($button -eq 'right') { 0x205 } else { 0x202 }
  $lparam = Get-LParam $cx $cy
  [void][DshRemoteWin32]::PostMessage($hwnd, $down, [IntPtr]1, $lparam)
  [void][DshRemoteWin32]::PostMessage($hwnd, $up, [IntPtr]0, $lparam)
}

function Get-KeyMap() {
  $map = @{}
  $map['ENTER'] = 0x0D; $map['RETURN'] = 0x0D
  $map['TAB'] = 0x09; $map['ESC'] = 0x1B; $map['ESCAPE'] = 0x1B
  $map['BACKSPACE'] = 0x08; $map['DELETE'] = 0x2E; $map['DEL'] = 0x2E
  $map['SPACE'] = 0x20; $map['INSERT'] = 0x2D
  $map['HOME'] = 0x24; $map['END'] = 0x23
  $map['PAGEUP'] = 0x21; $map['PGUP'] = 0x21; $map['PAGEDOWN'] = 0x22; $map['PGDN'] = 0x22
  $map['UP'] = 0x26; $map['DOWN'] = 0x28; $map['LEFT'] = 0x25; $map['RIGHT'] = 0x27
  $map['CTRL'] = 0x11; $map['CONTROL'] = 0x11
  $map['SHIFT'] = 0x10
  $map['ALT'] = 0x12; $map['MENU'] = 0x12
  $map['WIN'] = 0x5B; $map['WINDOWS'] = 0x5B
  foreach ($n in 1..12) { $map["F$n"] = 0x6F + $n }
  foreach ($c in 0..9) { $map["$c"] = 0x30 + $c }
  # NOT `foreach ($c in 'A'..'Z')`: PowerShell's `..` range operator only
  # accepts operands it can convert to [int] - a multi-char-looking string
  # literal like 'A' fails that conversion ("Cannot convert value 'A' to
  # type System.Int32"), even though it reads like a char range. Loop over
  # the actual VK/ASCII codes (0x41-0x5A) instead and build the string key
  # from each one.
  for ($code = 0x41; $code -le 0x5A; $code++) { $map[[string][char]$code] = $code }
  return $map
}

$script:ModifierNames = @('CTRL', 'CONTROL', 'SHIFT', 'ALT', 'MENU', 'WIN', 'WINDOWS')

function Post-KeyCombo($hwnd, $keysText) {
  $map = Get-KeyMap
  $tokens = @()
  foreach ($token in ($keysText -split '\+')) {
    $trimmed = $token.Trim()
    if ($trimmed.Length -eq 0) { continue }
    $tokens += $trimmed.ToUpperInvariant()
  }
  if ($tokens.Count -eq 0) { throw 'empty key combination' }
  $modifiers = @()
  $mainKeys = @()
  foreach ($token in $tokens) {
    if ($script:ModifierNames -contains $token) {
      $modifiers += $token
    } elseif ($map.ContainsKey($token)) {
      $mainKeys += $token
    } elseif ($token.Length -eq 1) {
      $mainKeys += $token
    } else {
      throw "unknown key '$token'"
    }
  }
  foreach ($modifier in $modifiers) {
    [void][DshRemoteWin32]::PostMessage($hwnd, 0x100, [IntPtr]$map[$modifier], [IntPtr]0)
  }
  foreach ($key in $mainKeys) {
    if ($map.ContainsKey($key)) {
      $code = $map[$key]
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x100, [IntPtr]$code, [IntPtr]0)
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x101, [IntPtr]$code, [IntPtr]0)
    } else {
      $charCode = [int][char]$key
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x100, [IntPtr]$charCode, [IntPtr]0)
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x102, [IntPtr]$charCode, [IntPtr]0)
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x101, [IntPtr]$charCode, [IntPtr]0)
    }
  }
  for ($i = $modifiers.Count - 1; $i -ge 0; $i--) {
    [void][DshRemoteWin32]::PostMessage($hwnd, 0x101, [IntPtr]$map[$modifiers[$i]], [IntPtr]0)
  }
}

# ---------------------------------------------------------------------------
# Operations.
# ---------------------------------------------------------------------------
function Invoke-OpWindows {
  $windows = @()
  foreach ($hwnd in [DshRemoteWin32]::EnumVisibleWindows()) {
    $pidValue = 0
    [void][DshRemoteWin32]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
    $windows += @{
      windowId = [int64]$hwnd
      processId = if ([int]$pidValue -gt 0) { [int]$pidValue } else { $null }
      title = [DshRemoteWin32]::WindowTitle($hwnd)
      className = [DshRemoteWin32]::WindowClass($hwnd)
      rect = (Get-WindowRectInfo $hwnd)
      executablePath = $null
      visible = $true
      minimized = [bool][DshRemoteWin32]::IsIconic($hwnd)
      maximized = [bool][DshRemoteWin32]::IsZoomed($hwnd)
    }
  }
  $pidCache = @{}
  foreach ($window in $windows) {
    if ($null -eq $window.processId) { continue }
    if (-not $pidCache.ContainsKey($window.processId)) {
      $facts = Get-ProcessFacts ([IntPtr][int64]$window.windowId)
      $pidCache[$window.processId] = $facts.executablePath
    }
    $window.executablePath = $pidCache[$window.processId]
  }
  # The unary comma forces this to stay an array on the pipeline even with
  # exactly one (or zero) visible windows - PowerShell otherwise enumerates
  # a returned array onto the pipeline element-by-element, so a bare
  # `return $windows` with exactly one window would hand the *caller*
  # (`$result = Invoke-OpWindows`) a single hashtable instead of a 1-element
  # array, and ConvertTo-Json would then serialize it as a JSON object
  # instead of a JSON array - exactly the bug hit by Invoke-OpDisplays below
  # on a single-monitor host.
  return ,$windows
}

function Invoke-OpApps {
  $byPid = @{}
  foreach ($hwnd in [DshRemoteWin32]::EnumVisibleWindows()) {
    $pidValue = 0
    [void][DshRemoteWin32]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
    $pidInt = [int]$pidValue
    if ($pidInt -le 0) { continue }
    if (-not $byPid.ContainsKey($pidInt)) { $byPid[$pidInt] = @() }
    $byPid[$pidInt] += @{
      windowId = [int64]$hwnd
      processId = $pidInt
      title = [DshRemoteWin32]::WindowTitle($hwnd)
      className = [DshRemoteWin32]::WindowClass($hwnd)
      rect = (Get-WindowRectInfo $hwnd)
      executablePath = $null
      visible = $true
      minimized = [bool][DshRemoteWin32]::IsIconic($hwnd)
      maximized = [bool][DshRemoteWin32]::IsZoomed($hwnd)
    }
  }
  $apps = @()
  foreach ($pidInt in ($byPid.Keys | Sort-Object)) {
    $windows = $byPid[$pidInt]
    $facts = Get-ProcessFacts ([IntPtr][int64]$windows[0].windowId)
    $name = ''
    try {
      $process = Get-Process -Id $pidInt -ErrorAction Stop
      $name = [string]$process.ProcessName
    } catch { }
    foreach ($window in $windows) { $window.executablePath = $facts.executablePath }
    $apps += @{
      processId = $pidInt
      name = $name
      executablePath = $facts.executablePath
      windows = $windows
    }
  }
  # See the matching comment in Invoke-OpWindows: without the unary comma, a
  # single running application with windows would collapse to a bare
  # hashtable instead of a 1-element array once it crosses the pipeline back
  # to the caller.
  return ,$apps
}

function Get-SnapshotRecord($hwnd, $maxElements, $maxDepth) {
  $facts = Get-ProcessFacts $hwnd
  $rect = Get-WindowRectInfo $hwnd
  $foreground = ([DshRemoteWin32]::GetForegroundWindow() -eq $hwnd)
  $script:TreeNodes = @()
  $element = Get-UiaElement $hwnd
  Walk-UiaTree $element 0 $maxDepth $maxElements
  $treeHash = Get-StringHash (Get-TreeHashText $script:TreeNodes)
  $bitmap = Get-WindowBitmap $hwnd
  $shotHash = $null
  try {
    $shotHash = Get-BitmapHash $bitmap
  } finally {
    $bitmap.Dispose()
  }
  return @{
    windowId = [int64]$hwnd
    processId = $facts.pid
    executablePath = $facts.executablePath
    title = [DshRemoteWin32]::WindowTitle($hwnd)
    className = [DshRemoteWin32]::WindowClass($hwnd)
    rect = $rect
    foreground = $foreground
    treeHash = $treeHash
    shotHash = $shotHash
    elementCount = $script:TreeNodes.Count
  }
}

function Invoke-OpSnapshot($opArgs) {
  $hwnd = Resolve-Window @{ windowId = $opArgs.windowId }
  $maxElements = if ($null -ne $opArgs.maxElements) { [int]$opArgs.maxElements } else { 500 }
  $maxDepth = if ($null -ne $opArgs.maxDepth) { [int]$opArgs.maxDepth } else { 32 }
  return (Get-SnapshotRecord $hwnd $maxElements $maxDepth)
}

function Get-ScreenRegionBitmap($left, $top, $width, $height) {
  if ($width -le 0 -or $height -le 0) { throw 'region must have right > left and bottom > top' }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Invoke-OpShot($opArgs) {
  $target = if ($null -ne $opArgs.target) { $opArgs.target } else { @{} }
  $maxSide = if ($null -ne $opArgs.maxSide) { [int]$opArgs.maxSide } else { 1600 }
  $maxElements = if ($null -ne $opArgs.maxElements) { [int]$opArgs.maxElements } else { 500 }
  $maxDepth = if ($null -ne $opArgs.maxDepth) { [int]$opArgs.maxDepth } else { 32 }
  $wholeScreen = if ($null -ne $opArgs.wholeScreen) { [bool]$opArgs.wholeScreen } else { $false }
  $region = $opArgs.region
  $displayIndex = if ($null -ne $opArgs.display) { [int]$opArgs.display } else { $null }
  if ($null -ne $region) {
    # An explicit rectangle capture takes precedence over target/wholeScreen/
    # display: windowId 0 is the same "not one window" sentinel as a whole-
    # screen capture and is never a valid basedOn target for a later action.
    $left = [int]$region.left; $top = [int]$region.top
    $width = [int]$region.right - $left; $height = [int]$region.bottom - $top
    $bitmap = Get-ScreenRegionBitmap $left $top $width $height
    $snapshot = @{
      windowId = 0; processId = 0; executablePath = $null
      title = 'screen region'; className = 'Region'
      rect = @{ x = $left; y = $top; width = $width; height = $height }
      foreground = $true; treeHash = ''; shotHash = ''; elementCount = 0
    }
  } elseif ($wholeScreen) {
    if ($null -ne $displayIndex) {
      $screens = [System.Windows.Forms.Screen]::AllScreens
      if ($displayIndex -lt 0 -or $displayIndex -ge $screens.Count) {
        throw "display index $displayIndex out of range (0..$($screens.Count - 1))"
      }
      $bounds = $screens[$displayIndex].Bounds
      $bitmap = Get-ScreenRegionBitmap ([int]$bounds.X) ([int]$bounds.Y) ([int]$bounds.Width) ([int]$bounds.Height)
      $snapshot = @{
        windowId = 0; processId = 0; executablePath = $null
        title = "display $displayIndex"; className = 'Screen'
        rect = @{ x = [int]$bounds.X; y = [int]$bounds.Y; width = [int]$bounds.Width; height = [int]$bounds.Height }
        foreground = $true; treeHash = ''; shotHash = ''; elementCount = 0
      }
    } else {
      # Deliberate, explicit whole-screen capture: windowId 0 is a sentinel
      # meaning "not one window" and is never a valid basedOn target for a
      # later action.
      $bitmap = Get-PrimaryBitmap
      $snapshot = @{
        windowId = 0; processId = 0; executablePath = $null
        title = 'primary screen'; className = 'Screen'
        rect = @{ x = 0; y = 0; width = $bitmap.Width; height = $bitmap.Height }
        foreground = $true; treeHash = ''; shotHash = ''; elementCount = 0
      }
    }
  } else {
    # No target -> the current foreground window, exactly like Invoke-OpTree
    # (screen_read) with no target - the two observers must agree on this or
    # a later action's windowId (taken from either) can mismatch the
    # observation it cites.
    $hwnd = Resolve-Window $target
    $bitmap = Get-WindowBitmap $hwnd
    $snapshot = Get-SnapshotRecord $hwnd $maxElements $maxDepth
  }
  try {
    $bitmap = Resize-BitmapIfNeeded $bitmap $maxSide
    $base64 = Get-BitmapBase64 $bitmap
    return @{
      pngBase64 = $base64
      width = $bitmap.Width
      height = $bitmap.Height
      snapshot = $snapshot
    }
  } finally {
    $bitmap.Dispose()
  }
}

function Invoke-OpTree($opArgs) {
  $target = if ($null -ne $opArgs.target) { $opArgs.target } else { @{} }
  $maxElements = if ($null -ne $opArgs.maxElements) { [int]$opArgs.maxElements } else { 500 }
  $maxDepth = if ($null -ne $opArgs.maxDepth) { [int]$opArgs.maxDepth } else { 32 }
  $includePixels = if ($null -ne $opArgs.includePixels) { [bool]$opArgs.includePixels } else { $true }
  $hwnd = Resolve-Window $target
  $snapshot = Get-SnapshotRecord $hwnd $maxElements $maxDepth
  $script:TreeNodes = @()
  $element = Get-UiaElement $hwnd
  Walk-UiaTree $element 0 $maxDepth $maxElements
  $pixels = @()
  if ($includePixels) {
    $bitmap = Get-WindowBitmap $hwnd
    try {
      $rectInfo = Get-WindowRectInfo $hwnd
      $count = 0
      foreach ($node in $script:TreeNodes) {
        if ($count -ge 200) { break }
        $r = $node.rect
        if ($r.width -le 0 -or $r.height -le 0) { continue }
        $cx = $r.x + [int]($r.width / 2) - $rectInfo.x
        $cy = $r.y + [int]($r.height / 2) - $rectInfo.y
        $color = Get-PixelColorText $bitmap $cx $cy
        if ($null -ne $color) {
          $label = if ($node.name -ne '') { $node.name } else { "$($node.controlType)[$($node.elementId)]" }
          $pixels += @{ label = $label; x = $r.x + [int]($r.width / 2); y = $r.y + [int]($r.height / 2); color = $color }
          $count += 1
        }
      }
    } finally {
      $bitmap.Dispose()
    }
  }
  return @{
    snapshot = $snapshot
    elements = @($script:TreeNodes)
    pixels = $pixels
  }
}

function Get-ActionOutcome($hwnd, $action, $delivered, $restored, $detail) {
  $before = Get-ProcessFacts $hwnd
  $after = Get-ProcessFacts $hwnd
  $outcome = @{
    windowId = [int64]$hwnd
    action = $action
    delivered = $delivered
    processBefore = $before
    processAfter = $after
  }
  if ($null -ne $restored) { $outcome.restored = [bool]$restored }
  if ($null -ne $detail) { $outcome.detail = [string]$detail }
  return $outcome
}

function Invoke-SelectionItemAction($element, $selectionMode) {
  $selectionItem = $null
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionItem)) {
    return $false
  }
  switch ([string]$selectionMode) {
    'select' { $selectionItem.Select() }
    'add' { $selectionItem.AddToSelection() }
    'remove' { $selectionItem.RemoveFromSelection() }
    'toggle' {
      if ([bool]$selectionItem.Current.IsSelected) { $selectionItem.RemoveFromSelection() } else { $selectionItem.AddToSelection() }
    }
    default { throw "unknown selectionMode '$selectionMode'" }
  }
  return $true
}

function Invoke-OpClick($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  $windowRect = Get-WindowRectInfo $hwnd
  $windowElement = Get-UiaElement $hwnd
  $delivered = 'posted'
  $selectionMode = $request.selectionMode
  $hasSelectionMode = ($null -ne $selectionMode -and $selectionMode -is [string] -and $selectionMode.Length -gt 0)
  if ($null -ne $request.elementId -and $request.elementId -is [string] -and $request.elementId.Length -gt 0) {
    $element = Find-ElementByRuntimeId $windowElement ([string]$request.elementId)
    if ($null -eq $element) { throw "element '$($request.elementId)' not found in window $hwnd (re-run screen_read)" }
    if ($hasSelectionMode -and (Invoke-SelectionItemAction $element $selectionMode)) {
      $delivered = 'uia'
    } else {
      $invoke = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        $delivered = 'uia'
      } else {
        $center = Get-ElementCenter $element
        $client = Get-ClientPoint $windowRect $center.x $center.y
        Post-Click $hwnd $client.x $client.y ([string]$request.button)
        $delivered = 'posted'
      }
    }
  } else {
    if ($null -eq $request.x -or $null -eq $request.y) { throw 'click requires elementId or (x, y)' }
    $client = Get-ClientPoint $windowRect ([int]$request.x) ([int]$request.y)
    Post-Click $hwnd $client.x $client.y ([string]$request.button)
    $delivered = 'posted'
  }
  return (Get-ActionOutcome $hwnd 'click' $delivered $null $null)
}

function Invoke-OpType($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $rollback = if ($null -ne $request.rollback) { [bool]$request.rollback } else { $true }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  $windowElement = Get-UiaElement $hwnd
  $element = Find-ElementByRuntimeId $windowElement ([string]$request.elementId)
  if ($null -eq $element) { throw "element '$($request.elementId)' not found in window $hwnd (re-run screen_read)" }
  $value = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
    $original = [string]$value.Current.Value
    try {
      $value.SetValue([string]$request.text)
      return (Get-ActionOutcome $hwnd 'type' 'uia' $false $null)
    } catch {
      $restored = $false
      if ($rollback) {
        try {
          $value.SetValue($original)
          $restored = $true
        } catch { }
      }
      throw "type failed and rollback $(if ($restored) { 'restored the original text' } else { 'could NOT restore the original text' }): $($_.Exception.Message)"
    }
  }
  if ($focusFallback) {
    foreach ($ch in [char[]][string]$request.text) {
      $charCode = [int]$ch
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x102, [IntPtr]$charCode, [IntPtr]0)
    }
    return (Get-ActionOutcome $hwnd 'type' 'posted' $null 'typed via posted WM_CHAR (no value pattern on the element)')
  }
  throw "element '$($request.elementId)' exposes no value pattern and focusFallback is disabled - refusing to type into it"
}

function Invoke-OpScroll($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $amount = if ($null -ne $request.amount) { [int]$request.amount } else { 3 }
  if ($amount -lt 1) { throw 'scroll amount must be positive' }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  $windowElement = Get-UiaElement $hwnd
  $scroll = $null
  if ($null -ne $request.elementId -and $request.elementId -is [string] -and $request.elementId.Length -gt 0) {
    $element = Find-ElementByRuntimeId $windowElement ([string]$request.elementId)
    if ($null -eq $element) { throw "element '$($request.elementId)' not found in window $hwnd (re-run screen_read)" }
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll)) {
      $scroll = $null
    }
  }
  if ($null -ne $scroll) {
    if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
    $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
    switch ([string]$request.direction) {
      'up' { $vertical = [System.Windows.Automation.ScrollAmount]::SmallIncrement }
      'down' { $vertical = [System.Windows.Automation.ScrollAmount]::SmallDecrement }
      'page-up' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      'page-down' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
      default { throw "unknown scroll direction '$($request.direction)'" }
    }
    for ($i = 0; $i -lt $amount; $i++) {
      $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $vertical)
    }
    return (Get-ActionOutcome $hwnd 'scroll' 'uia' $null $null)
  }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  $direction = [string]$request.direction
  $page = ($direction -eq 'page-up' -or $direction -eq 'page-down')
  $sign = if ($direction -eq 'up' -or $direction -eq 'page-up') { 1 } else { -1 }
  $notches = if ($page) { 3 } else { 1 }
  $delta = [int]($sign * $notches * $amount * 120)
  $wparam = [IntPtr][int64]($delta * 65536)
  $rect = Get-WindowRectInfo $hwnd
  $client = Get-ClientPoint $rect ([int]($rect.x + $rect.width / 2)) ([int]($rect.y + $rect.height / 2))
  [void][DshRemoteWin32]::PostMessage($hwnd, 0x20A, $wparam, (Get-LParam $client.x $client.y))
  return (Get-ActionOutcome $hwnd 'scroll' 'posted' $null 'posted wheel message to the window')
}

function Invoke-OpKey($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  Post-KeyCombo $hwnd ([string]$request.keys)
  return (Get-ActionOutcome $hwnd 'key' 'posted' $null $null)
}

function Post-MouseMove($hwnd, $cx, $cy, $buttonDown) {
  # MK_LBUTTON = 0x0001 in wParam when the left button is held during the move.
  $wparam = if ($buttonDown) { [IntPtr]1 } else { [IntPtr]0 }
  [void][DshRemoteWin32]::PostMessage($hwnd, 0x200, $wparam, (Get-LParam $cx $cy))
}

function Invoke-OpMove($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  $windowRect = Get-WindowRectInfo $hwnd
  $windowElement = Get-UiaElement $hwnd

  function Resolve-MovePoint($elementId, $x, $y) {
    if ($null -ne $elementId -and $elementId -is [string] -and $elementId.Length -gt 0) {
      $element = Find-ElementByRuntimeId $windowElement ([string]$elementId)
      if ($null -eq $element) { throw "element '$elementId' not found in window $hwnd (re-run screen_read)" }
      $center = Get-ElementCenter $element
      return Get-ClientPoint $windowRect $center.x $center.y
    }
    return Get-ClientPoint $windowRect ([int]$x) ([int]$y)
  }

  $source = Resolve-MovePoint $request.elementId $request.x $request.y
  $drag = $request.drag
  if ($null -ne $drag) {
    $destination = Resolve-MovePoint $drag.toElementId $drag.toX $drag.toY
    # Posted-message drag only: WM_MOUSEMOVE to the source, WM_LBUTTONDOWN,
    # several interpolated WM_MOUSEMOVE steps with the button held, then
    # WM_LBUTTONUP at the destination. This works for controls that react to
    # simple mouse-move/button events (sliders, canvases, custom-drawn
    # controls) - it is NOT real OLE/shell drag-and-drop (e.g. dragging a
    # file between two Explorer windows), which requires actual
    # SendInput-driven drag detection that posted messages cannot trigger.
    Post-MouseMove $hwnd $source.x $source.y $false
    [void][DshRemoteWin32]::PostMessage($hwnd, 0x201, [IntPtr]1, (Get-LParam $source.x $source.y))  # WM_LBUTTONDOWN
    $steps = 10
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / $steps
      $ix = [int]($source.x + ($destination.x - $source.x) * $t)
      $iy = [int]($source.y + ($destination.y - $source.y) * $t)
      Post-MouseMove $hwnd $ix $iy $true
    }
    [void][DshRemoteWin32]::PostMessage($hwnd, 0x202, [IntPtr]0, (Get-LParam $destination.x $destination.y))  # WM_LBUTTONUP
    return (Get-ActionOutcome $hwnd 'move' 'posted' $null 'dragged via posted mouse messages (works only for controls that react to simple mouse events - not real OLE/shell drag-and-drop)')
  }
  Post-MouseMove $hwnd $source.x $source.y $false
  return (Get-ActionOutcome $hwnd 'move' 'posted' $null $null)
}

function Invoke-OpWindowControl($opArgs) {
  $request = $opArgs.request
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  $action = [string]$request.action
  switch ($action) {
    'minimize' { [void][DshRemoteWin32]::ShowWindow($hwnd, 6) }   # SW_MINIMIZE
    'maximize' { [void][DshRemoteWin32]::ShowWindow($hwnd, 3) }   # SW_MAXIMIZE
    'restore' { [void][DshRemoteWin32]::ShowWindow($hwnd, 9) }    # SW_RESTORE
    'move' {
      $rect = Get-WindowRectInfo $hwnd
      $x = if ($null -ne $request.x) { [int]$request.x } else { $rect.x }
      $y = if ($null -ne $request.y) { [int]$request.y } else { $rect.y }
      [void][DshRemoteWin32]::MoveWindow($hwnd, $x, $y, $rect.width, $rect.height, $true)
    }
    'resize' {
      $rect = Get-WindowRectInfo $hwnd
      $width = if ($null -ne $request.width) { [int]$request.width } else { $rect.width }
      $height = if ($null -ne $request.height) { [int]$request.height } else { $rect.height }
      [void][DshRemoteWin32]::MoveWindow($hwnd, $rect.x, $rect.y, $width, $height, $true)
    }
    'close' {
      [void][DshRemoteWin32]::PostMessage($hwnd, 0x10, [IntPtr]0, [IntPtr]0)  # WM_CLOSE
    }
    default { throw "unknown window_control action '$action'" }
  }
  return (Get-ActionOutcome $hwnd "window_control:$action" 'posted' $null $null)
}

function Get-ControlTypeName($element) {
  try {
    $name = [string]$element.Current.ControlType.ProgrammaticName
    if ($name -like 'ControlType.*') { return $name.Substring(12) }
    return $name
  } catch {
    return 'unknown'
  }
}

function Invoke-OpInvokePattern($opArgs) {
  $request = $opArgs.request
  $focusFallback = if ($null -ne $opArgs.focusFallback) { [bool]$opArgs.focusFallback } else { $false }
  $hwnd = Resolve-Window @{ windowId = $request.windowId }
  if ($focusFallback) { [void][DshRemoteWin32]::SetForegroundWindow($hwnd) }
  $windowElement = Get-UiaElement $hwnd
  $element = Find-ElementByRuntimeId $windowElement ([string]$request.elementId)
  if ($null -eq $element) { throw "element '$($request.elementId)' not found in window $hwnd (re-run screen_read)" }
  $pattern = [string]$request.pattern
  $controlType = Get-ControlTypeName $element
  $p = $null
  switch ($pattern) {
    'invoke' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'invoke' pattern (control type $controlType)"
      }
      $p.Invoke()
    }
    'toggle' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'toggle' pattern (control type $controlType)"
      }
      $p.Toggle()
    }
    'expand' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'expand' pattern (control type $controlType)"
      }
      $p.Expand()
    }
    'collapse' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'collapse' pattern (control type $controlType)"
      }
      $p.Collapse()
    }
    'select' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'select' pattern (control type $controlType)"
      }
      $p.Select()
    }
    'addToSelection' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'addToSelection' pattern (control type $controlType)"
      }
      $p.AddToSelection()
    }
    'removeFromSelection' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'removeFromSelection' pattern (control type $controlType)"
      }
      $p.RemoveFromSelection()
    }
    'scrollIntoView' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'scrollIntoView' pattern (control type $controlType)"
      }
      $p.ScrollIntoView()
    }
    'setValue' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'setValue' pattern (control type $controlType)"
      }
      if ($null -eq $request.value) { throw "pattern 'setValue' requires a string value" }
      $p.SetValue([string]$request.value)
    }
    'setRangeValue' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$p)) {
        throw "element does not support the 'setRangeValue' pattern (control type $controlType)"
      }
      if ($null -eq $request.value) { throw "pattern 'setRangeValue' requires a numeric value" }
      $p.SetValue([double]$request.value)
    }
    default { throw "unknown pattern '$pattern'" }
  }
  return (Get-ActionOutcome $hwnd "invoke:$pattern" 'uia' $null $null)
}

function Invoke-OpReadText($opArgs) {
  $hwnd = Resolve-Window @{ windowId = $opArgs.windowId }
  $maxLength = if ($null -ne $opArgs.maxLength) { [int]$opArgs.maxLength } else { 20000 }
  $windowElement = Get-UiaElement $hwnd
  $element = Find-ElementByRuntimeId $windowElement ([string]$opArgs.elementId)
  if ($null -eq $element) { throw "element '$($opArgs.elementId)' not found in window $hwnd (re-run screen_read)" }
  $textPattern = $null
  # TextPattern itself lives directly under System.Windows.Automation (like
  # every other pattern class in this file) - only its supporting range type
  # (TextPatternRange, returned by DocumentRange/GetSelection() below) lives
  # under the nested System.Windows.Automation.Text namespace.
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
    $controlType = Get-ControlTypeName $element
    throw "element does not support the Text pattern (control type $controlType) - use screen_read for its plain name/value instead"
  }
  $fullText = [string]$textPattern.DocumentRange.GetText(-1)
  $truncated = $false
  if ($fullText.Length -gt $maxLength) {
    $fullText = $fullText.Substring(0, $maxLength)
    $truncated = $true
  }
  $selectionText = ''
  try {
    $selectionRanges = $textPattern.GetSelection()
    $parts = @()
    foreach ($range in $selectionRanges) {
      $t = [string]$range.GetText(-1)
      if ($t.Length -gt 0) { $parts += $t }
    }
    $selectionText = ($parts -join '')
  } catch {
    $selectionText = ''
  }
  $result = @{ text = $fullText; truncated = $truncated }
  if ($selectionText.Length -gt 0) { $result.selectionText = $selectionText }
  return $result
}

function Invoke-OpReadTable($opArgs) {
  $hwnd = Resolve-Window @{ windowId = $opArgs.windowId }
  $maxCells = if ($null -ne $opArgs.maxCells) { [int]$opArgs.maxCells } else { 500 }
  $windowElement = Get-UiaElement $hwnd
  $element = Find-ElementByRuntimeId $windowElement ([string]$opArgs.elementId)
  if ($null -eq $element) { throw "element '$($opArgs.elementId)' not found in window $hwnd (re-run screen_read)" }

  $gridPattern = $null
  $hasGrid = $element.TryGetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern, [ref]$gridPattern)
  $tablePattern = $null
  $hasTable = $element.TryGetCurrentPattern([System.Windows.Automation.TablePattern]::Pattern, [ref]$tablePattern)
  if (-not $hasGrid -and -not $hasTable) {
    $controlType = Get-ControlTypeName $element
    throw "element supports neither the Grid nor the Table pattern (control type $controlType)"
  }

  $rowCount = 0
  $columnCount = 0
  if ($hasGrid) {
    $rowCount = [int]$gridPattern.Current.RowCount
    $columnCount = [int]$gridPattern.Current.ColumnCount
  } elseif ($hasTable) {
    $rowCount = [int]$tablePattern.Current.RowCount
    $columnCount = [int]$tablePattern.Current.ColumnCount
  }

  # Column headers are a TablePattern-only feature; a plain GridPattern
  # control (no TablePattern) simply has none to report - that's an omission,
  # not an error.
  $columnHeaders = $null
  if ($hasTable) {
    try {
      $headers = $tablePattern.GetColumnHeaders()
      if ($null -ne $headers -and $headers.Count -gt 0) {
        $names = @()
        foreach ($header in $headers) { $names += [string]$header.Current.Name }
        $columnHeaders = $names
      }
    } catch {
      $columnHeaders = $null
    }
  }

  $cells = @()
  $truncated = $false
  if ($hasGrid) {
    $total = $rowCount * $columnCount
    $limit = [Math]::Min($total, $maxCells)
    $count = 0
    for ($r = 0; $r -lt $rowCount -and $count -lt $limit; $r++) {
      $rowValues = @()
      for ($c = 0; $c -lt $columnCount -and $count -lt $limit; $c++) {
        $cellElement = $null
        try { $cellElement = $gridPattern.GetItem($r, $c) } catch { $cellElement = $null }
        $text = ''
        if ($null -ne $cellElement) {
          try { $text = [string]$cellElement.Current.Name } catch { $text = '' }
          $valuePattern = $null
          if ($cellElement.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            $valueText = [string]$valuePattern.Current.Value
            if ($valueText.Length -gt 0) { $text = $valueText }
          }
        }
        $rowValues += $text
        $count += 1
      }
      # Unary comma: appends the row as ONE array element, not each cell
      # flattened onto $cells - the same array-inside-array pitfall the
      # unary-comma idiom fixes elsewhere in this file, just one level deeper
      # (a 1-cell row would otherwise collapse the same way a 1-element
      # top-level array does).
      $cells += ,$rowValues
    }
    if ($total -gt $maxCells) { $truncated = $true }
  }

  $result = @{ rowCount = $rowCount; columnCount = $columnCount; truncated = $truncated; cells = $cells }
  if ($null -ne $columnHeaders) { $result.columnHeaders = $columnHeaders }
  return $result
}

function Invoke-OpClipboard($opArgs) {
  $action = [string]$opArgs.action
  if ($action -eq 'get') {
    # Get-Clipboard/Set-Clipboard (Microsoft.PowerShell.Management, built
    # into PS 5.1 on Windows) only see the *session's* clipboard - this must
    # run inside the interactive Scheduled-Task session like every other op,
    # never a plain non-interactive SSH exec.
    $text = $null
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { $text = $null }
    if ($null -eq $text) { $text = '' }
    return @{ action = 'get'; text = $text }
  } elseif ($action -eq 'set') {
    $text = [string]$opArgs.text
    Set-Clipboard -Value $text
    return @{ action = 'set'; text = $text }
  } else {
    throw "unknown clipboard action '$action'"
  }
}

function Invoke-OpProcess($opArgs) {
  $action = [string]$opArgs.action
  if ($action -eq 'list') {
    $result = @()
    foreach ($p in (Get-Process)) {
      $path = $null
      try { $path = $p.Path } catch { $path = $null }
      $title = $null
      try {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $title = $p.MainWindowTitle }
      } catch { $title = $null }
      $result += @{ pid = [int]$p.Id; name = [string]$p.ProcessName; executablePath = $path; mainWindowTitle = $title }
    }
    return @{ action = 'list'; processes = $result }
  } elseif ($action -eq 'kill') {
    $force = if ($null -ne $opArgs.force) { [bool]$opArgs.force } else { $false }
    $targets = @()
    if ($null -ne $opArgs.pid -and [int]$opArgs.pid -gt 0) {
      $targets = @(Get-Process -Id ([int]$opArgs.pid) -ErrorAction SilentlyContinue)
    } elseif ($null -ne $opArgs.name -and [string]$opArgs.name -ne '') {
      $targets = @(Get-Process -Name ([string]$opArgs.name) -ErrorAction SilentlyContinue)
    } else {
      throw 'process kill requires pid or name'
    }
    $killed = @()
    foreach ($t in $targets) {
      if ($null -eq $t) { continue }
      try {
        Stop-Process -Id $t.Id -Force:$force -ErrorAction Stop
        $killed += [int]$t.Id
      } catch {
        # Best-effort: a process that already exited (or can't be killed by
        # this account) is simply not reported as killed.
      }
    }
    return @{ action = 'kill'; killedPids = $killed }
  } else {
    throw "unknown process action '$action'"
  }
}

function Invoke-OpDisplays {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $result = @()
  for ($i = 0; $i -lt $screens.Count; $i++) {
    $s = $screens[$i]
    $b = $s.Bounds
    $result += @{ index = $i; rect = @{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }; primary = [bool]$s.Primary }
  }
  # Unary comma: keeps this an array on the pipeline even with exactly one
  # monitor (the common case on a single-display remote host) - see the
  # matching comment in Invoke-OpWindows for why a bare `return $result`
  # would otherwise collapse a 1-element array to a scalar hashtable, which
  # then serializes as a JSON object instead of a JSON array.
  return ,$result
}

function Invoke-OpNotify($opArgs) {
  $title = [string]$opArgs.title
  $message = [string]$opArgs.message
  $appId = [string]$opArgs.appId
  # The standard reflection-load technique for the WinRT toast APIs from
  # Windows PowerShell 5.1 (no third-party module). Using the well-known
  # built-in PowerShell AUMID as $appId (the caller's default) works on stock
  # Windows 10/11 with no app registration.
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $textNodes = $template.GetElementsByTagName('text')
  [void]$textNodes.Item(0).AppendChild($template.CreateTextNode($title))
  [void]$textNodes.Item(1).AppendChild($template.CreateTextNode($message))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
  return @{ shown = $true }
}

function Invoke-OpLaunch($opArgs) {
  $appName = [string]$opArgs.name
  $launchArgs = @()
  if ($null -ne $opArgs.args) {
    foreach ($item in @($opArgs.args)) { $launchArgs += [string]$item }
  }
  $target = $appName
  if ($appName -notmatch '[\\/]' -and $appName -notmatch '\.exe$') {
    $command = Get-Command $appName -ErrorAction SilentlyContinue
    if ($null -ne $command) { $target = $command.Source } else { throw "cannot resolve application '$appName' on the search path" }
  }
  # -ArgumentList binds an empty array as $null, which Start-Process rejects
  # outright - only pass it when there is at least one real argument.
  $startParams = @{ FilePath = $target; PassThru = $true }
  if ($launchArgs.Count -gt 0) { $startParams['ArgumentList'] = $launchArgs }
  $process = Start-Process @startParams

  # Some modern packaged apps (Windows 11's own Notepad/Calculator among
  # them) resolve to a launcher stub: Start-Process's pid exits almost
  # immediately once it hands off to the real, differently-pid'd process that
  # actually owns the window. Prefer a same-image process that has a window,
  # once one shows up, so later app_list/screen_read/click calls address a
  # process id that is still alive and actually has something to look at.
  $resolvedId = [int]$process.Id
  $imageName = [System.IO.Path]::GetFileNameWithoutExtension($target)
  for ($i = 0; $i -lt 40; $i++) {
    $stillRunning = Get-Process -Id $resolvedId -ErrorAction SilentlyContinue
    $ownsWindow = ($null -ne $stillRunning) -and ($stillRunning.MainWindowHandle -ne [IntPtr]::Zero)
    if ($ownsWindow) { break }
    $candidate = Get-Process -Name $imageName -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Select-Object -First 1
    if ($null -ne $candidate) { $resolvedId = [int]$candidate.Id; break }
    Start-Sleep -Milliseconds 150
  }

  $path = $null
  try {
    $path = (Get-Process -Id $resolvedId -ErrorAction Stop).Path
  } catch {
    $path = $null
  }
  return @{ processId = $resolvedId; executablePath = $path }
}

function Invoke-OpPowershell($opArgs) {
  $script = [string]$opArgs.script
  $timeoutMs = if ($null -ne $opArgs.timeoutMs) { [int]$opArgs.timeoutMs } else { 30000 }
  $maxOutputLength = if ($null -ne $opArgs.maxOutputLength) { [int]$opArgs.maxOutputLength } else { 20000 }

  # Written to its own temp file (not passed as a -Command argument) so
  # arbitrary script content - quotes, newlines, anything - never has to
  # survive a command-line-quoting round trip.
  $scriptPath = Join-Path $env:TEMP "dsh-ps-$([guid]::NewGuid().ToString('N')).ps1"
  [System.IO.File]::WriteAllText($scriptPath, $script, $Utf8NoBom)
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($timeoutMs)
    if (-not $completed) {
      try { $process.Kill($true) } catch { }
      throw "powershell script did not finish within ${timeoutMs}ms and was killed"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $truncated = $false
    if ($stdout.Length -gt $maxOutputLength) { $stdout = $stdout.Substring(0, $maxOutputLength); $truncated = $true }
    if ($stderr.Length -gt $maxOutputLength) { $stderr = $stderr.Substring(0, $maxOutputLength); $truncated = $true }
    return @{
      exitCode = [int]$process.ExitCode
      stdout = $stdout
      stderr = $stderr
      truncated = $truncated
    }
  } finally {
    Remove-Item -Path $scriptPath -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------
function Write-DshResponse($payload) {
  $json = $payload | ConvertTo-Json -Depth 24 -Compress
  [System.IO.File]::WriteAllText($ResponsePath, $json, $Utf8NoBom)
}

try {
  $raw = [System.IO.File]::ReadAllText($RequestPath, [System.Text.Encoding]::UTF8)
  $request = $raw | ConvertFrom-Json
  $opArgs = if ($null -ne $request.args) { $request.args } else { @{} }
  $result = $null
  switch ([string]$request.op) {
    'windows' { $result = Invoke-OpWindows }
    'apps' { $result = Invoke-OpApps }
    'snapshot' { $result = Invoke-OpSnapshot $opArgs }
    'shot' { $result = Invoke-OpShot $opArgs }
    'tree' { $result = Invoke-OpTree $opArgs }
    'click' { $result = Invoke-OpClick $opArgs }
    'type' { $result = Invoke-OpType $opArgs }
    'scroll' { $result = Invoke-OpScroll $opArgs }
    'key' { $result = Invoke-OpKey $opArgs }
    'move' { $result = Invoke-OpMove $opArgs }
    'windowControl' { $result = Invoke-OpWindowControl $opArgs }
    'invokePattern' { $result = Invoke-OpInvokePattern $opArgs }
    'readText' { $result = Invoke-OpReadText $opArgs }
    'readTable' { $result = Invoke-OpReadTable $opArgs }
    'launch' { $result = Invoke-OpLaunch $opArgs }
    'powershell' { $result = Invoke-OpPowershell $opArgs }
    'clipboard' { $result = Invoke-OpClipboard $opArgs }
    'process' { $result = Invoke-OpProcess $opArgs }
    'displays' { $result = Invoke-OpDisplays }
    'notify' { $result = Invoke-OpNotify $opArgs }
    default { throw "unknown op '$($request.op)'" }
  }
  Write-DshResponse @{ ok = $true; result = $result }
  exit 0
} catch {
  $message = $_.Exception.Message
  if ($null -eq $message -or $message.Length -eq 0) { $message = 'unknown helper failure' }
  Write-DshResponse @{ ok = $false; error = @{ code = 'HELPER_ERROR'; message = $message } }
  exit 0
}
