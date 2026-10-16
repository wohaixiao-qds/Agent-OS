import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

/** Spawn a dialog helper; injectable for tests (same pattern as claude-adapter). */
export type DialogSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface FolderDialogOptions {
  spawnFn?: DialogSpawnFn;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  homeDir?: string;
}

export class FolderDialogUnsupportedError extends Error {
  constructor(platform: string) {
    super(`当前平台（${platform}）没有可用的目录选择对话框工具。`);
    this.name = "FolderDialogUnsupportedError";
  }
}

interface DialogCommand {
  command: string;
  args: string[];
  /** Extract the chosen path from stdout; null when empty output. */
  parse: (stdout: string) => string | null;
}

type DialogResult =
  | { status: "picked"; path: string | null }
  | { status: "cancelled" }
  | { status: "unavailable" };

const DARWIN_SCRIPT =
  'POSIX path of (choose folder with prompt "选择项目目录")';

/** osascript prints AppleScript string literals with surrounding quotes. */
function unquoteAppleScriptString(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return text;
}

function trimToPath(stdout: string): string | null {
  const text = stdout.trim();
  return text ? text : null;
}

const WINDOWS_PS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
].join("; ");

function commandsFor(
  platform: NodeJS.Platform,
  homeDir: string,
): DialogCommand[] {
  switch (platform) {
    case "darwin":
      return [
        {
          command: "osascript",
          args: ["-e", DARWIN_SCRIPT],
          parse: (stdout) => {
            const text = unquoteAppleScriptString(stdout);
            return text ? text : null;
          },
        },
      ];
    case "win32":
      return [
        {
          command: "powershell.exe",
          args: ["-NoProfile", "-STA", "-Command", WINDOWS_PS_SCRIPT],
          parse: trimToPath,
        },
      ];
    case "linux":
      return [
        {
          command: "zenity",
          args: [
            "--file-selection",
            "--directory",
            "--title",
            "选择项目目录",
          ],
          parse: trimToPath,
        },
        {
          command: "kdialog",
          args: ["--getexistingdirectory", homeDir],
          parse: trimToPath,
        },
      ];
    default:
      return [];
  }
}

function runDialogCommand(
  cmd: DialogCommand,
  spawnFn: DialogSpawnFn,
  signal?: AbortSignal,
): Promise<DialogResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd.command, cmd.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ status: "unavailable" });
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {
      // Cancel / error text is not needed: non-zero exit means cancelled.
    });

    let settled = false;
    const onAbort = () => {
      child.kill();
    };
    const finish = (result: DialogResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    if (signal?.aborted) {
      child.kill();
      finish({ status: "cancelled" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") finish({ status: "unavailable" });
      else finish({ status: "cancelled" });
    });
    child.on("close", (code) => {
      if (code === 0) finish({ status: "picked", path: cmd.parse(stdout) });
      else finish({ status: "cancelled" });
    });
  });
}

/**
 * Open the OS folder-picker dialog and resolve the chosen absolute path.
 * Resolves null when the user cancels (or the caller aborts); throws
 * FolderDialogUnsupportedError when no dialog tool exists on the platform.
 */
export async function pickFolder(
  options: FolderDialogOptions = {},
): Promise<string | null> {
  const spawnFn = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? process.env.HOME ?? ".";

  const commands = commandsFor(platform, homeDir);
  if (commands.length === 0) {
    throw new FolderDialogUnsupportedError(String(platform));
  }

  for (const cmd of commands) {
    const result = await runDialogCommand(cmd, spawnFn, options.signal);
    if (result.status === "picked") return result.path;
    if (result.status === "cancelled") return null;
    // unavailable → try the next candidate (linux zenity → kdialog)
  }
  throw new FolderDialogUnsupportedError(String(platform));
}
