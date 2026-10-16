import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  AcceptanceSubmissionToolSchema,
  ApprovalRequestSchema,
  ClarificationRequestToolSchema,
  DispatchTaskRequestSchema,
  ProductSpecRequestToolSchema,
  ScheduleManageRequestToolSchema,
} from "@zy-aos/shared";

// 与 app-tools-server.ts 的注册面保持一致：inputSchema 必须是对象型。
// superRefine/union 包装会被 SDK 的 normalizeObjectSchema 判空，agent 端就会
// 看到"无参数"工具（submit_acceptance 空参数故障的根因）。
const registrations: Array<[name: string, schema: z.ZodTypeAny]> = [
  ["request_clarification", ClarificationRequestToolSchema],
  ["dispatch_task", DispatchTaskRequestSchema],
  ["request_spec_approval", ProductSpecRequestToolSchema],
  ["request_approval", ApprovalRequestSchema],
  ["schedule_manage", ScheduleManageRequestToolSchema],
  ["submit_acceptance", AcceptanceSubmissionToolSchema],
  [
    "run_acceptance_suite",
    z.object({ baseURL: z.string().trim().max(300).optional() }),
  ],
];

async function listRegisteredTools() {
  const server = new McpServer({ name: "schema-test", version: "0.0.0" });
  for (const [name, schema] of registrations) {
    server.registerTool(
      name,
      { title: name, description: name, inputSchema: schema } as never,
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
  }
  const [clientToServer, serverToClient] = InMemoryTransport.createLinkedPair();
  await server.connect(serverToClient);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientToServer);
  return (await client.listTools()).tools;
}

function propertiesOf(tool: { inputSchema: unknown }): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema?.properties ?? {});
}

describe("MCP 工具 schema 渲染", () => {
  it("每个工具都渲染出非空参数，不回退成无参数声明", async () => {
    const tools = await listRegisteredTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      registrations.map(([name]) => name).sort(),
    );
    for (const tool of tools) {
      expect(propertiesOf(tool).length, `${tool.name} 被渲染成无参数`).toBeGreaterThan(0);
    }
  });

  it("submit_acceptance 声明包含关键字段", async () => {
    const tools = await listRegisteredTools();
    const tool = tools.find((item) => item.name === "submit_acceptance");
    expect(propertiesOf(tool!)).toEqual(
      expect.arrayContaining(["verdict", "summary", "checks", "evidence", "skipReason"]),
    );
  });

  it("Tool schema 接受严格 schema 的合法样例（防字段漂移）", () => {
    expect(
      AcceptanceSubmissionToolSchema.safeParse({
        verdict: "pass",
        summary: "首页渲染正常",
      }).success,
    ).toBe(true);
    expect(
      ClarificationRequestToolSchema.safeParse({
        questions: [
          {
            id: "q1",
            prompt: "选哪个？",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ProductSpecRequestToolSchema.safeParse({
        deliveryMode: "local",
        title: "方案",
        summary: "说明",
        specPath: "docs/spec.md",
        ticketsPath: "docs/tickets.md",
      }).success,
    ).toBe(true);
    expect(ScheduleManageRequestToolSchema.safeParse({ action: "list" }).success).toBe(
      true,
    );
    expect(
      ScheduleManageRequestToolSchema.safeParse({
        action: "add",
        targetBotId: "product",
        prompt: "跟进需求",
        rule: { kind: "once", runAt: "2026-01-01T00:00:00.000Z" },
      }).success,
    ).toBe(true);
  });
});
