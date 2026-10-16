import { describe, expect, it } from "vitest";
import { ZentaoClient } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { client: ZentaoClient; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push({ url: href, init });
    return handler(href, init);
  }) as unknown as typeof fetch;
  return {
    client: new ZentaoClient(
      {
        baseUrl: "http://zentao.example",
        account: "dev",
        password: "pw",
      },
      fetcher,
    ),
    calls,
  };
}

const CONFIG = {
  baseUrl: "http://zentao.example",
  account: "dev",
  password: "pw",
};

describe("ZentaoClient", () => {
  it("authenticates once and sends the Token header", async () => {
    let tokenCalls = 0;
    const { client, calls } = clientWith((url) => {
      if (url.endsWith("/tokens")) {
        tokenCalls += 1;
        return jsonResponse(201, { token: "tok-1" });
      }
      return jsonResponse(200, { id: 7, name: "T7", status: "wait", pri: 1 });
    });
    await client.getTask(7);
    await client.getTask(7);
    expect(tokenCalls).toBe(1);
    expect(calls[1]?.init?.headers).toMatchObject({ Token: "tok-1" });
  });

  it("re-authenticates once on 401", async () => {
    let tokenCalls = 0;
    let firstData = true;
    const { client } = clientWith((url) => {
      if (url.endsWith("/tokens")) {
        tokenCalls += 1;
        return jsonResponse(201, { token: `tok-${tokenCalls}` });
      }
      if (firstData) {
        firstData = false;
        return jsonResponse(401, { error: "token expired" });
      }
      return jsonResponse(200, { id: 7, name: "T7", status: "wait", pri: 1 });
    });
    const task = await client.getTask(7);
    expect(task.id).toBe(7);
    expect(tokenCalls).toBe(2);
  });

  it("surfaces auth failure with a clear message", async () => {
    const { client } = clientWith((url) => {
      if (url.endsWith("/tokens")) {
        return jsonResponse(401, { error: "账号或密码错误" });
      }
      throw new Error("unreachable");
    });
    await expect(client.getTask(1)).rejects.toThrow(/禅道认证失败/);
  });

  it("lists projects across pages", async () => {
    const { client, calls } = clientWith((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/tokens")) {
        return jsonResponse(201, { token: "tok-1" });
      }
      if (parsed.pathname.endsWith("/projects")) {
        const page = parsed.searchParams.get("page");
        if (page === "1") {
          return jsonResponse(200, {
            page: 1,
            total: 3,
            limit: 2,
            projects: [
              { id: 1, name: "A", code: "a" },
              { id: 2, name: "B" },
            ],
          });
        }
        return jsonResponse(200, {
          page: 2,
          total: 3,
          limit: 2,
          projects: [{ id: 3, name: "C" }],
        });
      }
      throw new Error("unexpected " + url);
    });
    const projects = await client.listProjects();
    expect(projects.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(calls.length).toBe(3); // tokens + page1 + page2
  });

  it("parses bug rows with object assignedTo", async () => {
    const { client } = clientWith((url) => {
      if (url.endsWith("/tokens")) {
        return jsonResponse(201, { token: "tok-1" });
      }
      return jsonResponse(200, {
        total: 1,
        bugs: [
          {
            id: 39766,
            title: "导出为空",
            status: "active",
            severity: 2,
            assignedTo: { account: "dev", realname: "开发者" },
            product: 51,
            steps: '<img src="/file-read-9.png" alt="截图"/>',
          },
        ],
      });
    });
    const bugs = await client.listProductBugs(51);
    expect(bugs[0]?.id).toBe(39766);
    expect(bugs[0]?.assignedTo).toEqual({ account: "dev", realname: "开发者" });
    expect(bugs[0]?.steps).toContain("file-read-9.png");
  });

  it("updates task status via PUT and resolves bugs via POST", async () => {
    const methods: string[] = [];
    const bodies: unknown[] = [];
    const { client } = clientWith((url, init) => {
      methods.push(String(init?.method ?? "GET"));
      if (init?.body) bodies.push(JSON.parse(String(init!.body)));
      if (url.endsWith("/tokens")) {
        return jsonResponse(201, { token: "tok-1" });
      }
      return jsonResponse(200, {});
    });
    await client.updateTaskStatus(12, "done");
    await client.resolveBug(39, { comment: "已修复" });
    expect(methods).toEqual(["POST", "PUT", "POST"]);
    expect(bodies[0]).toEqual({ account: "dev", password: "pw" });
    expect(bodies[1]).toEqual({ status: "done" });
    expect(bodies[2]).toEqual({ resolution: "fixed", comment: "已修复" });
  });

  it("falls back to top-level /executions when project executions 404", async () => {
    const { client } = clientWith((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/tokens")) {
        return jsonResponse(201, { token: "tok-1" });
      }
      if (parsed.pathname === "/api.php/v1/projects/5/executions") {
        return jsonResponse(404, { error: "not found" });
      }
      if (parsed.pathname === "/api.php/v1/executions") {
        return jsonResponse(200, {
          total: 1,
          executions: [
            { id: 11, name: "迭代一", project: 5 },
            { id: 12, name: "其他项目", project: 6 },
          ],
        });
      }
      throw new Error("unexpected " + url);
    });
    const executions = await client.listProjectExecutions(5);
    expect(executions.map((e) => e.id)).toEqual([11]);
  });
});

describe("baseUrl normalization", () => {
  it("strips trailing slashes from baseUrl", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | RequestInfo) => {
      calls.push(typeof url === "string" ? url : url.toString());
      return jsonResponse(201, { token: "t" });
    }) as unknown as typeof fetch;
    const client = new ZentaoClient(
      { ...CONFIG, baseUrl: "http://zentao.example/" },
      fetcher,
    );
    await client.request("/tokens", { method: "POST", body: {} }).catch(
      () => undefined,
    );
    expect(calls[0]).toBe("http://zentao.example/api.php/v1/tokens");
  });
});
