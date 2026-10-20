import type { RouteHandler } from "../http/router.js";
import { readJsonBody, sendError, sendJson } from "../http/json.js";
import type { TicketService } from "../services/ticket-service.js";
import type { TicketProviderId } from "../tickets/provider.js";

const PROVIDERS = new Set(["gitee", "zentao"]);

function providerParam(provider: string): TicketProviderId {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`未知工单来源: ${provider}`);
  }
  return provider as TicketProviderId;
}

function statusFor(message: string): number {
  if (/未知工单来源/i.test(message)) return 400;
  if (/缺少|ZY_AOS_|GITEE_|ZENTAO_|无法从/i.test(message)) return 503;
  if (/不存在|找不到|无效|404|需使用数字|不属于/i.test(message)) return 404;
  if (/请先|缺少 issue_type|必填/i.test(message)) return 400;
  return 500;
}

export function registerTicketRoutes(
  router: {
    get: (path: string, handler: RouteHandler) => void;
    post: (path: string, handler: RouteHandler) => void;
    patch: (path: string, handler: RouteHandler) => void;
  },
  service: TicketService,
): void {
  router.get("/api/tickets/status", async (_req, res) => {
    sendJson(res, 200, await service.status());
  });

  router.get("/api/tickets/:provider/projects", async (_req, res, params) => {
    try {
      const projects = await service.listProjects(
        providerParam(params.provider),
      );
      sendJson(res, 200, projects);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      sendError(res, statusFor(message), message);
    }
  });

  router.patch(
    "/api/tickets/:provider/projects/:id",
    async (req, res, params) => {
      try {
        const body = await readJsonBody<{
          localPath?: string;
          defaultEngine?: "claude" | "codex";
          cast?: string[];
          testBaseUrl?: string;
          testStartCommand?: string;
        }>(req);
        const project = await service.updateProject(
          providerParam(params.provider),
          params.id,
          body,
        );
        sendJson(res, 200, project);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request";
        sendError(res, /不存在/i.test(message) ? 404 : 400, message);
      }
    },
  );

  router.get(
    "/api/tickets/:provider/projects/:id/todos",
    async (req, res, params) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const includeAll = url.searchParams.get("all") === "1";
        const todos = await service.listTodos(
          providerParam(params.provider),
          params.id,
          { includeAllStates: includeAll },
        );
        sendJson(res, 200, todos);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request";
        sendError(res, statusFor(message), message);
      }
    },
  );

  router.get(
    "/api/tickets/:provider/projects/:id/issues/:issueKey",
    async (_req, res, params) => {
      try {
        const detail = await service.getTodoDetail(
          providerParam(params.provider),
          params.id,
          params.issueKey,
        );
        sendJson(res, 200, detail);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request";
        sendError(res, statusFor(message), message);
      }
    },
  );

  router.get(
    "/api/tickets/:provider/projects/:id/issues/:issueKey/states",
    async (_req, res, params) => {
      try {
        const states = await service.listIssueStates(
          providerParam(params.provider),
          params.id,
          params.issueKey,
        );
        sendJson(res, 200, states);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request";
        sendError(res, statusFor(message), message);
      }
    },
  );

  router.post(
    "/api/tickets/:provider/projects/:id/issues/:issueKey/state",
    async (req, res, params) => {
      try {
        const body = await readJsonBody<{ issueStateId?: number }>(req);
        if (typeof body.issueStateId !== "number") {
          sendError(res, 400, "issueStateId 必填且须为数字");
          return;
        }
        const result = await service.updateIssueState({
          provider: providerParam(params.provider),
          projectId: params.id,
          issueKey: params.issueKey,
          issueStateId: body.issueStateId,
        });
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request";
        sendError(res, statusFor(message), message);
      }
    },
  );

  router.get(
    "/api/tickets/:provider/attachment",
    async (req, res, params) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const target = url.searchParams.get("url") ?? "";
      if (!target.trim()) {
        sendError(res, 400, "url 必填");
        return;
      }
      const file = await service.fetchAttachment(
        providerParam(params.provider),
        target,
      );
      res.writeHead(200, {
        "content-type": file.mime ?? "application/octet-stream",
        "cache-control": "private, max-age=300",
      });
      res.end(file.bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "附件获取失败";
      sendError(res, statusFor(message), message);
    }
    },
  );

  router.post("/api/tickets/dispatch", async (req, res) => {
    try {
      const body = await readJsonBody<{
        provider?: string;
        projectId?: string;
        issueKey?: string;
        workspaceId?: string;
        note?: string;
      }>(req);
      if (!body.projectId?.trim() || !body.issueKey?.trim()) {
        sendError(res, 400, "projectId 与 issueKey 必填");
        return;
      }
      const result = await service.dispatchToCeo({
        provider: providerParam(body.provider?.trim() || "gitee"),
        projectId: body.projectId.trim(),
        issueKey: body.issueKey.trim(),
        workspaceId: body.workspaceId,
        note: body.note,
      });
      // done 是给定时拉单串行等待用的内部 Promise，不进 HTTP 响应
      const { done, ...rest } = result;
      void done;
      sendJson(res, 201, rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      sendError(res, statusFor(message), message);
    }
  });

  router.post("/api/tickets/:provider/holds", async (req, res, params) => {
    try {
      const body = await readJsonBody<{
        projectId?: string;
        issueKey?: string;
        held?: boolean;
      }>(req);
      if (!body.projectId?.trim() || !body.issueKey?.trim()) {
        sendError(res, 400, "projectId 与 issueKey 必填");
        return;
      }
      if (typeof body.held !== "boolean") {
        sendError(res, 400, "held 必须是布尔值");
        return;
      }
      const result = await service.holdTicket({
        provider: providerParam(params.provider),
        projectId: body.projectId.trim(),
        issueKey: body.issueKey.trim(),
        held: body.held,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      sendError(res, statusFor(message), message);
    }
  });
}
