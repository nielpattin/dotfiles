import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const FIGMA_START_BASH = String.raw`set -euo pipefail

is_wsl=0
if [ -n "$(printenv WSL_DISTRO_NAME 2>/dev/null)" ] || grep -qi microsoft /proc/version 2>/dev/null; then
  is_wsl=1
fi

if [ "$is_wsl" -eq 1 ]; then
  fig="$(ls -1dt /mnt/c/Users/*/AppData/Local/Figma/app-*/Figma.exe 2>/dev/null | head -n1)"
else
  fig="$(ls -1dt "$HOME"/AppData/Local/Figma/app-*/Figma.exe 2>/dev/null | head -n1)"
fi

if [ -z "$fig" ]; then
  echo "Figma.exe not found under AppData/Local/Figma/app-*"
  exit 1
fi

asar="$(dirname "$fig")/resources/app.asar"

if [ "$is_wsl" -eq 1 ]; then
  taskkill.exe //F //IM Figma.exe > /dev/null 2>&1 || true
else
  taskkill //F //IM Figma.exe > /dev/null 2>&1 || true
fi

if grep -aq 'removeSwitch("remote-debugging-port")' "$asar" 2>/dev/null; then
  [ -f "$asar.bak" ] || cp "$asar" "$asar.bak"
  perl -0777 -i -pe 'BEGIN{binmode(STDIN);binmode(STDOUT)} s/removeSwitch\("remote-debugging-port"\)/removeSwitch("remote-debugXing-port")/g' "$asar"
elif grep -aq 'removeSwitch("remote-debugXing-port")' "$asar" 2>/dev/null; then
  :
else
  :
fi
"$fig" --remote-debugging-port=9222 >/dev/null 2>&1 &

ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "CDP endpoint did not come up on 127.0.0.1:9222"
  exit 1
fi

`;

type RunResult = { code: number; stdout: string; stderr: string };

function isWslHost(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function resolveBash(): string | null {
  if (process.platform !== "win32" || isWslHost()) {
    return "bash";
  }

  const candidates = [
    `${process.env.ProgramFiles || ""}\\Git\\bin\\bash.exe`,
    `${process.env["ProgramFiles(x86)"] || ""}\\Git\\bin\\bash.exe`,
    `${process.env.LocalAppData || ""}\\Programs\\Git\\bin\\bash.exe`,
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  const where = spawnSync("cmd.exe", ["/C", "where bash"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0 && where.stdout) {
    const paths = where.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const p of paths) {
      const lower = p.toLowerCase();
      if (lower.endsWith("\\system32\\bash.exe")) continue; // WSL launcher
      if (lower.endsWith("bash.exe")) return p;
    }
  }

  return null;
}

function runBash(command: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const bashPath = resolveBash();
    if (!bashPath) {
      resolve({
        code: 1,
        stdout: "",
        stderr: "Git Bash not found. Install Git for Windows or add Git bash.exe to PATH.",
      });
      return;
    }

    const child = spawn(bashPath, ["-lc", command], { windowsHide: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export default function figmaStartExtension(pi: ExtensionAPI) {
  pi.registerCommand("figma-start", {
    description: "Patch/start Figma with remote debugging port 9222 (Windows + WSL)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("Starting Figma...", "info");

      const result = await runBash(FIGMA_START_BASH);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

      if (result.code === 0) {
        if (ctx.hasUI) ctx.ui.notify("Figma ready on :9222", "info");
        return;
      }

      const firstLine = output.split(/\r?\n/).find(Boolean) || "unknown error";
      if (ctx.hasUI) ctx.ui.notify(`/figma-start failed: ${firstLine}`, "error");
    },
  });
}
