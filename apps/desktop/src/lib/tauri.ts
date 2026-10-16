const RUNTIME_BASE = "http://127.0.0.1:17890";

/**
 * reachable=true means the runtime dialog did open; path=null then means the
 * user cancelled it, so no further fallback should be shown.
 */
type RuntimePickResult =
  | { reachable: true; path: string | null }
  | { reachable: false };

async function pickViaRuntime(): Promise<RuntimePickResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${RUNTIME_BASE}/api/dialog/pick-folder`, {
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) return { reachable: false };
    const data = (await response.json()) as { path?: string | null };
    const path = typeof data.path === "string" ? data.path.trim() : "";
    return { reachable: true, path: path || null };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

let inFlight: Promise<string | null> | null = null;

async function pickFolderOnce(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("pick_folder");
    if (path === null) return null;
    if (typeof path === "string" && path.trim()) {
      return path.trim();
    }
  } catch {
    // Not in the Tauri shell — fall through to the runtime native dialog.
  }

  const viaRuntime = await pickViaRuntime();
  return viaRuntime.reachable ? viaRuntime.path : null;
}

/**
 * Pick a local folder via Tauri `pick_folder` or the runtime-side native
 * dialog (browser mode). No manual text entry: null means cancelled or
 * unavailable. Concurrent calls share one dialog.
 */
export async function pickFolder(): Promise<string | null> {
  if (!inFlight) {
    inFlight = pickFolderOnce().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
