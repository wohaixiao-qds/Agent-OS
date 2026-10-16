import type { RouteHandler } from "../http/router.js";
import { readJsonBody, sendError, sendJson } from "../http/json.js";
import type { ZentaoIntegrationService } from "../services/zentao-integration-service.js";

export function registerZentaoIntegrationRoutes(
  router: {
    get: (path: string, handler: RouteHandler) => void;
    patch: (path: string, handler: RouteHandler) => void;
    post: (path: string, handler: RouteHandler) => void;
  },
  service: ZentaoIntegrationService,
): void {
  router.get("/api/integrations/zentao", async (_req, res) => {
    sendJson(res, 200, await service.get());
  });

  router.patch("/api/integrations/zentao", async (req, res) => {
    try {
      const body = await readJsonBody<{
        baseUrl?: string;
        account?: string;
        password?: string;
        clearPassword?: boolean;
      }>(req);
      const snapshot = await service.update(body);
      sendJson(res, 200, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bad request";
      sendError(res, 500, message);
    }
  });

  router.post("/api/integrations/zentao/test", async (_req, res) => {
    // Always 200: body.ok tells success; avoids API client treating failure as transport error.
    const result = await service.testConnection();
    sendJson(res, 200, result);
  });
}
