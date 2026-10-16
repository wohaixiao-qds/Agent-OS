import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TicketPullScheduleService,
  type TicketPullPort,
} from "./ticket-pull-schedule.js";

function port(overrides?: Partial<TicketPullPort>): TicketPullPort & {
  dispatched: string[];
} {
  const dispatched: string[] = [];
  return {
    dispatched,
    listProjects: async () => [
      { id: "proj", localPath: "E:/demo", cast: [] },
    ],
    listTodos: async () => [
      { key: "1", ident: "A", priority: "严重" },
      { key: "2", ident: "B", priority: "主要" },
      { key: "3", ident: "C", priority: "次要" },
      { key: "4", ident: "D", priority: "" },
      { key: "5", ident: "E", priority: "紧急", topicId: "topic-1" },
    ],
    inProgressDispatches: async () => [],
    dispatchToCeo: async (input) => {
      dispatched.push(input.issueKey);
    },
    ...overrides,
  };
}

describe("TicketPullScheduleService", () => {
  it("adds a draft task and refuses a second one for the same project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const service = new TicketPullScheduleService(dir, port());
    const task = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "major",
    });
    expect(task.status).toBe("draft");
    expect(task.nextRunAt).toBeUndefined();
    await expect(
      service.add({ provider: "gitee", projectId: "proj", everyHours: 2, priority: "severe" }),
    ).rejects.toThrow("该项目已有定时任务");
  });

  it("manual run hands matching tickets to CEO without starting the schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port();
    const service = new TicketPullScheduleService(dir, tickets);
    const task = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "major",
    });
    const ran = await service.run(task.id);
    expect(ran.status).toBe("draft");
    expect(ran.nextRunAt).toBeUndefined();
    expect(tickets.dispatched).toEqual(["1"]);
    expect(ran.lastResult).toBe("拉到 5 张，派出 1 张（A）；处理完成后下一轮再派");
  });

  it("skips the round while a dispatched ticket is still in progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port({
      inProgressDispatches: async () => [
        { ident: "A", topicId: "topic-9" },
      ],
    });
    const service = new TicketPullScheduleService(dir, tickets);
    const task = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "major",
    });
    const ran = await service.run(task.id);
    expect(tickets.dispatched).toEqual([]);
    expect(ran.lastResult).toContain("仍在处理中（A）");
    expect(ran.lastResult).toContain("本轮跳过");
  });

  it("reschedules a busy skip after 5 minutes instead of the full interval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port({
      inProgressDispatches: async () => [
        { ident: "A", topicId: "topic-9" },
      ],
    });
    const service = new TicketPullScheduleService(dir, tickets);
    const created = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "major",
    });
    const start = new Date("2026-10-13T09:00:00.000Z");
    await service.start(created.id, start);
    await service.tick(new Date("2026-10-13T10:00:00.000Z").getTime());
    const [after] = await service.list();
    expect(after?.lastResult).toContain("本轮跳过");
    // 忙碌跳过 → 5 分钟后复查，而不是再等 1 小时
    expect(after?.nextRunAt).toBe("2026-10-13T10:05:00.000Z");
    // 复查时若已空闲则照常派发
    tickets.inProgressDispatches = async () => [];
    await service.tick(new Date("2026-10-13T10:05:00.000Z").getTime());
    expect(tickets.dispatched).toEqual(["1"]);
  });

  it("none threshold dispatches serially: unprioritized included, 次要 skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    // 第 1 张派出后标记为已派（带 topicId），下一轮应派第 2 张
    const dispatchedKeys = new Set<string>();
    const tickets = port({
      listTodos: async () => {
        const all = [
          { key: "1", ident: "A", priority: "严重" },
          { key: "2", ident: "B", priority: "主要" },
          { key: "3", ident: "C", priority: "次要" },
          { key: "4", ident: "D", priority: "" },
        ];
        return all.map((item) =>
          dispatchedKeys.has(item.key)
            ? { ...item, topicId: `topic-${item.key}` }
            : item,
        );
      },
      dispatchToCeo: async (input) => {
        dispatchedKeys.add(input.issueKey);
        tickets.dispatched.push(input.issueKey);
      },
    });
    const service = new TicketPullScheduleService(dir, tickets);
    const task = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "none",
    });
    await service.run(task.id);
    expect(tickets.dispatched).toEqual(["1"]);
    await service.run(task.id);
    // 次要被跳过，无优先级 D 在 B 之后
    expect(tickets.dispatched).toEqual(["1", "2"]);
  });

  it("starts later, and tick dispatches only when due", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port();
    const service = new TicketPullScheduleService(dir, tickets);
    const created = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "severe",
    });
    const now = new Date("2026-10-13T09:00:00.000Z");
    const started = await service.start(created.id, now);
    expect(started.status).toBe("active");
    expect(started.nextRunAt).toBe("2026-10-13T10:00:00.000Z");

    await service.tick(now.getTime() + 30 * 60 * 1000);
    expect(tickets.dispatched).toEqual([]);

    await service.tick(new Date("2026-10-13T10:00:00.000Z").getTime());
    expect(tickets.dispatched).toEqual(["1"]);
    const [after] = await service.list();
    expect(after?.lastResult).toBe("拉到 5 张，派出 1 张（A）；处理完成后下一轮再派");
    expect(after?.nextRunAt).toBe("2026-10-13T11:00:00.000Z");
  });

  it("pause stops later ticks until resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port();
    const service = new TicketPullScheduleService(dir, tickets);
    const created = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 1,
      priority: "severe",
    });
    await service.start(created.id, new Date("2026-10-13T09:00:00.000Z"));
    await service.pause(created.id);
    await service.tick(new Date("2026-10-13T12:00:00.000Z").getTime());
    expect(tickets.dispatched).toEqual([]);
    const resumed = await service.resume(
      created.id,
      new Date("2026-10-13T12:00:00.000Z"),
    );
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-10-13T13:00:00.000Z");
  });

  it("records a missing work directory without dispatching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-pull-"));
    const tickets = port({
      listProjects: async () => [{ id: "proj", localPath: "  ", cast: ["developer"] }],
    });
    const service = new TicketPullScheduleService(dir, tickets);
    const task = await service.add({
      provider: "gitee",
      projectId: "proj",
      everyHours: 2,
      priority: "major",
    });
    await expect(service.run(task.id)).rejects.toThrow("本地工作目录");
    const [saved] = await service.list();
    expect(saved?.lastResult).toContain("本地工作目录");
    expect(saved?.status).toBe("draft");
    expect(tickets.dispatched).toEqual([]);
  });
});
