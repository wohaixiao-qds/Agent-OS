import type { RouteHandler } from "../http/router.js";
import { readJsonBody, sendError, sendJson } from "../http/json.js";
import {
  FolderDialogUnsupportedError,
  pickFolder,
} from "../services/folder-dialog.js";

export function registerDialogRoutes(
  router: {
    get: (path: string, handler: RouteHandler) => void;
    post: (path: string, handler: RouteHandler) => void;
    patch: (path: string, handler: RouteHandler) => void;
    delete: (path: string, handler: RouteHandler) => void;
  },
): void {
  router.post("/api/dialog/pick-folder", async (req, res) => {
    await readJsonBody(req);
    // Kill the native dialog when the client goes away (timeout / unload).
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const path = await pickFolder({ signal: controller.signal });
      sendJson(res, 200, { path });
    } catch (error) {
      if (error instanceof FolderDialogUnsupportedError) {
        sendError(res, 501, error.message);
        return;
      }
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "目录选择失败",
      );
    }
  });
}
