import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { RouteHandler } from "../http/router.js";
import { applyCors, sendError, sendJson } from "../http/json.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 10 * 1024 * 1024;

function imageExt(rawName: string | null): string | null {
  const ext = extname(rawName ?? "").toLowerCase();
  return MIME_BY_EXT[ext] ? ext : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new Error("图片超过 10MB 上限");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Chat image attachments (`dataDir/attachments`). The composer uploads
 * pasted/dropped images here; the message embeds a runtime URL (for the
 * chat transcript) plus the absolute file path so the CLI agent can read
 * the image with its own file tool.
 */
export function registerAttachmentRoutes(
  router: {
    get: (path: string, handler: RouteHandler) => void;
    post: (path: string, handler: RouteHandler) => void;
  },
  dataDir: string,
): void {
  const dir = resolve(dataDir, "attachments");

  router.post("/api/attachments", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ext = imageExt(url.searchParams.get("name"));
      if (!ext) {
        sendError(res, 400, "仅支持 png/jpg/jpeg/gif/webp 图片");
        return;
      }
      const bytes = await readBody(req);
      await mkdir(dir, { recursive: true });
      const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
      const absolute = join(dir, fileName);
      await writeFile(absolute, bytes);
      sendJson(res, 201, {
        fileName,
        path: absolute,
        url: `/attachments/${fileName}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败";
      sendError(res, /上限|仅支持/.test(message) ? 400 : 500, message);
    }
  });

  router.get("/attachments/:file", async (_req, res, params) => {
    const name = params.file ?? "";
    if (name.includes("/") || name.includes("..")) {
      sendError(res, 404, "附件不存在");
      return;
    }
    const mime = MIME_BY_EXT[extname(name).toLowerCase()];
    if (!mime) {
      sendError(res, 404, "附件不存在");
      return;
    }
    try {
      const bytes = await readFile(join(dir, name));
      applyCors(res);
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "private, max-age=86400",
      });
      res.end(bytes);
    } catch {
      sendError(res, 404, "附件不存在");
    }
  });
}
