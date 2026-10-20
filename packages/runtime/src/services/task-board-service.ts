import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { TicketProviderId } from "../tickets/provider.js";

export type BoardTaskStatus = "running" | "completed" | "failed";
export type BoardFailureReason =
  | "cli_crash"
  | "user_reject"
  | "timeout"
  | "pipeline_blocked"
  | "unknown";

/** Provider-agnostic ticket reference on a board row (ADR-0007). */
export interface BoardExternalRef {
  provider: TicketProviderId;
  /** Gitee programId / ZenTao projectId. */
  projectId: string;
  issueId?: number;
  issueIdent: string;
  url: string;
  issueTypeId?: number;
  lastSyncedStateId?: number;
  lastSyncedStateTitle?: string;
  lastSyncedAt?: string;
}

/** @deprecated Pre-ADR-0007 shape; still written as a mirror for old builds. */
export interface BoardGiteeRef {
  programId: string;
  issueId: number;
  issueIdent: string;
  url: string;
  issueTypeId?: number;
  lastSyncedStateId?: number;
  lastSyncedStateTitle?: string;
  lastSyncedAt?: string;
}

export interface BoardTask {
  id: string;
  title: string;
  status: BoardTaskStatus;
  source: TicketProviderId | "pipeline" | "direct";
  external?: BoardExternalRef;
  /** @deprecated Mirror of external for gitee rows; read-only. */
  gitee?: BoardGiteeRef;
  topicId?: string;
  pipelineId?: string;
  botId?: string;
  stage?: string;
  tokens?: { input?: number; output?: number; total?: number };
  failureReason?: BoardFailureReason;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const BoardGiteeRefSchema = z.object({
  programId: z.string(),
  issueId: z.number(),
  issueIdent: z.string(),
  url: z.string(),
  issueTypeId: z.number().optional(),
  lastSyncedStateId: z.number().optional(),
  lastSyncedStateTitle: z.string().optional(),
  lastSyncedAt: z.string().optional(),
});

const BoardExternalRefSchema = z.object({
  provider: z.enum(["gitee", "zentao"]),
  projectId: z.string(),
  issueId: z.number().optional(),
  issueIdent: z.string(),
  url: z.string(),
  issueTypeId: z.number().optional(),
  lastSyncedStateId: z.number().optional(),
  lastSyncedStateTitle: z.string().optional(),
  lastSyncedAt: z.string().optional(),
});

const BoardTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  source: z.enum(["gitee", "zentao", "pipeline", "direct"]),
  external: BoardExternalRefSchema.optional(),
  gitee: BoardGiteeRefSchema.optional(),
  topicId: z.string().optional(),
  pipelineId: z.string().optional(),
  botId: z.string().optional(),
  stage: z.string().optional(),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  failureReason: z
    .enum([
      "cli_crash",
      "user_reject",
      "timeout",
      "pipeline_blocked",
      "unknown",
    ])
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

const BoardFileSchema = z.object({
  tasks: z.array(BoardTaskSchema).default([]),
});

export function boardTaskIdForTicket(
  provider: TicketProviderId,
  projectId: string,
  ident: string,
): string {
  return `${provider}:${projectId}:${ident}`;
}

/** Legacy alias — same output as boardTaskIdForTicket("gitee", …). */
export function boardTaskIdForGitee(programId: string, ident: string): string {
  return boardTaskIdForTicket("gitee", programId, ident);
}

export function boardTaskIdForPipeline(pipelineId: string): string {
  return `pipeline:${pipelineId}`;
}

function isTodayLocal(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function mergeExternal(
  existing: BoardExternalRef | undefined,
  incoming: BoardExternalRef | undefined,
): BoardExternalRef | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;
  return { ...existing, ...incoming };
}

function giteeMirror(external: BoardExternalRef | undefined): BoardGiteeRef | undefined {
  if (external?.provider !== "gitee") return undefined;
  return {
    programId: external.projectId,
    issueId: external.issueId ?? 0,
    issueIdent: external.issueIdent,
    url: external.url,
    issueTypeId: external.issueTypeId,
    lastSyncedStateId: external.lastSyncedStateId,
    lastSyncedStateTitle: external.lastSyncedStateTitle,
    lastSyncedAt: external.lastSyncedAt,
  };
}

/** Map legacy gitee refs onto external; drop the stale mirror before write. */
function normalizeTask(task: BoardTask): BoardTask {
  if (!task.external && task.gitee) {
    task = {
      ...task,
      external: {
        provider: "gitee",
        projectId: task.gitee.programId,
        issueId: task.gitee.issueId,
        issueIdent: task.gitee.issueIdent,
        url: task.gitee.url,
        issueTypeId: task.gitee.issueTypeId,
        lastSyncedStateId: task.gitee.lastSyncedStateId,
        lastSyncedStateTitle: task.gitee.lastSyncedStateTitle,
        lastSyncedAt: task.gitee.lastSyncedAt,
      },
    };
  }
  if (task.source === "gitee" && task.external) {
    task = { ...task, gitee: giteeMirror(task.external) };
  }
  return task;
}

export class TaskBoardService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private boardPath(): string {
    return resolve(this.dataDir, "task-board.json");
  }

  private async loadTasks(): Promise<BoardTask[]> {
    let tasks: BoardTask[];
    try {
      const raw = await readFile(this.boardPath(), "utf8");
      tasks = BoardFileSchema.parse(JSON.parse(raw)).tasks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return tasks.map(normalizeTask);
  }

  private async saveTasks(tasks: BoardTask[]): Promise<void> {
    const path = this.boardPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ tasks }, null, 2)}\n`,
      "utf8",
    );
  }

  private async transact<T>(
    fn: (tasks: BoardTask[]) => T | Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const tasks = await this.loadTasks();
      const result = await fn(tasks);
      await this.saveTasks(tasks);
      return result;
    });
  }

  async list(filter?: { status?: BoardTaskStatus }): Promise<BoardTask[]> {
    const tasks = await this.loadTasks();
    if (!filter?.status) return tasks;
    return tasks.filter((t) => t.status === filter.status);
  }

  async summary(): Promise<{
    running: number;
    completed: number;
    failed: number;
    tokensToday: number;
  }> {
    const tasks = await this.loadTasks();
    let running = 0;
    let completed = 0;
    let failed = 0;
    let tokensToday = 0;
    for (const task of tasks) {
      if (task.status === "running") running++;
      else if (task.status === "completed") completed++;
      else if (task.status === "failed") failed++;
      if (isTodayLocal(task.updatedAt)) {
        tokensToday += task.tokens?.total ?? 0;
      }
    }
    return { running, completed, failed, tokensToday };
  }

  async upsert(
    partial: Omit<BoardTask, "createdAt" | "updatedAt" | "gitee"> & {
      id: string;
      title: string;
      status: BoardTaskStatus;
      source: BoardTask["source"];
      /** Legacy input shape: gitee ref is converted to external. */
      gitee?: BoardGiteeRef;
    },
  ): Promise<BoardTask> {
    return this.transact((tasks) => {
      const now = new Date().toISOString();
      const external =
        partial.external ??
        (partial.gitee
          ? ({
              provider: "gitee",
              projectId: partial.gitee.programId,
              issueId: partial.gitee.issueId,
              issueIdent: partial.gitee.issueIdent,
              url: partial.gitee.url,
              issueTypeId: partial.gitee.issueTypeId,
            } satisfies BoardExternalRef)
          : undefined);
      const index = tasks.findIndex((t) => t.id === partial.id);
      if (index >= 0) {
        const existing = tasks[index]!;
        const merged: BoardTask = normalizeTask({
          ...existing,
          ...partial,
          external: mergeExternal(existing.external, external),
          gitee: undefined,
          createdAt: existing.createdAt,
          updatedAt: now,
        });
        tasks[index] = merged;
        return merged;
      }
      const created: BoardTask = normalizeTask({
        ...partial,
        external,
        gitee: undefined,
        createdAt: now,
        updatedAt: now,
      });
      tasks.push(created);
      return created;
    });
  }

  async markCompleted(
    id: string,
    patch?: Partial<Pick<BoardTask, "stage" | "botId">>,
  ): Promise<BoardTask | undefined> {
    return this.transact((tasks) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) return undefined;
      const existing = tasks[index]!;
      const now = new Date().toISOString();
      const updated: BoardTask = {
        ...existing,
        ...patch,
        status: "completed",
        updatedAt: now,
        completedAt: existing.completedAt ?? now,
      };
      tasks[index] = updated;
      return updated;
    });
  }

  async markFailed(
    id: string,
    reason: BoardFailureReason,
    patch?: Partial<Pick<BoardTask, "stage" | "botId">>,
  ): Promise<BoardTask | undefined> {
    return this.transact((tasks) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) return undefined;
      const existing = tasks[index]!;
      const now = new Date().toISOString();
      const updated: BoardTask = {
        ...existing,
        ...patch,
        status: "failed",
        failureReason: reason,
        updatedAt: now,
      };
      tasks[index] = updated;
      return updated;
    });
  }

  async recordExternalSync(
    id: string,
    state: { id: number; title: string },
  ): Promise<BoardTask | undefined> {
    return this.transact((tasks) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) return undefined;
      const existing = tasks[index]!;
      if (!existing.external) return undefined;
      const now = new Date().toISOString();
      const updated: BoardTask = normalizeTask({
        ...existing,
        updatedAt: now,
        external: {
          ...existing.external,
          lastSyncedStateId: state.id,
          lastSyncedStateTitle: state.title,
          lastSyncedAt: now,
        },
      });
      tasks[index] = updated;
      return updated;
    });
  }

  /** Legacy alias over recordExternalSync. */
  async recordGiteeSync(
    id: string,
    state: { id: number; title: string },
  ): Promise<BoardTask | undefined> {
    return this.recordExternalSync(id, state);
  }

  async findByTopicId(topicId: string): Promise<BoardTask | undefined> {
    const tasks = await this.loadTasks();
    return tasks.find((t) => t.topicId === topicId);
  }

  /** Drop rows bound to a deleted topic (ticket returned to the pool). */
  async removeByTopicId(topicId: string): Promise<boolean> {
    return this.transact((tasks) => {
      const next = tasks.filter((t) => t.topicId !== topicId);
      const removed = next.length !== tasks.length;
      if (removed) {
        tasks.length = 0;
        tasks.push(...next);
      }
      return removed;
    });
  }

  async findByExternalIssue(
    provider: TicketProviderId,
    issueIdent: string,
  ): Promise<BoardTask | undefined> {
    const tasks = await this.loadTasks();
    return tasks.find(
      (t) =>
        t.external?.provider === provider &&
        t.external?.issueIdent === issueIdent,
    );
  }

  /** Legacy alias over findByExternalIssue (matches by numeric issueId). */
  async findByGiteeIssueId(issueId: number): Promise<BoardTask | undefined> {
    const tasks = await this.loadTasks();
    return tasks.find(
      (t) =>
        t.external?.provider === "gitee" && t.external?.issueId === issueId,
    );
  }
}
