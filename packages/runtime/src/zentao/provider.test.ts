import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZentaoTicketProvider, extractZentaoImageUrls } from "../tickets/zentao-provider.js";
import { ZentaoProjectsStore } from "./projects.js";
import { updateStoredZentaoCredentials } from "./credentials.js";
import type { ZentaoClient } from "./client.js";

function fakeClient(): ZentaoClient {
  return {
    listProjects: async () => [{ id: 5, name: "演示项目", code: "demo" }],
    listProjectExecutions: async () => [
      { id: 11, name: "迭代一", project: 5 },
    ],
    listExecutionTasks: async (executionId: number) => [
      {
        id: 208,
        name: "接入手机号登录",
        status: "wait",
        pri: 3,
        assignedTo: { account: "dev", realname: "开发者" },
        execution: executionId,
        project: 5,
        openedBy: "pm",
        desc: "任务描述",
      },
      {
        id: 209,
        name: "已完成任务",
        status: "done",
        pri: 1,
        assignedTo: "dev",
        execution: executionId,
        project: 5,
      },
      {
        id: 210,
        name: "别人的任务",
        status: "wait",
        pri: 2,
        assignedTo: "other",
        execution: executionId,
        project: 5,
      },
    ],
    listProjectProducts: async () => [{ id: 51, name: "主产品" }],
    listProductBugs: async () => [
      {
        id: 1337,
        title: "导出为空",
        status: "active",
        severity: 1,
        pri: 1,
        assignedTo: { account: "dev" },
        product: 51,
        project: 5,
        openedBy: "tester",
        steps: '<img src="/file-read-9.png" alt="截图"/>',
      },
      {
        id: 1338,
        title: "已解决的 Bug",
        status: "resolved",
        assignedTo: "dev",
        product: 51,
      },
    ],
    getTask: async (id: number) => ({
      id,
      name: "接入手机号登录",
      status: "wait",
      pri: 3,
      assignedTo: { account: "dev" },
      execution: 11,
      project: 5,
      openedBy: "pm",
      desc: "任务描述",
      deadline: "2026-11-01",
    }),
    getBug: async (id: number) => ({
      id,
      title: "导出为空",
      status: "active",
      severity: 1,
      pri: 1,
      assignedTo: { account: "dev" },
      product: 51,
      project: 5,
      openedBy: "tester",
      steps: '<img src="/file-read-9.png" alt="截图"/>',
    }),
    updateTaskStatus: async () => undefined,
    resolveBug: async () => undefined,
    closeBug: async () => undefined,
    activateBug: async () => undefined,
  } as unknown as ZentaoClient;
}

async function makeProvider() {
  const dir = await mkdtemp(join(tmpdir(), "zy-aos-zentao-prov-"));
  await updateStoredZentaoCredentials(
    {
      baseUrl: "http://zentao.example",
      account: "dev",
      password: "pw",
    },
    dir,
  );
  const client = fakeClient();
  const store = new ZentaoProjectsStore(dir, async () => client);
  const provider = new ZentaoTicketProvider(dir, store, async () => client);
  return { dir, provider, client };
}

describe("ZentaoTicketProvider", () => {
  it("lists my active bugs and todo tasks with kind + priority mapping", async () => {
    const { dir, provider } = await makeProvider();
    try {
      const todos = await provider.listTodos("5");
      // 默认待办：BUG-1337（active）+ TASK-208（wait）；resolved/done/别人的不进
      expect(todos.map((t) => t.key).sort()).toEqual(["BUG-1337", "TASK-208"]);
      const bug = todos.find((t) => t.key === "BUG-1337")!;
      expect(bug.priority).toBe("紧急");
      expect(bug.priorityRank).toBe(0);
      expect(bug.url).toContain("bug-view-1337.html");
      expect(bug.sprintTitle).toBe("主产品");
      const task = todos.find((t) => t.key === "TASK-208")!;
      expect(task.priority).toBe("主要");
      expect(task.sprintTitle).toBe("迭代一");

      const all = await provider.listTodos("5", { includeAllStates: true });
      expect(all.map((t) => t.key).sort()).toEqual([
        "BUG-1337",
        "BUG-1338",
        "TASK-208",
        "TASK-209",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("getDetail parses bug steps into description and image urls", async () => {
    const { dir, provider } = await makeProvider();
    try {
      const detail = await provider.getDetail("5", "BUG-1337");
      expect(detail.title).toBe("导出为空");
      expect(detail.authorName).toBe("tester");
      expect(detail.imageUrls).toEqual([
        "http://zentao.example/file-read-9.png",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("listStates returns static options per kind", async () => {
    const { dir, provider } = await makeProvider();
    try {
      const bugStates = await provider.listStates("5", "BUG-1");
      expect(bugStates.map((s) => s.title)).toEqual(["激活", "已解决", "已关闭"]);
      const taskStates = await provider.listStates("5", "TASK-1");
      expect(taskStates.map((s) => s.title)).toEqual([
        "待开始",
        "进行中",
        "已暂停",
        "已完成",
        "已取消",
        "已关闭",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updateState routes bugs to resolve and tasks to PUT status", async () => {
    const { dir, provider, client } = await makeProvider();
    const calls: string[] = [];
    (client as unknown as Record<string, unknown>).resolveBug = async () => {
      calls.push("resolve:1337");
    };
    (client as unknown as Record<string, unknown>).updateTaskStatus =
      async (id: number, status: string) => {
        calls.push(`task:${id}:${status}`);
      };
    try {
      const bugResult = await provider.updateState({
        projectId: "5",
        issueKey: "BUG-1337",
        stateId: 2,
      });
      expect(bugResult).toEqual({ stateId: 2, stateTitle: "已解决" });
      const taskResult = await provider.updateState({
        projectId: "5",
        issueKey: "TASK-208",
        stateId: 4,
      });
      expect(taskResult).toEqual({ stateId: 4, stateTitle: "已完成" });
      expect(calls).toEqual(["resolve:1337", "task:208:done"]);
      await expect(
        provider.updateState({ projectId: "5", issueKey: "X-1", stateId: 1 }),
      ).rejects.toThrow(/BUG-数字|TASK-数字/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloads description screenshots into the workspace tickets dir", async () => {
    const { dir, provider, client } = await makeProvider();
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
      "hex",
    );
    (client as unknown as Record<string, unknown>).downloadFile = async () => ({
      bytes: png,
      mime: "image/png",
    });
    const workspace = join(dir, "ws");
    try {
      const downloads = await provider.downloadImages({
        localPath: workspace,
        ident: "BUG-1337",
        urls: ["http://zentao.example/file-read-9.png"],
      });
      expect(downloads[0]?.localPath).toContain(
        join(".zy-aos", "tickets", "BUG-1337", "01.png"),
      );
      const written = await readFile(
        join(workspace, ".zy-aos", "tickets", "BUG-1337", "01.png"),
      );
      expect(written.equals(png)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractZentaoImageUrls", () => {
  it("collects img and markdown sources and absolutizes them", () => {
    const urls = extractZentaoImageUrls(
      [
        '<img src="/file-read-1.png" alt="a">',
        '![b](file-download-2.jpg)',
        "<img src='https://cdn.example/x.png'>",
        "![外链](https://other.example/y.png)",
      ].join("\n"),
      "http://zentao.example",
    );
    // img 标签先收集、markdown 后收集（分组顺序）
    expect(urls).toEqual([
      "http://zentao.example/file-read-1.png",
      "https://cdn.example/x.png",
      "http://zentao.example/file-download-2.jpg",
      "https://other.example/y.png",
    ]);
  });

  it("returns empty for empty descriptions", () => {
    expect(extractZentaoImageUrls("", "http://z")).toEqual([]);
    expect(extractZentaoImageUrls(undefined, "http://z")).toEqual([]);
  });
});
