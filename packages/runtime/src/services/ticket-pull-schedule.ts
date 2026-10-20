import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  comparePriorityThenIdent,
  matchesPullPriority,
  type PullPriority,
} from "../gitee/priority.js";
import type { TicketProviderId } from "../tickets/provider.js";

const HOUR_MS = 60 * 60 * 1000;

/** 忙碌跳过后的复查间隔：工单一完成就尽快派下一张。 */
const BUSY_RECHECK_MS = 5 * 60 * 1000;

const TaskSchema = z.object({
  id: z.string(),
  provider: z.enum(["gitee", "zentao"]).default("gitee"),
  projectId: z.string(),
  everyHours: z.number().int().min(1).max(24),
  priority: z.enum(["severe", "major", "none"]),
  status: z.enum(["draft", "active", "paused"]),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastResult: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TicketPullTask = z.infer<typeof TaskSchema>;

export interface TicketPullPort {
  listProjects(
    provider: TicketProviderId,
  ): Promise<Array<{ id: string; localPath?: string; cast?: string[] }>>;
  listTodos(
    provider: TicketProviderId,
    projectId: string,
  ): Promise<
    Array<{
      key: string;
      ident: string;
      priority: string;
      topicId?: string;
    }>
  >;
  /** 该项目仍在处理中的已派工单（串行节奏据此跳过本轮）。 */
  inProgressDispatches(
    provider: TicketProviderId,
    projectId: string,
  ): Promise<Array<{ ident: string; topicId: string }>>;
  dispatchToCeo(input: {
    provider: TicketProviderId;
    projectId: string;
    issueKey: string;
  }): Promise<unknown>;
}

export class TicketPullScheduleService {
  private tasks: TicketPullTask[] = [];
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastExpediteAt = 0;
  private readonly idleDebounceMs: number;

  constructor(
    private readonly dataDir: string,
    private readonly tickets: TicketPullPort,
    options?: { idleDebounceMs?: number },
  ) {
    this.idleDebounceMs = options?.idleDebounceMs ?? 5_000;
  }

  startLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * 顺序推送：已派工单的话题一空闲就尽快派下一张。防抖 5 秒合并
   * 接力间隙与连发空闲，30 秒底噪防止风暴；真正的「仍在处理中」
   * 复查在 pull 内部兜底（接力间隙不会误派）。
   */
  notifyTopicIdle(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.expedite();
    }, this.idleDebounceMs);
    this.idleTimer.unref?.();
  }

  private async expedite(): Promise<void> {
    const now = Date.now();
    if (now - this.lastExpediteAt < 30_000) return;
    this.lastExpediteAt = now;
    await this.ensure();
    let touched = false;
    for (const task of this.tasks) {
      if (task.status !== "active") continue;
      if (task.nextRunAt && new Date(task.nextRunAt).getTime() > now) {
        task.nextRunAt = new Date(now).toISOString();
        touched = true;
      }
    }
    if (touched) await this.save();
    await this.tick(now);
  }

  async list(): Promise<TicketPullTask[]> {
    await this.ensure();
    return this.tasks.map((task) => ({ ...task }));
  }

  async add(input: {
    provider: TicketProviderId;
    projectId: string;
    everyHours: number;
    priority: PullPriority;
  }): Promise<TicketPullTask> {
    await this.ensure();
    const everyHours = input.everyHours;
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 24) {
      throw new Error("间隔须为 1 到 24 小时");
    }
    if (!["severe", "major", "none"].includes(input.priority)) {
      throw new Error("优先级不正确");
    }
    const projects = await this.tickets.listProjects(input.provider);
    const project = projects.find((item) => item.id === input.projectId);
    if (!project) throw new Error("找不到这个工单项目");
    if (
      this.tasks.some(
        (task) =>
          task.provider === input.provider && task.projectId === project.id,
      )
    ) {
      throw new Error("该项目已有定时任务");
    }
    const now = new Date().toISOString();
    const task: TicketPullTask = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      provider: input.provider,
      projectId: project.id,
      everyHours,
      priority: input.priority,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    await this.save();
    return { ...task };
  }

  async start(id: string, now = new Date()): Promise<TicketPullTask> {
    const task = await this.require(id);
    if (task.status === "active") return { ...task };
    task.status = "active";
    task.nextRunAt = new Date(
      now.getTime() + task.everyHours * HOUR_MS,
    ).toISOString();
    task.updatedAt = now.toISOString();
    await this.save();
    return { ...task };
  }

  async pause(id: string): Promise<TicketPullTask> {
    const task = await this.require(id);
    if (task.status === "draft") throw new Error("任务尚未开始");
    task.status = "paused";
    task.updatedAt = new Date().toISOString();
    await this.save();
    return { ...task };
  }

  async resume(id: string, now = new Date()): Promise<TicketPullTask> {
    const task = await this.require(id);
    if (task.status === "draft") throw new Error("任务尚未开始");
    task.status = "active";
    task.nextRunAt = new Date(
      now.getTime() + task.everyHours * HOUR_MS,
    ).toISOString();
    task.updatedAt = now.toISOString();
    await this.save();
    return { ...task };
  }

  async run(id: string): Promise<TicketPullTask> {
    const task = await this.require(id);
    await this.execute(task, "manual");
    return { ...task };
  }

  async remove(id: string): Promise<void> {
    await this.ensure();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    if (this.tasks.length === before) throw new Error("找不到这条定时任务");
    await this.save();
  }

  async tick(now = Date.now()): Promise<void> {
    await this.ensure();
    for (const task of this.tasks) {
      if (task.status !== "active" || !task.nextRunAt) continue;
      if (new Date(task.nextRunAt).getTime() > now) continue;
      await this.execute(task, "scheduled", new Date(now));
    }
  }

  private async execute(
    task: TicketPullTask,
    reason: "manual" | "scheduled",
    at = new Date(),
  ): Promise<void> {
    if (this.running.has(task.id)) throw new Error("这条定时任务正在执行");
    this.running.add(task.id);
    try {
      if (reason === "scheduled") {
        task.nextRunAt = new Date(
          at.getTime() + task.everyHours * HOUR_MS,
        ).toISOString();
        task.updatedAt = at.toISOString();
        await this.save();
      }
      task.lastResult = await this.pull(task);
      // 忙碌跳过时不用干等整个间隔：短间隔轮询，完成即可派下一张。
      if (
        reason === "scheduled" &&
        task.lastResult.includes("本轮跳过") &&
        task.status === "active"
      ) {
        task.nextRunAt = new Date(
          at.getTime() + BUSY_RECHECK_MS,
        ).toISOString();
      }
      task.lastRunAt = at.toISOString();
      task.updatedAt = at.toISOString();
    } catch (error) {
      task.lastRunAt = at.toISOString();
      task.updatedAt = at.toISOString();
      task.lastResult =
        error instanceof Error ? error.message : "执行失败";
      if (reason === "manual") throw error;
    } finally {
      this.running.delete(task.id);
      await this.save();
    }
  }

  private async pull(task: TicketPullTask): Promise<string> {
    const projects = await this.tickets.listProjects(task.provider);
    const project = projects.find((item) => item.id === task.projectId);
    if (!project) throw new Error("找不到这个工单项目");
    if (!project.localPath?.trim()) {
      throw new Error("请先在工单项目配置中填写本地工作目录");
    }
    const todos = await this.tickets.listTodos(task.provider, task.projectId);
    // 串行节奏：上一张派出的工单还没处理完（话题里有活跃运行）就不派新的，
    // 等下一轮再看 —— 一张处理完再派下一张，避免同时起多个 CLI 进程。
    const inProgress = await this.tickets.inProgressDispatches(
      task.provider,
      task.projectId,
    );
    if (inProgress.length > 0) {
      const idents = inProgress.map((item) => item.ident).join("、");
      return `上一张工单仍在处理中（${idents}），本轮跳过；完成后再派下一张`;
    }
    const matched = todos
      .filter(
        (todo) =>
          !todo.topicId &&
          !todo.held &&
          matchesPullPriority(todo.priority, task.priority),
      )
      .sort(comparePriorityThenIdent);
    const next = matched[0];
    if (!next) {
      // 全被「暂不处理」挡住时说明状态可解释，不算异常
      const heldCount = todos.filter((t) => t.held && !t.topicId).length;
      return `拉到 ${todos.length} 张，暂无符合优先级的新工单${
        heldCount > 0 ? `（${heldCount} 张已标记暂不处理）` : ""
      }`;
    }
    try {
      const result = (await this.tickets.dispatchToCeo({
        provider: task.provider,
        projectId: task.projectId,
        issueKey: next.key,
      })) as { done?: Promise<void> } | undefined;
      // 等后台收尾（附图下载、起运行）完成再结束本轮，串行判定才准确
      await result?.done;
    } catch (error) {
      const message = error instanceof Error ? error.message : "派发失败";
      return `拉到 ${todos.length} 张，派 ${next.ident} 失败：${message}`;
    }
    return `拉到 ${todos.length} 张，派出 1 张（${next.ident}）；处理完成后下一轮再派`;
  }

  private async require(id: string): Promise<TicketPullTask> {
    await this.ensure();
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error("找不到这条定时任务");
    return task;
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.dataDir, { recursive: true });
    this.tasks = await readTasks(join(this.dataDir, "ticket-pulls.json"));
  }

  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      join(this.dataDir, "ticket-pulls.json"),
      `${JSON.stringify(this.tasks, null, 2)}\n`,
    );
  }
}

async function readTasks(file: string): Promise<TicketPullTask[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const result = TaskSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
