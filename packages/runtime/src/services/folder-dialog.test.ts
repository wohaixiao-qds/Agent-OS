import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  FolderDialogUnsupportedError,
  pickFolder,
  type DialogSpawnFn,
} from "./folder-dialog.js";

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): void;
}

function fakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    // Simulate SIGTERM taking effect.
    child.emit("close", null, "SIGTERM");
  };
  return child;
}

function spawnFnFor(script: (command: string, child: FakeChildProcess) => void) {
  const seen: string[] = [];
  const spawnFn: DialogSpawnFn = (command) => {
    const child = fakeChild();
    seen.push(command);
    // Defer so runDialogCommand attaches its listeners before events fire.
    queueMicrotask(() => script(command, child));
    return child as unknown as ChildProcess;
  };
  return { spawnFn, seen };
}

function emitOutput(child: FakeChildProcess, stdout = "", stderr = "") {
  if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
  if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
}

describe("pickFolder", () => {
  it("darwin: parses the quoted POSIX path from osascript", async () => {
    const { spawnFn } = spawnFnFor((command, child) => {
      if (command === "osascript") {
        emitOutput(child, '"/Users/zhangyu/My Project"\n');
        child.emit("close", 0, null);
      }
    });
    const path = await pickFolder({
      spawnFn,
      platform: "darwin",
    });
    expect(path).toBe("/Users/zhangyu/My Project");
  });

  it("darwin: cancel exits non-zero and resolves null", async () => {
    const { spawnFn } = spawnFnFor((_command, child) => {
      emitOutput(child, "", "execution error: User canceled. (-128)\n");
      child.emit("close", 1, null);
    });
    const path = await pickFolder({ spawnFn, platform: "darwin" });
    expect(path).toBeNull();
  });

  it("win32: returns the PowerShell SelectedPath", async () => {
    const { spawnFn } = spawnFnFor((command, child) => {
      if (command === "powershell.exe") {
        emitOutput(child, "E:\\projects\\repo\r\n");
        child.emit("close", 0, null);
      }
    });
    const path = await pickFolder({ spawnFn, platform: "win32" });
    expect(path).toBe("E:\\projects\\repo");
  });

  it("win32: empty output (dialog cancelled) resolves null", async () => {
    const { spawnFn } = spawnFnFor((_command, child) => {
      child.emit("close", 0, null);
    });
    const path = await pickFolder({ spawnFn, platform: "win32" });
    expect(path).toBeNull();
  });

  it("linux: falls back from zenity (ENOENT) to kdialog", async () => {
    const { spawnFn, seen } = spawnFnFor((command, child) => {
      if (command === "zenity") {
        child.emit("error", Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" }));
        return;
      }
      emitOutput(child, "/home/dev/repo\n");
      child.emit("close", 0, null);
    });
    const path = await pickFolder({
      spawnFn,
      platform: "linux",
      homeDir: "/home/dev",
    });
    expect(path).toBe("/home/dev/repo");
    expect(seen).toEqual(["zenity", "kdialog"]);
  });

  it("linux: all candidates missing throws unsupported", async () => {
    const { spawnFn } = spawnFnFor((_command, child) => {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    });
    await expect(
      pickFolder({ spawnFn, platform: "linux", homeDir: "/home/dev" }),
    ).rejects.toBeInstanceOf(FolderDialogUnsupportedError);
  });

  it("unknown platform throws unsupported without spawning", async () => {
    const { spawnFn, seen } = spawnFnFor(() => {});
    await expect(
      pickFolder({ spawnFn, platform: "freebsd" }),
    ).rejects.toThrow(FolderDialogUnsupportedError);
    expect(seen).toEqual([]);
  });

  it("abort kills the dialog process and resolves null", async () => {
    const controller = new AbortController();
    const { spawnFn } = spawnFnFor((_command, child) => {
      // Dialog stays open until the abort kills the fake child.
      setTimeout(() => child.emit("close", 0, null), 60_000);
    });
    const pending = pickFolder({
      spawnFn,
      platform: "darwin",
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBeNull();
  });

  it("pre-aborted signal resolves null without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawnFn } = spawnFnFor(() => {});
    const path = await pickFolder({
      spawnFn,
      platform: "darwin",
      signal: controller.signal,
    });
    expect(path).toBeNull();
  });
});
