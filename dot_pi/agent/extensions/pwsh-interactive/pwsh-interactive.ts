/**
 * pwsh-interactive — Interactive PowerShell window for pi
 *
 * Gives the LLM a `pwsh_shell` tool to open / send commands to a real
 * PowerShell window (conhost). The window stays open between tool calls;
 * its transcript is injected before every agent turn so the agent can see
 * what happened without the user having to copy/paste anything.
 *
 * User commands:
 *   /pwsh-toggle   — enable or disable interactive mode
 *   /pwsh          — bring the shell window to the foreground
 *
 * All mechanics were verified in test scripts before writing this extension.
 * Key proven patterns:
 *   - HWND: child shell writes GetConsoleWindow() to a temp file; parent polls for it
 *   - Spawn: Start-Process pwsh -PassThru via spawnSync to get PID
 *   - IsAlive: Get-Process -Id <pid> via spawnSync (process.kill(0) unreliable on Windows)
 *   - SendKeys: WScript.Shell.SendKeys after SetForegroundWindow + 500ms delay
 *   - Focus: SetForegroundWindow + ShowWindow(SW_RESTORE) via inline pwsh
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─────────────────────────── module-level state ───────────────────────────────

const instanceId = randomBytes(3).toString("hex");

let interactiveEnabled = false;

interface ShellState {
  pid: number;
  hwnd: bigint;
  logFile: string;
  launcherFile: string;
  hwndFile: string;
  lastReadPos: number;
}

let shellState: ShellState | null = null;

// ─────────────────────────── helpers: file paths ──────────────────────────────

function makePaths(): { logFile: string; hwndFile: string; launcherFile: string } {
  const base = join(tmpdir(), `pi-pwsh-${instanceId}-${Date.now()}`);
  return {
    logFile: `${base}.log`,
    hwndFile: `${base}-hwnd.txt`,
    launcherFile: `${base}-launch.ps1`,
  };
}

// ─────────────────────────── helper: write launcher ───────────────────────────

/**
 * Writes the .ps1 launcher script. The script:
 *  1. Forces UTF-8
 *  2. Starts a transcript to logFile
 *  3. Writes its own console HWND to hwndFile (handshake)
 *  4. Optionally runs an initial command
 * The process is started with -NoExit so it stays open.
 */
function writeLauncher(logFile: string, hwndFile: string, launcherFile: string, initialCommand?: string): void {
  const hwndSnippet = [
    `Add-Type @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class PiCW { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }`,
    `'@`,
    `[PiCW]::GetConsoleWindow().ToInt64() | Set-Content '${hwndFile}'`,
  ].join("\n");

  const lines = [
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `Start-Transcript -Path '${logFile}' -Force | Out-Null`,
    hwndSnippet,
    ...(initialCommand ? [`# Initial command from pi:`, initialCommand] : []),
  ];

  writeFileSync(launcherFile, lines.join("\n"), "utf8");
}

// ─────────────────────────── helper: spawn shell ──────────────────────────────

/**
 * Spawns a new pwsh window via Start-Process -PassThru (proven pattern from tests).
 * Polls for the HWND file written by the launcher script (up to 8s).
 * Returns the populated ShellState or throws on timeout.
 */
async function openShell(initialCommand?: string, loadProfile = true): Promise<ShellState> {
  const { logFile, hwndFile, launcherFile } = makePaths();
  writeLauncher(logFile, hwndFile, launcherFile, initialCommand);

  // Use Start-Process -PassThru to get PID — proven to work on Windows
  const childArgs = loadProfile
    ? `'-NoExit','-File','${launcherFile}'`
    : `'-NoExit','-NoProfile','-File','${launcherFile}'`;

  const spawnResult = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `(Start-Process pwsh -ArgumentList ${childArgs} -PassThru).Id`,
    ],
    { encoding: "utf8" }
  );

  const pid = parseInt(spawnResult.stdout.trim(), 10);
  if (!pid || isNaN(pid)) {
    throw new Error(`Failed to spawn shell. stderr: ${spawnResult.stderr?.trim()}`);
  }

  // Poll for HWND file written by the child (up to 8s)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(hwndFile)) break;
    await sleep(300);
  }

  if (!existsSync(hwndFile)) {
    throw new Error("Shell opened but HWND handshake timed out after 8s.");
  }

  const hwnd = BigInt(readFileSync(hwndFile, "utf8").trim());

  return { pid, hwnd, logFile, launcherFile, hwndFile, lastReadPos: 0 };
}

// ─────────────────────────── helper: is shell alive ──────────────────────────

/**
 * Checks if the shell process is still running.
 * Uses Get-Process via spawnSync — process.kill(pid, 0) is unreliable on Windows.
 */
function isShellAlive(): boolean {
  if (!shellState) return false;
  const r = spawnSync(
    "pwsh",
    ["-NoProfile", "-Command", `(Get-Process -Id ${shellState.pid} -ErrorAction SilentlyContinue) -ne $null`],
    { encoding: "utf8" }
  );
  return r.stdout.trim() === "True";
}

// ─────────────────────────── helper: focus window ────────────────────────────

/**
 * Brings the shell window to the foreground.
 * Uses SetForegroundWindow + ShowWindow(SW_RESTORE=9) via inline pwsh.
 */
function focusShellWindow(): void {
  if (!shellState || shellState.hwnd === BigInt(0)) return;
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class PiFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
[PiFocus]::ShowWindow([IntPtr]${shellState.hwnd}, 9) | Out-Null
[PiFocus]::SetForegroundWindow([IntPtr]${shellState.hwnd}) | Out-Null
`.trim();
  spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}

// ─────────────────────────── helper: send command ────────────────────────────

/**
 * Injects a command into the running shell as if the user typed it.
 * Focus the window first (proven: needs 500ms delay before SendKeys).
 * The command appears in the terminal, runs, and is captured in the transcript.
 */
async function sendCommandToShell(command: string): Promise<void> {
  focusShellWindow();
  await sleep(500); // required — window must be fully focused before SendKeys

  // Escape single quotes in the command for WScript.Shell.SendKeys
  // Special SendKeys chars: +^%~{}[]() — escape them with braces
  const escaped = command
    .replace(/\{/g, "{{}}")
    .replace(/\}/g, "{}}")
    .replace(/\[/g, "{[}")
    .replace(/\]/g, "{]}")
    .replace(/\(/g, "{(}")
    .replace(/\)/g, "{)}")
    .replace(/\+/g, "{+}")
    .replace(/\^/g, "{^}")
    .replace(/~/g, "{~}")
    .replace(/'/g, "''"); // PS single-quote escape

  const script = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${escaped}{ENTER}')
`.trim();

  spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}

// ─────────────────────────── helper: snapshot text ────────────────────────────

/**
 * Capture currently visible text from the shell's console viewport using Win32 console APIs
 * (AttachConsole + ReadConsoleOutputCharacterW).
 */
function captureVisibleShellText(shellPid: number): string {
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = ${shellPid}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PiConsole {
  [StructLayout(LayoutKind.Sequential)]
  public struct COORD { public short X; public short Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct CONSOLE_SCREEN_BUFFER_INFO {
    public COORD dwSize;
    public COORD dwCursorPosition;
    public ushort wAttributes;
    public SMALL_RECT srWindow;
    public COORD dwMaximumWindowSize;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AttachConsole(uint dwProcessId);

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ReadConsoleOutputCharacterW(
    IntPtr hConsoleOutput,
    StringBuilder lpCharacter,
    uint nLength,
    COORD dwReadCoord,
    out uint lpNumberOfCharsRead
  );
}
'@

[PiConsole]::FreeConsole() | Out-Null

if (-not [PiConsole]::AttachConsole([uint32]$targetPid)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "AttachConsole failed (Win32=$code)"
}

$hOut = [PiConsole]::CreateFileW('CONOUT$', [uint32]2147483648, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
if ($hOut -eq [IntPtr]::Zero -or $hOut -eq [IntPtr]::new(-1)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "CreateFile(CONOUT$) failed (Win32=$code)"
}

try {
  $info = New-Object PiConsole+CONSOLE_SCREEN_BUFFER_INFO
  if (-not [PiConsole]::GetConsoleScreenBufferInfo($hOut, [ref]$info)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "GetConsoleScreenBufferInfo failed (Win32=$code)"
  }

  $left = [int]$info.srWindow.Left
  $right = [int]$info.srWindow.Right
  $top = [int]$info.srWindow.Top
  $bottom = [int]$info.srWindow.Bottom
  $width = $right - $left + 1

  $lines = New-Object System.Collections.Generic.List[string]

  for ($y = $top; $y -le $bottom; $y++) {
    $coord = New-Object PiConsole+COORD
    $coord.X = [int16]$left
    $coord.Y = [int16]$y

    $sb = New-Object System.Text.StringBuilder $width
    [uint32]$charsRead = 0

    if (-not [PiConsole]::ReadConsoleOutputCharacterW($hOut, $sb, [uint32]$width, $coord, [ref]$charsRead)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "ReadConsoleOutputCharacterW failed on row $y (Win32=$code)"
    }

    $line = $sb.ToString()
    if ($line.Length -gt [int]$charsRead) {
      $line = $line.Substring(0, [int]$charsRead)
    }

    # Compact for chat readability: remove nulls, collapse wide spacing/art, trim.
    $line = $line.Replace([string][char]0, "")
    $line = [regex]::Replace($line, '\\s{2,}', ' ')
    $line = [regex]::Replace($line, '[─━│▏▎▍▌▋▊▉█]{7,}', '───…')
    $line = $line.Trim()

    if ($line.Length -gt 220) {
      $line = $line.Substring(0, 220) + "…"
    }

    if ($line.Length -gt 0) {
      $lines.Add($line)
    }
  }

  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Write(($lines -join [Environment]::NewLine))
}
finally {
  [PiConsole]::CloseHandle($hOut) | Out-Null
  [PiConsole]::FreeConsole() | Out-Null
}
`.trim();

  const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to capture shell text: ${result.stderr?.trim() || result.stdout?.trim() || "unknown error"}`);
  }

  return result.stdout ?? "";
}

function stripTerminalControlSequences(text: string): string {
  return text
    // OSC: ESC ] ... (BEL | ESC \\)
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    // DCS/PM/APC blocks: ESC P|^|_ ... ESC \
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "")
    // CSI: ESC [ ... command
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    // Remaining single-char ESC sequences
    .replace(/\x1B[@-_]/g, "")
    // Other control chars (keep \n, \r, \t)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g, "");
}

function normalizeConsoleText(raw: string): string {
  return stripTerminalControlSequences(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function clipLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  if (maxLines === 1) return [`… (${lines.length} lines) …`];

  const headCount = Math.max(1, maxLines - 3);
  const tailCount = Math.max(0, Math.min(2, maxLines - headCount - 1));
  const omitted = Math.max(1, lines.length - headCount - tailCount);

  return [...lines.slice(0, headCount), `… (${omitted} more lines) …`, ...lines.slice(lines.length - tailCount)];
}

/** Full snapshot payload for model context (not rendered directly to TUI). */
function formatSnapshotForContext(raw: string, maxLines = 140, maxLineLength = 240): string {
  const cleaned = normalizeConsoleText(raw)
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line));

  return clipLines(cleaned, maxLines).join("\n");
}

// ─────────────────────────── helper: transcript ───────────────────────────────

/** Reads new content from the transcript log since last read. Updates lastReadPos. */
function readTranscriptDelta(): string {
  if (!shellState || !existsSync(shellState.logFile)) return "";
  try {
    const full = readFileSync(shellState.logFile, "utf8");
    const delta = full.slice(shellState.lastReadPos);
    shellState.lastReadPos = full.length;
    return delta;
  } catch {
    return "";
  }
}

/**
 * Strips PowerShell Start-Transcript boilerplate lines.
 * Removes the header block (****..., metadata lines) and footer.
 */
function stripBoilerplate(raw: string): string {
  const boilerplatePatterns = [
    /^\*{10,}/,
    /^PowerShell transcript/i,
    /^Start time:/i,
    /^End time:/i,
    /^Username:/i,
    /^RunAs user:/i,
    /^Configuration name:/i,
    /^Machine:/i,
    /^Host application:/i,
    /^Process ID:/i,
    /^PSVersion:/i,
    /^PSEdition:/i,
    /^GitCommitId:/i,
    /^OS:/i,
    /^Platform:/i,
    /^PSCompatibleVersions:/i,
    /^PSRemotingProtocolVersion:/i,
    /^SerializationVersion:/i,
    /^WSManStackVersion:/i,
    /^Transcript (started|stopped)/i,
  ];

  const cleaned = normalizeConsoleText(raw)
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      return !boilerplatePatterns.some((re) => re.test(line));
    })
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line));

  return clipLines(cleaned, 120).join("\n");
}

// ─────────────────────────── helper: cleanup ─────────────────────────────────

function cleanupShell(): void {
  if (!shellState) return;
  const { pid, logFile, launcherFile, hwndFile } = shellState;
  shellState = null;

  // Kill the process (best-effort)
  spawnSync("pwsh", [
    "-NoProfile",
    "-Command",
    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
  ]);

  // Delete temp files
  for (const f of [logFile, launcherFile, hwndFile]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────── helper: misc ────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────── helper: enable / disable ────────────────────────

function enableInteractive(pi: ExtensionAPI, ctx: ExtensionContext): void {
  interactiveEnabled = true;
  const active = pi.getActiveTools();
  if (!active.includes("pwsh_shell")) {
    pi.setActiveTools([...active, "pwsh_shell"]);
  }
  ctx.ui.setStatus("pwsh-interactive", "pwsh ○");
}

function disableInteractive(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (shellState && isShellAlive()) {
    cleanupShell();
  }

  interactiveEnabled = false;
  const active = pi.getActiveTools();
  pi.setActiveTools(active.filter((t) => t !== "pwsh_shell"));
  ctx.ui.setStatus("pwsh-interactive", undefined);
}

// ═════════════════════════════ extension entry ════════════════════════════════

export default function pwshInteractive(pi: ExtensionAPI) {

  // ── Tool: pwsh_shell ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "pwsh_shell",
    label: "PowerShell",
    description: [
      "Open and interact with a real interactive PowerShell window visible to the user.",
      "Use this when the user benefits from seeing output in a real terminal,",
      "or when you want to run something and let the user continue working in the shell.",
      "",
      "The shell stays open between calls. Its transcript is automatically injected",
      "before each of your turns so you can see what happened.",
      "",
      "Actions:",
      "  open     — launch the shell window (loads profile by default; optionally run an initial command)",
      "  send     — inject a command into the already-open shell (appears as if typed by user)",
      "  snapshot — capture visible terminal text for model context (tool renderer shows status only in TUI)",
      "  close    — close the shell and read final transcript",
      "",
      "Only available when the user has enabled interactive mode (/pwsh-toggle).",
    ].join(" "),

    parameters: Type.Object({
      action: StringEnum(["open", "send", "snapshot", "close"] as const, {
        description: "open — launch shell, send — inject command, snapshot — capture viewport text (hidden in TUI; status-only render), close — shut down",
      }),
      command: Type.Optional(
        Type.String({
          description:
            "For 'open': command to run immediately after shell starts. " +
            "For 'send': command to inject into the running shell.",
        })
      ),
      loadProfile: Type.Optional(
        Type.Boolean({
          description:
            "For 'open' only. Defaults to true. Set false to launch raw pwsh with -NoProfile.",
        })
      ),
    }),

    renderCall(args, theme) {
      const icons = { open: "⬡", send: "→", snapshot: "◫", close: "⬢" };
      const icon = icons[(args as { action: string }).action as keyof typeof icons] ?? "?";
      let line =
        theme.fg("toolTitle", theme.bold("pwsh_shell ")) +
        theme.fg("accent", `${icon} ${(args as { action: string }).action}`);
      if ((args as { command?: string }).command) {
        line += theme.fg("dim", `  ${(args as { command: string }).command}`);
      }
      if ((args as { loadProfile?: boolean }).loadProfile === false) {
        line += theme.fg("dim", "  [no-profile]");
      }
      return new Text(line, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { success?: boolean; action?: string; lineCount?: number } | undefined;
      const success = details?.success ?? false;
      const action = details?.action ?? "pwsh_shell";

      const summary = success
        ? action === "snapshot"
          ? `snapshot ✓${typeof details?.lineCount === "number" ? ` (${details.lineCount} lines)` : ""}`
          : `${action} ✓`
        : `${action} ✗`;

      return new Text(theme.fg(success ? "success" : "error", summary), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, command, loadProfile } = params as {
        action: "open" | "send" | "snapshot" | "close";
        command?: string;
        loadProfile?: boolean;
      };

      if (!interactiveEnabled) {
        return {
          content: [{ type: "text", text: "Interactive PowerShell is disabled. Ask the user to run /pwsh-toggle to enable it." }],
          details: { success: false, action },
        };
      }

      // ── open ──────────────────────────────────────────────────────────────
      if (action === "open") {
        if (isShellAlive()) {
          // Window already running — optionally send a command, then focus
          if (command) await sendCommandToShell(command);
          focusShellWindow();
          return {
            content: [{ type: "text", text: command ? `Shell already open. Sent: ${command}` : "Shell already open and focused." }],
            details: { success: true, action },
          };
        }

        try {
          const shouldLoadProfile = loadProfile ?? true;
          shellState = await openShell(command, shouldLoadProfile);
          ctx.ui?.setStatus("pwsh-interactive", "pwsh ●");
          ctx.ui?.notify("PowerShell window opened", "info");
          return {
            content: [{
              type: "text",
              text: command
                ? `Shell opened (${shouldLoadProfile ? "profile" : "no profile"}) and running: ${command}. Transcript will be injected before each turn.`
                : `Shell opened (${shouldLoadProfile ? "profile" : "no profile"}). Transcript will be injected before each turn.`,
            }],
            details: { success: true, action, loadProfile: shouldLoadProfile },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to open shell: ${(err as Error).message}` }],
            details: { success: false, action },
          };
        }
      }

      // ── send ───────────────────────────────────────────────────────────────
      if (action === "send") {
        if (!isShellAlive()) {
          return {
            content: [{ type: "text", text: "No shell window is open. Use action='open' first." }],
            details: { success: false, action },
          };
        }
        if (!command) {
          return {
            content: [{ type: "text", text: "command is required for action='send'." }],
            details: { success: false, action },
          };
        }
        await sendCommandToShell(command);
        return {
          content: [{ type: "text", text: `Command sent: ${command}` }],
          details: { success: true, action },
        };
      }

      // ── snapshot ───────────────────────────────────────────────────────────
      if (action === "snapshot") {
        if (!isShellAlive() || !shellState) {
          return {
            content: [{ type: "text", text: "No shell window is open. Use action='open' first." }],
            details: { success: false, action },
          };
        }

        try {
          focusShellWindow();
          await sleep(250);

          const text = captureVisibleShellText(shellState.pid);
          const normalized = normalizeConsoleText(text);
          const rawLineCount = normalized.split("\n").filter((l) => l.trim()).length;
          const snapshotPayload = formatSnapshotForContext(normalized);

          return {
            // Send full snapshot payload to the model context, while renderResult keeps TUI minimal.
            content: [{ type: "text", text: snapshotPayload || "(snapshot captured but no visible text)" }],
            details: { success: true, action, lineCount: rawLineCount },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to capture visible terminal text: ${(err as Error).message}` }],
            details: { success: false, action },
          };
        }
      }

      // ── close ──────────────────────────────────────────────────────────────
      if (action === "close") {
        if (!shellState || !isShellAlive()) {
          return {
            content: [{ type: "text", text: "No shell window is open." }],
            details: { success: false, action },
          };
        }

        cleanupShell();
        ctx.ui?.setStatus("pwsh-interactive", "pwsh ○");
        ctx.ui?.notify("PowerShell window closed", "info");
        return {
          content: [{ type: "text", text: "Shell closed and transcript stopped." }],
          details: { success: true, action },
        };
      }

      return { content: [{ type: "text", text: "Unknown action." }], details: { success: false, action } };
    },
  });

  // ── Message renderer: pwsh-transcript ───────────────────────────────────────
  pi.registerMessageRenderer("pwsh-transcript", (message, { expanded }, theme) => {
    const details = message.details as { lineCount: number; timestamp: number } | undefined;
    const lineCount = details?.lineCount ?? 0;
    const ts = details?.timestamp ? new Date(details.timestamp).toLocaleTimeString() : "";

    const header =
      theme.fg("accent", "PowerShell Transcript") +
      theme.fg("dim", ` · ${lineCount} line${lineCount !== 1 ? "s" : ""}${ts ? ` · ${ts}` : ""}`);

    const rawContentText =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part): part is { type: "text"; text: string } => {
                return (
                  typeof part === "object" &&
                  part !== null &&
                  "type" in part &&
                  (part as { type?: unknown }).type === "text" &&
                  "text" in part &&
                  typeof (part as { text?: unknown }).text === "string"
                );
              })
              .map((part) => part.text)
              .join("\n")
          : "";

    const contentText = clipLines(
      normalizeConsoleText(rawContentText)
        .split("\n")
        .map((line) => line.replace(/\t/g, " ").replace(/\s{2,}/g, " ").trim())
        .filter(Boolean)
        .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line)),
      100,
    ).join("\n");

    let body = header;
    if (expanded && contentText) {
      body += "\n" + theme.fg("dim", contentText);
    }

    const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(body, 0, 0));
    return box;
  });

  // ── Command: /pwsh-toggle ────────────────────────────────────────────────────
  pi.registerCommand("pwsh-toggle", {
    description: "Enable or disable the interactive PowerShell window",
    handler: async (_args, ctx) => {
      if (interactiveEnabled) {
        disableInteractive(pi, ctx);
        ctx.ui.notify("Interactive PowerShell disabled", "warning");
      } else {
        enableInteractive(pi, ctx);
        ctx.ui.notify("Interactive PowerShell enabled — agent can now open a shell window", "info");
      }
    },
  });

  // ── Command: /pwsh ───────────────────────────────────────────────────────────
  pi.registerCommand("pwsh", {
    description: "Bring the interactive PowerShell window to the foreground",
    handler: async (_args, ctx) => {
      if (!interactiveEnabled) {
        ctx.ui.notify("Interactive mode is off. Use /pwsh-toggle to enable.", "warning");
        return;
      }
      if (!isShellAlive()) {
        ctx.ui.notify("No shell open yet — ask the agent to open one.", "info");
        return;
      }
      focusShellWindow();
    },
  });

  // ── Lifecycle: keep shell state in sync before each agent turn ──────────────
  // Intentionally do NOT inject transcript text into chat/context.
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!interactiveEnabled || !shellState) return;
    if (!isShellAlive()) {
      cleanupShell();
      return;
    }

    // Advance transcript cursor without surfacing transcript content.
    readTranscriptDelta();
  });

  // ── Lifecycle: cleanup on session end ────────────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (shellState) cleanupShell();
  });
}
