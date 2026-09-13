# dsh-windows-remote-ssh

Control a remote Windows desktop over SSH from **DeepSeek Harness**. Same
tool surface and safety model as the local `dsh-click` plugin — screenshots,
UI Automation reads, click/type/scroll/key, app listing/launch — but every
action runs on a Windows box reached over plain SSH instead of a local
subprocess. The harness itself can run from Linux, macOS, or Windows; only
the target needs to be Windows.

## How it works

- **No pre-installed agent on the target.** The only thing this plugin
  assumes on the remote host is a working SSH server (`Win32-OpenSSH`,
  built into modern Windows). Everything else — window enumeration, UI
  Automation, screenshots, input delivery — is done by a single PowerShell
  script this package ships (`native/win32/dsh-windows-remote-ssh-helper.ps1`),
  staged onto the target over SFTP the first time it's needed and re-staged
  automatically if it ever changes (content-hash compared against a marker
  file). It uses only classes already in stock Windows (.NET's
  `System.Windows.Automation`, `System.Drawing`, and `user32.dll`/`kernel32.dll`
  P/Invoke) — no Python, no third-party modules, no separate installer.
- **File-based request/response, not stdin/stdout.** Each call writes a small
  JSON request file over SFTP, runs the helper once, and reads a JSON
  response file back over SFTP. Moving bytes through SFTP rather than piping
  them through the SSH exec channel's stdin/stdout sidesteps Windows console
  code-page and UTF-8/UTF-16 encoding pitfalls entirely.
- **Runs in the user's real desktop session, not a hidden one.** This is the
  detail that makes GUI automation over plain SSH actually work: Win32-OpenSSH
  runs a normal `ssh user@host command` in a *non-interactive* Session 0 /
  window station, completely isolated from the interactive desktop — from
  there, `EnumWindows`, UI Automation, and screen capture all come back empty
  even though the process runs fine. So instead of executing the helper
  directly, this plugin schedules it as a one-shot Scheduled Task bound to
  the connected user with the "only when logged on" flag (attaching it to
  their interactive session), triggers it immediately, and polls for the
  response file — the standard workaround for driving a Windows GUI over SSH.
  See **Requirements** below for what this means for the target account.
  The scheduled process is launched through a tiny VBScript wrapper
  (`WScript.Shell.Run` with a hidden window style), not `powershell.exe
  -WindowStyle Hidden` directly — that flag alone still lets a console flash
  on screen for a moment before it takes effect. Verified empirically: zero
  window sightings across repeated calls while continuously polling for one.
- **Never steals the user's mouse/keyboard focus.** Actions prefer UI
  Automation invoke/value/scroll patterns; when an element exposes none, they
  fall back to *posted* window messages (`WM_LBUTTONDOWN`/`WM_KEYDOWN`/etc.)
  rather than moving the real cursor or bringing the window to the
  foreground. Bringing a window to the foreground is available only as an
  explicit, config-gated fallback (`focusFallback: 'allow'`, default off).

## Requirements

- The target account must be a **local administrator** and must already be
  **logged on interactively** (an unlocked console/RDP session) when a tool
  call runs — the Scheduled Task attaches to that existing session; it does
  not create one. If nobody is logged on, calls fail with a clear
  `SCHEDULE_FAILED` / timeout error rather than hanging.
- `Win32-OpenSSH` (`sshd`) running and reachable on the target.
- Node.js `^22.19.0 || >=24.0.0` wherever the harness itself runs.

## Installation

```bash
dsh plugin --profile web add "github:pureexe/dsh-windows-remote-ssh#main"
```

Then mount it with a profile patch (see `cordis.patch.yml` for every field,
or override at bundle level):

```yaml
- insert:
    - id: dsh-windows-remote-ssh
      config:
        ssh:
          host: <ip>
          user: <username>
          # Prefer a private key over a password where you can:
          # privateKeyPath: /path/to/id_ed25519
        autoApproveWindows: ['^Notepad']
```

Connection details may also come from environment variables instead of the
profile (handy for CI, and for keeping credentials out of a checked-in
patch): `SSH_HOST`, `SSH_PORT` (default `22`), `SSH_USER`, `SSH_PASSWORD`,
`SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE`. Explicit `config.ssh.*` fields win over
the matching env var when both are set.

## Supplying the SSH target: two options

There are two ways to tell this plugin which Windows machine to control, and
they can be mixed — a configured default, plus per-call overrides for the
odd exception.

**1. Configure `ssh.host`/`ssh.user`/`ssh.password` (or `ssh.privateKeyPath`)
once, as shown above — recommended.** The target and its credentials never
appear in the model's context and never get written to the harness's own
tool-call session logs. Every tool call just omits `ssh` entirely and uses
this default. This is the right choice for a fixed, known target (your own
desktop, a lab VM, a CI runner).

**2. Leave `config.ssh` unset and let the model supply a target per call.**
Every entry-point tool (`screen_shot`, `screen_read`, `app_list`,
`app_launch`) accepts an optional `ssh` argument — `host`, `port`, `user`,
and either `password` or `privateKeyPath` — that the model fills in from
whatever you tell it in chat ("connect to 10.0.0.12 as admin, password
hunter2"). No config edit needed, which is handy when the target varies
conversation to conversation or isn't known ahead of time. The tradeoff:
**that host/user/password is now part of the conversation** — it flows
through the model's context like any other tool argument and gets captured
by the harness's own tool-call logging, the same way any other tool call's
arguments are. If you can, prefer option 1, or at least a `privateKeyPath`
in chat instead of a raw `password`, so the secret itself lives on disk
rather than in the transcript.

If `host`/`user` are given (in chat, or in `config.ssh`) but neither
`password` nor `privateKeyPath` is, the plugin falls back to the default SSH
identity on the machine running the harness — `~/.ssh/id_ed25519`,
`id_ecdsa`, then `id_rsa`, the same lookup order the plain `ssh` CLI uses —
before failing with "requires either a password or a privateKeyPath". This
is what lets "connect to 10.0.0.12 as alice" work with no credential in
the call at all, as long as that machine's default key is already
authorized on the target.

`click`/`type`/`scroll`/`key` never need an `ssh` argument either way — they
replay against whatever host the `basedOn` observation they cite came from,
so a single conversation can safely juggle more than one remote machine
without an action ever landing on the wrong one.

With no `config.ssh` default and no per-call `ssh` argument, a call fails
immediately with a clear error asking for one or the other — it never
silently guesses or hangs.

## Tools

With `lazyToolLoading` on (the default), only `pc_control` is registered at startup; calling it once registers every other tool below for the rest of the conversation, so a session that never needs remote control never pays the prompt-token cost of the other ~20 schemas. Set `lazyToolLoading: false` to register everything immediately instead.

| Tool | Read-only | Approval | Purpose |
|------|-----------|----------|---------|
| `pc_control` | ✅ | — | Load the rest of this plugin's tools (only present when `lazyToolLoading` is on) |
| `screen_shot` | ✅ | — | Capture a window/screen (or a `region`/`display`) as an image attachment (or text-only description with `imageMode: 'text'`) |
| `screen_read` | ✅ | — | UI Automation accessibility tree + pixel-location hints |
| `app_list` | ✅ | — | Enumerate running applications and their windows (now includes `minimized`/`maximized`) |
| `display_list` | ✅ | — | Enumerate every monitor: index, rect, whether primary |
| `cursor_location` | ✅ | — | Current mouse cursor position, in the same screen coordinates as window rects |
| `wait_for` | ✅ | — | Poll (~500ms) until a condition is met or times out, then return a fresh observation |
| `clipboard` (get) | ✅ | — | Read the remote clipboard text |
| `process` (list) | ✅ | — | List running processes |
| `click` | | Yes | Click an element (by id) or a coordinate |
| `type` | | Yes | Type text into an editable element, with rollback on failure |
| `scroll` | | Yes | Scroll an element or the window |
| `key` | | Yes | Send a key combination (e.g. `Ctrl+S`) |
| `move` | | Yes | Move the mouse, or drag, via posted window messages only |
| `multi_action` | | Yes | Run a batch of click/type sub-actions (with optional list `selectionMode`) against one observation |
| `window_control` | | Yes | Minimize/maximize/restore/move/resize/close a window |
| `app_launch` | | Yes | Launch an application by name or path |
| `filesystem_pull` | | Yes | Download a file from the remote host (image → attachment unless `imageMode: 'text'`, small text → inline, else → file attachment) |
| `filesystem_push` | | Yes | Upload a file to the remote host, from literal content or a re-supplied attachment reference |
| `clipboard` (set) | | Yes | Replace the remote clipboard text |
| `process` (kill) | | Yes | Kill one or more processes by pid or name |
| `notify` | | Yes | Show a real Windows Action Center toast notification |
| `invoke` | | Yes | Call a UIA control pattern method directly on an element (Invoke/Toggle/ExpandCollapse/SelectionItem/ScrollItem/Value/RangeValue) |
| `read_text` | ✅ | — | Read an element's full content + current selection via the UIA Text pattern |
| `read_table` | ✅ | — | Read a grid/table element's structured cell data via the Grid/Table patterns |
| `powershell` | | Yes | Run an arbitrary script with full user privileges — off by default, see below |

### `screen_shot` — the image can be smaller than the real captured area

`click`/`move`/`key`/etc. all take real screen coordinates — the same space
as `window.rect` and `display_list` — never a raw pixel position read off
the screenshot image. The image itself can be downscaled from that real
size for two independent reasons: this plugin's own `maxSide` cap, and/or
the harness's attachment store shrinking it further on save. Whenever the
returned image is smaller than the real captured area, the tool result
carries a `scaleNote` stating the real size/origin and the exact
pixel-to-screen-coordinate conversion, so a caller that estimated a click
target visually can convert it correctly instead of clicking the wrong
spot. `cursor_location` is also useful here — it reports where the real
cursor actually is, in the same real screen coordinates, to sanity-check a
computed target or confirm where a previous action actually landed.

### `filesystem_pull` / `filesystem_push` — move files between the two machines

Download a file from the remote Windows host to inspect it here, and upload
it back after editing — useful for a config file, a script, or an image.

- `filesystem_pull(remotePath)` downloads the file and, depending on what it
  is: an **image** comes back as a real image attachment (the same
  mechanism `screen_shot` uses — actually visible, not just bytes); small
  **text** comes back inline as a plain string the model can read and
  reason about directly; anything else becomes a generic **file**
  attachment. Every case returns a reference (or the text itself) that
  `filesystem_push` can consume to write it straight back.
- `filesystem_push(remotePath, ...)` takes exactly one of: `content` (a
  literal string — the natural way to write back an edited text/config
  file), or `image`/`file` (an attachment reference re-supplied *exactly*
  as an earlier `filesystem_pull` returned it, to write those exact bytes
  back unchanged — e.g. after some other tool produced an edited version of
  a pulled image). Creates missing parent directories by default.
- Both are gated by **approval** like a mutating action — unlike
  `screen_shot`/`screen_read`, reading (or writing) an arbitrary path isn't
  treated as a free "observer": it can expose content the operator never
  put on screen.
- `maxFilesystemTransferBytes` (default 10 MB) caps one transfer in either
  direction; going over it refuses outright rather than truncating (which
  would just corrupt binary content). `maxInlineFilesystemBytes` (default
  100 KB) is the smaller threshold above which a *pulled* text file is
  stored as a file attachment instead of inlined, so a merely-large file
  doesn't bloat the model's context.

### `move` — mouse move and drag (posted messages only, honest limits)

`move` posts `WM_MOUSEMOVE` to reach a point inside an observed window and,
when `drag: { toX, toY }` (or `toElementId`) is given, also posts
`WM_LBUTTONDOWN` at the source, several interpolated `WM_MOUSEMOVE` steps
toward the destination, and `WM_LBUTTONUP` there — exactly like every other
action in this plugin, the real OS cursor never moves and no window is
brought to the foreground unless `focusFallback: 'allow'`.

**Be honest about what posted-message drag can and cannot do.** It reliably
works for controls that react to simple mouse-move/button events — sliders,
canvases, custom-drawn controls that track the mouse themselves. It is **not**
real OLE/shell drag-and-drop: dragging a file between two Explorer windows (or
anything else that relies on Windows' own drag-detection heuristics and
`IDropTarget`/`IDataObject` negotiation) generally will **not** work through
posted messages — that requires actual `SendInput`-driven physical mouse
events, which this plugin deliberately never generates. Use `move`/`drag` for
UI manipulation within a single control, not for cross-application drag
operations.

### `wait_for` — poll for a condition instead of guessing a fixed delay

`wait_for` polls the remote host roughly every 500ms until a condition is met
or `timeoutMs` elapses (default `waitForTimeoutMs`, bounded 500..120000),
entirely on the harness side (repeated `screen_read`-equivalent/`app_list`-equivalent
calls) — no new native helper operation was needed for this one. Three
condition kinds:

- `kind: 'element'` — `target` names a window (as `screen_shot`/`screen_read`
  do) and `match` (`name`/`automationId`/`controlType`, at least one,
  case-insensitive substring) names what to look for in its accessibility
  tree.
- `kind: 'window'` — `match.title` names a substring to look for across every
  top-level window's title.
- `kind: 'foreground'` — `target` names a window that must exist and be the
  current foreground window.

**A timeout is not an error.** The result always comes back as a normal tool
result carrying `met` (`false` on timeout), `timedOut`, and whatever was last
observed (`observationId`, `window`, `elements`, `pixels`) — the model needs
to see what is actually on screen when a wait times out, not just a generic
failure.

### `clipboard` — get/set the remote clipboard text

Backed by `Get-Clipboard`/`Set-Clipboard` (built into PowerShell 5.1 on
Windows, no extra module), run inside the same interactive Scheduled-Task
session as every other operation — the clipboard is per-session, so a plain
non-interactive SSH exec would see an entirely different, empty clipboard.
`action: 'get'` is read-only and never needs approval (like `app_list`);
`action: 'set'` is mutating and requires approval unless `requireApproval` is
off, gated the same way `powershell` is (no window subject — the clipboard
isn't scoped to any one window).

### `process` — list or kill remote processes

Backed by `Get-Process`/`Stop-Process`. `action: 'list'` returns pid, name,
executable path (when resolvable), and main window title (when any) for
every running process — read-only, never needs approval. `action: 'kill'`
takes `pid` or `name` (exactly one) plus optional `force`, and is gated by
approval like `powershell`/`clipboard` `set` (no window subject).

### `display_list` and multi-monitor / region `screen_shot`

`display_list` enumerates every monitor via
`[System.Windows.Forms.Screen]::AllScreens` — index, screen-space rect, and
whether it's the primary display. Read-only, never needs approval.

`screen_shot` gained two optional, backward-compatible parameters:
`display: N` (with `wholeScreen: true`) captures one specific monitor's
bounds instead of the primary screen, and `region: { left, top, right,
bottom }` captures exactly that screen-space rectangle regardless of
`target`/`wholeScreen`/`display`. Neither parameter changes anything about an
existing call that supplies neither — a plain `screen_shot()` or
`screen_shot({ wholeScreen: true })` behaves exactly as before. Like
`wholeScreen`, a `region`/`display` capture's `windowId` is the `0` sentinel
and cannot be used as a `basedOn` target for a later action.

### `notify` — a real Windows Action Center toast

`notify` shows an actual Windows 11 (and 10) Action Center toast
notification — not a legacy balloon-tip/`NotifyIcon` popup — via the WinRT
`Windows.UI.Notifications.ToastNotificationManager` APIs, loaded from
PowerShell 5.1 through the standard reflection-load technique
(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`).
It defaults to the well-known built-in Windows PowerShell AUMID
(`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`,
configurable via `notifyAppId`, overridable per call with `appId`) so it
works out of the box on stock Windows 10/11 with no app registration — the
standard community technique for toasting from PowerShell. Mutating: gated
by approval like `powershell` (no window subject).

### `multi_action` — a batch of click/type sub-actions, plus list selection

`multi_action` runs a sequence of click/type sub-actions against **one**
cited `basedOn` observation in a single tool call and a single approval ask
— rather than one `click`/`type` call (and one approval prompt) per step.
Each step reuses the exact same `click`/`type` addressing and re-verification
`click`/`type` already do on their own (an `elementId` step re-resolves that
exact element by UIA RuntimeId right before acting; a coordinate step does
not). By default the batch stops at the first failing step; `continueOnError:
true` runs every step regardless and returns one outcome (or error) per step.

For list/grid multi-selection, a click-kind step may set `selectionMode`
(`'select'`/`'add'`/`'remove'`/`'toggle'`): when the addressed element
supports UIA's `SelectionItem` pattern, this invokes `Select()` /
`AddToSelection()` / `RemoveFromSelection()` directly instead of posting a
click — more reliable than synthesizing modifier-key-held clicks, and it
never needs to hold a real modifier key down. Falls back to a plain posted
click when the element doesn't support the pattern.

### `window_control` — minimize/maximize/restore/move/resize/close

`window_control` changes one observed window's state via `ShowWindow`
(minimize/maximize/restore) and `MoveWindow` (move/resize) Win32 calls, or
posts `WM_CLOSE` (close). Requires `basedOn` and approval, exactly like
`click`/`scroll`/`key` (participates in `autoApproveWindows`). Since a
successful `move`/`resize`/`minimize`/`maximize` changes the window's own
rect/state, a subsequent action against the same window needs a fresh
`screen_shot`/`screen_read` first — the same freshness rule that already
applies everywhere else. `app_list`'s window entries (and the underlying
`WindowInfo` shape) now also carry `minimized`/`maximized` booleans
(`IsIconic`/`IsZoomed`), at no extra cost.

### `invoke` — direct UIA pattern-based control interaction

Instead of posting a synthetic click or keystroke, `invoke` calls the target
element's own UI Automation pattern method directly — more reliable for a
control that reacts to its real pattern method but ignores posted input.
Always addressed by `elementId` (never coordinates: this tool always targets
a specific element). `pattern` is one of:

- `'invoke'` — `InvokePattern.Invoke()`
- `'toggle'` — `TogglePattern.Toggle()`
- `'expand'` / `'collapse'` — `ExpandCollapsePattern.Expand()`/`.Collapse()`
- `'select'` / `'addToSelection'` / `'removeFromSelection'` —
  `SelectionItemPattern.Select()`/`.AddToSelection()`/`.RemoveFromSelection()`
- `'scrollIntoView'` — `ScrollItemPattern.ScrollIntoView()`
- `'setValue'` — `ValuePattern.SetValue(string)`, requires a string `value`
- `'setRangeValue'` — `RangeValuePattern.SetValue(double)`, requires a
  numeric `value`

If the addressed element doesn't support the requested pattern, `invoke`
fails with a clear error naming the pattern and the element's control type —
it never silently no-ops. Like elementId-addressed `click`/`type`, the
helper re-resolves the element by its UIA RuntimeId immediately before
acting, so the whole-window tree hash adds no safety here. Mutating: gated
by approval like `click`/`type`.

### `read_text` / `read_table` — structured content via the Text/Grid/Table patterns

Two read-only tools that expose UI Automation content richer than the plain
`Name`/`Value` `screen_read` already returns:

- `read_text(basedOn, elementId)` reads one text/document/edit element's full
  content via `TextPattern.DocumentRange.GetText(-1)`, plus its current
  selection's text (if any) via `TextPattern.GetSelection()`. The returned
  text is truncated at `maxReadTextLength` (default 20000, distinct from the
  much shorter `maxTextLength`, which is for short sanitized labels like
  titles — not document bodies), with `truncated` reporting whether that
  happened. Fails with a clear error naming the control type if the element
  doesn't support the Text pattern (it never silently falls back to the
  plain `Name`/`Value` already available via `screen_read`).
- `read_table(basedOn, elementId)` reads one grid/list/table element's
  structured cell data via `GridPattern`/`GridPattern.GetItem(row, col)`:
  `rowCount`/`columnCount`, and cell text (preferring each cell's
  `ValuePattern.Value`, falling back to its `Name`). Column headers come from
  `TablePattern.GetColumnHeaders()` when the element also supports
  `TablePattern` — omitted (not an error) when it supports only
  `GridPattern`. Cells are capped at `maxTableCells` (default 500, max 5000
  — a *total*-cell cap, not per-dimension); `rowCount`/`columnCount` are
  always reported truthfully even when `cells` was capped short of them, and
  `truncated: true` marks that. Fails with a clear error naming the control
  type if the element supports neither pattern.

Both are pure observers: read-only, never gated by approval — the same
policy tier as `screen_read`/`app_list`. They still cite a `basedOn`
observation and confirm the window's identity hasn't changed underneath it
before reading, the same freshness reasoning every `basedOn`-taking tool
applies, just without an approval ask.

### `powershell` — the escape hatch (off by default)

`powershell` runs any script on the remote host with the full privileges of
the connected user: not scoped to a window or element, not sandboxed beyond
what that account can already do. It exists for whatever the structured
tools above can't reach (reading/writing files, querying system state,
managing services, registry access, ...). It's categorically more powerful
than every other tool this plugin registers, so:

- It's **disabled by default**. Turn it on deliberately:
  ```yaml
  config:
    enablePowerShellTool: true
  ```
- It's still gated by **approval** on the same terms as every other
  mutating action (`requireApproval` / `autoApproveWindows`) — enabling it
  does not bypass that.
- It does **not** participate in the freshness/staleness machinery
  (`basedOn`, `staleCheckTree`, etc.) at all — there's no window to be stale
  about.
- Output is capped at `maxPowerShellOutputLength` (default 20000 characters
  each for stdout/stderr, independently truncated) and redacted the same
  way every other model-visible string is (credential-shaped text stripped
  before it reaches the model or a log).
- `powerShellTimeoutMs` (default 30000, independent of `helperTimeoutMs`)
  bounds one call; the remote process is killed if it runs longer.

Think carefully before turning this on for any deployment where the model
isn't fully trusted with the target machine — it is, by design, equivalent
to giving the model a terminal.

`screen_shot`/`screen_read`/`app_list`/`app_launch`/`filesystem_pull`/`filesystem_push`/`display_list`/`wait_for`/`clipboard`/`process`/`notify`/`powershell`
each accept an optional `ssh` argument (see **Supplying the SSH target**
above) for deployments with no configured default.
`click`/`type`/`scroll`/`key`/`move`/`multi_action`/`window_control`/`invoke`/
`read_text`/`read_table` never take one — they replay against whichever host
their cited `basedOn` observation came from.

Every mutating action (`click`/`type`/`scroll`/`key`/`app_launch`) must cite
a `basedOn` observation returned by `screen_shot`/`screen_read`. Before
acting, the plugin re-observes the window over SSH and refuses if the window
identity, (when `staleCheckTree` is on) its accessibility tree, or (when
`staleCheckPixels` is on) its pixels changed since that observation — so the
model can't act on a screen it no longer has an accurate picture of. It also
captures the target process's identity before and after the action and
refuses if it changed mid-flight.

`staleCheckTree` (default `true`) compares the *whole* window's tree, not
just the element being addressed. It's automatically skipped for `type` and
for `click`/`scroll` when addressed by `elementId` — those already
re-resolve that exact element by its UIA RuntimeId immediately before
acting and fail loudly if it's gone, so the coarser whole-tree hash adds no
real safety there and only false-positives on unrelated live content
elsewhere in the window (a clock, a status indicator, a "page loading"
spinner, autocomplete, scrollbar position). It still applies to
coordinate-based `click`s and to `key` (neither has anything else
re-verifying the target), and to those you can set `staleCheckTree: false`
deployment-wide if a target window's content drifts too fast even for that.
Identity and the observation-age check always apply regardless.

`staleCheckPixels` (default `true`) has the same trade-off for a window whose
pixels never stop changing on their own — a live 3D viewport, a video player,
a game — where no amount of re-observing right before acting ever produces a
matching hash, so it permanently refuses every coordinate-based `click`/`key`
against that window. Rather than disabling the check everywhere, allowlist
that one window by title/exe regex in `staleCheckPixelsExemptWindows`
(default `[]`); identity (and the tree check, unless also disabled) still
apply to it.

## Configuration

All fields live under one `Config` object (Schemastery-validated; invalid
values fail the profile load loudly, not at call time). See the fully
commented `cordis.patch.yml` for the complete list and defaults:
`ssh.*`, `lazyToolLoading`, `requireApproval`, `autoApproveWindows`, `auditSessionEvents`,
`focusFallback`, `imageMode`, `connectTimeoutMs`, `helperTimeoutMs`,
`maxScreenshotSide`, `staleCheckTree`, `staleCheckPixels`, `staleCheckPixelsExemptWindows`, `maxObservationAgeMs`,
`maxCachedObservations`, `maxElements`, `maxTreeDepth`, `maxTextLength`,
`rollbackEnabled`, `enablePowerShellTool`, `powerShellTimeoutMs`,
`maxPowerShellOutputLength`, `maxFilesystemTransferBytes`,
`maxInlineFilesystemBytes`, `waitForTimeoutMs`, `notifyAppId`,
`maxMultiActionSteps`, `maxReadTextLength`, `maxTableCells`.

## Development

```bash
npm install
npm run typecheck
npm run build          # tsdown -> lib/
npm run test:unit      # pure logic, no network
npm run test:e2e       # live, against a real remote Windows host - see below
```

### Running the live integration suite

```bash
SSH_HOST=<ip> SSH_USER=<username> SSH_PASSWORD=<password> \
  npm run test:e2e
```

The suite is skipped (not failed) when `SSH_HOST`/`SSH_USER` and a
credential aren't set. It exercises the SSH + PowerShell-helper path
directly against a real target:

1. Establishes the SSH connection and enumerates windows.
2. Lists running applications and launches `notepad.exe`.
3. Reads the UI Automation element tree of the new Notepad window.
4. Types text into Notepad's edit control.
5. Captures a screenshot of the window.
6. Connects with no configured default at all, passing `host`/`user`/
   `password` directly to `resolveSshTarget` — the same path a model-supplied
   per-call `ssh` argument takes.
7. Pushes a small WinForms test-fixture script (a Button, a CheckBox, a
   multiline TextBox with known text/selection, and a two-column
   three-row `ListView`) and launches it via `powershell -File`, then
   exercises `invoke` (`toggle`/`invoke`/`setValue`), `read_text`
   (known content + selection), and `read_table` (row/column counts,
   headers, cell values) against it — plus one negative case per tool
   (an element that doesn't support the requested pattern) — before
   killing the fixture process and deleting the pushed script.

It cleans up the Notepad process it launches in `afterAll`.

## Design notes / why not paramiko or asyncssh

The reference plugin format for DeepSeek Harness (see `dsh-click`) is a
TypeScript module running inside the harness's own Node/`cordis` process —
there is no Python runtime in that picture to host `paramiko`/`asyncssh`.
This plugin uses [`ssh2`](https://github.com/mscdex/ssh2), the equivalent
mature, widely-used SSH2 client for Node: persistent connections, exec
channels, and SFTP, all from the same process the rest of the plugin runs in.

## Safety boundaries

1. **Freshness** — every action cites a `basedOn` observation; identity,
   tree, and (optionally) pixel-hash comparison refuse a stale action.
2. **Approval** — mutating actions request approval through
   `@deepseek-ai/dsh-user-approval` by default; `autoApproveWindows` regexes
   skip the ask for matched windows but remain freshness-checked and audited.
   Careful with the harness's own session-wide approval **policy** (`ask` /
   `never`) — `never` does not mean "never ask, always allow"; per
   `dsh-user-approval`'s own docs it means "never prompt anyone: every ask
   resolves `rejected` deterministically," the CI/unattended lockdown stance.
   Setting it expecting frictionless automation will instead **deny every
   action** with `action denied by approval: rejected by the approval
   answerer`. If you don't want per-action prompts, use *this plugin's own*
   `requireApproval: false` (or a scoped `autoApproveWindows` entry) instead
   of the harness-wide policy switch.
3. **Process identity** — PID and executable path are verified immediately
   before and after every action.
4. **Audit** — every observation and action is logged as
   `dsh-windows-remote-ssh/observed` / `dsh-windows-remote-ssh/action`
   session events (sanitized: credential-shaped text is redacted before it
   ever reaches a log or the model).

## License

MIT
