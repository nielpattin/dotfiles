# pwsh-interactive

A [pi](https://github.com/badlogic/pi-mono) extension that gives the agent access to a real, interactive PowerShell window running alongside the chat.

## Why

By default, pi runs shell commands in hidden subprocesses — the output is captured and returned to the agent, but the user never sees a live terminal. This extension spawns an actual `pwsh` (PowerShell 7) window that stays visible and open for the entire session. The agent can send commands into it, and the user can watch (or even interact with) the shell directly.

## How it works

1. **Shell lifecycle** — When the agent calls `pwsh_shell` with `action: "open"`, a new PowerShell window is spawned via `Start-Process -PassThru`. A launcher script starts a `Start-Transcript` log and writes the window's HWND to a temp file so the extension can track and focus it.
2. **Command injection** — `action: "send"` uses `WScript.Shell.SendKeys` to inject text into the focused window exactly as if the user typed it. The command appears in the terminal, runs live, and is captured in the transcript log.
3. **Transcript replay** — Before every agent turn, the extension reads the delta from the transcript log (stripping PowerShell boilerplate) and injects it as a `pwsh-transcript` message so the agent always knows what happened in the shell without the user having to copy/paste anything.
4. **Status indicator** — The current state is always visible in the pi footer: `pwsh [off]` / `pwsh ○` (enabled, no shell) / `pwsh ●` (shell running).

## User commands

| Command | Description |
|---|---|
| `/pwsh-toggle` | Enable or disable interactive mode (off by default) |
| `/pwsh` | Bring the PowerShell window to the foreground |

## Agent tool

When interactive mode is on, the agent gains the `pwsh_shell` tool:

| Action | Description |
|---|---|
| `open` | Launch a new shell window, optionally running an initial command |
| `send` | Inject a command into the already-open shell |
| `snapshot` | Capture currently visible terminal text (including many full-screen TUIs) |
| `close` | Close the shell and capture the final transcript |

`open` loads the PowerShell profile by default. Pass `loadProfile: false` for raw `-NoProfile` behavior.

`snapshot` uses Win32 console APIs (`AttachConsole` + `ReadConsoleOutputCharacterW`) to read the current viewport text from the target shell process.

## Requirements

- Windows
- PowerShell 7 (`pwsh`) on `PATH`
