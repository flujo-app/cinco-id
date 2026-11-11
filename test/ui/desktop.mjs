// Looks at the real Windows desktop for the checks in test/ui.
//
// Windows switches a window off for mouse clicks while a dialog that belongs to it is open. A
// check that leaves such a window behind would leave the person at the PC with a program they
// cannot click. `leftSwitchedOff` compares with a list taken before the check, switches any such
// window back on, and reports it so the check fails.
import { execFileSync } from 'node:child_process';

const NATIVE = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Wins {
  public delegate bool Proc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnableWindow(IntPtr h, bool on);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Name(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  // Visible top-level windows as "handle|program|enabled|class|title|ownerHandle|ownerProgram"
  public static List<string> All() {
    var rows = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, 64);
      var title = new StringBuilder(128); GetWindowText(h, title, 128);
      IntPtr owner = GetWindow(h, 4);
      rows.Add(h.ToInt64() + "|" + Name(h) + "|" + (IsWindowEnabled(h) ? "1" : "0") + "|" + cls + "|" + title.ToString().Replace("|", " ") + "|" + owner.ToInt64() + "|" + (owner == IntPtr.Zero ? "" : Name(owner)));
      return true; }, IntPtr.Zero);
    return rows; }
  public static void Close(long h) { PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static bool SwitchOn(long h) { var p = new IntPtr(h); if (!IsWindow(p)) return false; EnableWindow(p, true); return IsWindowEnabled(p); }
}
"@
`;

export function native(call) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${NATIVE}\n${call}`], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean);
}

/** All visible top-level windows on the desktop. */
export function windows() {
  if (process.platform !== 'win32') return [];
  return native('[Wins]::All() -join [char]10').map(line => {
    const [handle, program, enabled, className, title, owner, ownerProgram] = line.split('|');
    return { handle, program, enabled: enabled === '1', className, title, owner, ownerProgram };
  });
}

/** Native Windows dialogs (class #32770) that belong to the given programs. */
export function dialogsOf(list, programs) {
  return list.filter(window => window.className === '#32770' && programs.has(window.program));
}

export function closeWindow(handle) { native(`[Wins]::Close(${handle})`); }

/**
 * Windows that were clickable before and are switched off now. Each one is switched back on;
 * the returned list says what happened, so the check can fail and report it.
 */
export function leftSwitchedOff(before) {
  if (process.platform !== 'win32') return [];
  const wasEnabled = new Map(before.filter(window => window.enabled).map(window => [window.handle, window]));
  const problems = [];
  for (const window of windows()) {
    if (!window.enabled && wasEnabled.has(window.handle)) {
      const fixed = native(`[Wins]::SwitchOn(${window.handle})`).at(-1) === 'True';
      problems.push(`The window "${window.title}" of ${window.program} was left switched off for clicks${fixed ? ' (switched back on)' : ' and could NOT be switched back on'}.`);
    }
  }
  return problems;
}
