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
is what lets "connect to 10.0.0.12 as pakkapon" work with no credential in
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

| Tool | Read-only | Approval | Purpose |
|------|-----------|----------|---------|
| `screen_shot` | ✅ | — | Capture a window/screen as an image attachment (or text-only description with `imageMode: 'text'`) |
| `screen_read` | ✅ | — | UI Automation accessibility tree + pixel-location hints |
| `app_list` | ✅ | — | Enumerate running applications and their windows |
| `click` | | Yes | Click an element (by id) or a coordinate |
| `type` | | Yes | Type text into an editable element, with rollback on failure |
| `scroll` | | Yes | Scroll an element or the window |
| `key` | | Yes | Send a key combination (e.g. `Ctrl+S`) |
| `app_launch` | | Yes | Launch an application by name or path |

`screen_shot`/`screen_read`/`app_list`/`app_launch` each accept an optional
`ssh` argument (see **Supplying the SSH target** above) for deployments with
no configured default. `click`/`type`/`scroll`/`key` never take one — they
replay against whichever host their cited `basedOn` observation came from.

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

## Configuration

All fields live under one `Config` object (Schemastery-validated; invalid
values fail the profile load loudly, not at call time). See the fully
commented `cordis.patch.yml` for the complete list and defaults:
`ssh.*`, `requireApproval`, `autoApproveWindows`, `auditSessionEvents`,
`focusFallback`, `imageMode`, `connectTimeoutMs`, `helperTimeoutMs`,
`maxScreenshotSide`, `staleCheckTree`, `staleCheckPixels`, `maxObservationAgeMs`,
`maxCachedObservations`, `maxElements`, `maxTreeDepth`, `maxTextLength`,
`rollbackEnabled`.

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
