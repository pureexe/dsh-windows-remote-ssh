' dsh-windows-remote-ssh: runs one .cmd file with a fully hidden window.
'
' powershell.exe's own "-WindowStyle Hidden" flag is not reliable - the
' console host window is created before PowerShell gets a chance to act on
' that flag, so it can still flash on screen for a moment. WScript.Shell.Run
' with window style 0 (SW_HIDE) does not have that race: it is the standard,
' long-established fix for launching a console command with zero visible
' window, ever - which matters here because the whole point of running the
' helper through a Scheduled Task (see src/platform/runner.ts) is to reach
' the user's real interactive desktop without disturbing what they see on it.
'
' Usage: wscript.exe //B run-hidden.vbs "<path-to-a-.cmd-file>"
Set objShell = CreateObject("WScript.Shell")
objShell.Run Chr(34) & WScript.Arguments(0) & Chr(34), 0, True
