import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ZentaoClient,
  zentaoUserAccount,
  type ZentaoTask,
  type ZentaoBug,
} from "../zentao/client.js";
import { resolveZentaoCredentials, zentaoConfigured } from "../zentao/credentials.js";
import {
  ZentaoProjectsStore,
  type ZentaoProjectSettings,
} from "../zentao/projects.js";
import type {
  DownloadedImage,
  TicketDetail,
  TicketKind,
  TicketProvider,
  TicketProject,
  TicketProjectSettingsPatch,
  TicketStateOption,
  TicketSummary,
} from "./provider.js";

const TASK_STATES: Array<TicketStateOption & { status: string }> = [
  { id: 1, title: "待开始", status: "wait" },
  { id: 2, title: "进行中", status: "doing" },
  { id: 3, title: "已暂停", status: "pause" },
  { id: 4, title: "已完成", status: "done" },
  { id: 5, title: "已取消", status: "cancel" },
  { id: 6, title: "已关闭", status: "closed" },
];

const BUG_STATES: Array<TicketStateOption & { status: string }> = [
  { id: 1, title: "激活", status: "active" },
  { id: 2, title: "已解决", status: "resolved" },
  { id: 3, title: "已关闭", status: "closed" },
];

/** ZenTao pri 1..4 → shared priority vocabulary (ADR-0007). */
const PRIORITY_BY_PRI: Record<number, { label: string; rank: number }> = {
  1: { label: "紧急", rank: 0 },
  2: { label: "严重", rank: 10 },
  3: { label: "主要", rank: 20 },
  4: { label: "次要", rank: 30 },
};

const TODO_TASK_STATUSES = new Set(["wait", "doing"]);

function priorityOf(pri: number | undefined): { label: string; rank: number } {
  return PRIORITY_BY_PRI[pri ?? 3] ?? PRIORITY_BY_PRI[3]!;
}

function parseIssueKey(
  issueKey: string,
): { kind: TicketKind; id: number } {
  const match = issueKey.trim().match(/^(BUG|TASK)-(\d+)$/i);
  if (!match) {
    throw new Error(
      `禅道工单标识格式应为 BUG-数字 或 TASK-数字（收到: ${issueKey}）`,
    );
  }
  return {
    kind: match[1]!.toLowerCase() === "bug" ? "bug" : "task",
    id: Number(match[2]),
  };
}

/** Pull <img src>/markdown image targets out of a ZenTao description. */
export function extractZentaoImageUrls(
  description: string | undefined,
  baseUrl: string,
): string[] {
  if (!description) return [];
  const sources: string[] = [];
  const imgTag = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of description.matchAll(imgTag)) {
    const src = match[1] ?? match[2] ?? match[3];
    if (src?.trim()) sources.push(decodeAttr(src.trim()));
  }
  const md = /!\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;
  for (const match of description.matchAll(md)) {
    if (match[1]?.trim()) sources.push(match[1].trim());
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const source of sources) {
    let url: string;
    if (/^https?:\/\//iu.test(source)) {
      url = source;
    } else {
      try {
        url = new URL(source, `${baseUrl}/`).href;
      } catch {
        continue;
      }
    }
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function fileIdFromUrl(url: string): number | undefined {
  const match = url.match(/(?:^|\/)file-(?:read|download)-(\d+)(?:[./?]|$)/iu);
  if (match) return Number(match[1]);
  const api = url.match(/\/api\.php\/v1\/files\/(\d+)(?:[/?#]|$)/iu);
  if (api) return Number(api[1]);
  const query = url.match(/[?&]fileID=(\d+)(?:[&#]|$)/iu);
  if (query) return Number(query[1]);
  return undefined;
}

function extensionForMime(mime: string | undefined): string {
  switch (mime?.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

type ClientFactory = (dataDir: string) => Promise<ZentaoClient>;

/** ZenTao TicketProvider: bugs + tasks assigned to me, per project. */
export class ZentaoTicketProvider implements TicketProvider {
  readonly id = "zentao" as const;
  readonly label = "禅道";

  constructor(
    private readonly dataDir: string,
    private readonly projects: ZentaoProjectsStore,
    private readonly createClient: ClientFactory = async (dataDir) =>
      new ZentaoClient(await resolveZentaoCredentials(dataDir)),
  ) {}

  async status(): Promise<{ configured: boolean; projectsPath: string }> {
    return {
      configured: await zentaoConfigured(this.dataDir),
      projectsPath: join(this.dataDir, "zentao-project-settings.json"),
    };
  }

  async listProjects(): Promise<TicketProject[]> {
    return this.projects.list();
  }

  async getProject(projectId: string): Promise<TicketProject | undefined> {
    return this.projects.get(projectId);
  }

  async updateProjectSettings(
    projectId: string,
    patch: TicketProjectSettingsPatch,
  ): Promise<TicketProject> {
    return this.projects.updateSettings(
      projectId,
      patch as ZentaoProjectSettings,
    );
  }

  async listTodos(
    projectId: string,
    options?: { includeAllStates?: boolean },
  ): Promise<TicketSummary[]> {
    const project = await this.requireProject(projectId);
    const client = await this.createClient(this.dataDir);
    const config = await resolveZentaoCredentials(this.dataDir);
    const projectIdNumber = Number(project.programId);

    const executions = await client
      .listProjectExecutions(projectIdNumber)
      .catch(() => []);
    const executionNames = new Map(executions.map((e) => [e.id, e.name]));

    const tasks: TicketSummary[] = [];
    for (const execution of executions) {
      const rows = await client
        .listExecutionTasks(execution.id)
        .catch(() => []);
      for (const task of rows) {
        if (!zentaoUserAccount(task.assignedTo)?.includes(config.account)) {
          continue;
        }
        if (task.project !== undefined && task.project !== projectIdNumber) {
          continue;
        }
        if (!options?.includeAllStates && !TODO_TASK_STATUSES.has(task.status)) {
          continue;
        }
        tasks.push(taskSummary(task, project.programId, config.baseUrl, execution.name));
      }
    }

    const products = await client
      .listProjectProducts(projectIdNumber)
      .catch(() => []);
    const bugs: TicketSummary[] = [];
    for (const product of products) {
      const rows = await client.listProductBugs(product.id).catch(() => []);
      for (const bug of rows) {
        if (!zentaoUserAccount(bug.assignedTo)?.includes(config.account)) {
          continue;
        }
        if (bug.project !== undefined && bug.project !== projectIdNumber) {
          continue;
        }
        if (!options?.includeAllStates && bug.status !== "active") {
          continue;
        }
        bugs.push(bugSummary(bug, project.programId, config.baseUrl, product.name));
      }
    }

    return [...bugs, ...tasks];
  }

  async getDetail(
    projectId: string,
    issueKey: string,
  ): Promise<TicketDetail> {
    const project = await this.requireProject(projectId);
    const client = await this.createClient(this.dataDir);
    const config = await resolveZentaoCredentials(this.dataDir);
    const { kind, id } = parseIssueKey(issueKey);

    if (kind === "bug") {
      const bug = await client.getBug(id);
      return {
        ...bugSummary(bug, project.programId, config.baseUrl, ""),
        description: bug.steps?.trim() ?? "",
        authorName: zentaoUserAccount(bug.openedBy) ?? "",
        deadline: bug.deadline,
        imageUrls: extractZentaoImageUrls(bug.steps, config.baseUrl),
      };
    }

    const task = await client.getTask(id);
    return {
      ...taskSummary(task, project.programId, config.baseUrl, ""),
      description: task.desc?.trim() ?? "",
      authorName: zentaoUserAccount(task.openedBy) ?? "",
      deadline: task.deadline,
      imageUrls: extractZentaoImageUrls(task.desc, config.baseUrl),
    };
  }

  async listStates(
    _projectId: string,
    issueKey: string,
  ): Promise<TicketStateOption[]> {
    const { kind } = parseIssueKey(issueKey);
    return (kind === "bug" ? BUG_STATES : TASK_STATES).map(({ id, title }) => ({
      id,
      title,
    }));
  }

  async updateState(input: {
    projectId: string;
    issueKey: string;
    stateId: number;
  }): Promise<{ stateId: number; stateTitle: string }> {
    await this.requireProject(input.projectId);
    const client = await this.createClient(this.dataDir);
    const { kind, id } = parseIssueKey(input.issueKey);

    if (kind === "task") {
      const target = TASK_STATES.find((state) => state.id === input.stateId);
      if (!target) throw new Error(`未知任务状态: ${input.stateId}`);
      await client.updateTaskStatus(id, target.status);
      return { stateId: target.id, stateTitle: target.title };
    }

    const target = BUG_STATES.find((state) => state.id === input.stateId);
    if (!target) throw new Error(`未知 Bug 状态: ${input.stateId}`);
    if (target.status === "resolved") {
      await client.resolveBug(id);
    } else if (target.status === "closed") {
      await client.closeBug(id);
    } else {
      await client.activateBug(id);
    }
    return { stateId: target.id, stateTitle: target.title };
  }

  async downloadImages(input: {
    localPath: string;
    ident: string;
    urls: string[];
  }): Promise<DownloadedImage[]> {
    const client = await this.createClient(this.dataDir);
    const out: DownloadedImage[] = [];
    for (const url of input.urls) {
      const fileId = fileIdFromUrl(url);
      if (fileId === undefined) {
        out.push({ url, error: "非禅道附件链接，请在详情中打开原图" });
        continue;
      }
      try {
        const file = await client.downloadFile(fileId);
        const dir = join(input.localPath, ".zy-aos", "tickets", input.ident);
        await mkdir(dir, { recursive: true });
        const name = `${String(out.length + 1).padStart(2, "0")}.${extensionForMime(file.mime)}`;
        const localPath = join(dir, name);
        await writeFile(localPath, file.bytes);
        out.push({ url, localPath });
      } catch (error) {
        out.push({
          url,
          error: error instanceof Error ? error.message : "下载失败",
        });
      }
    }
    return out;
  }

  private async requireProject(projectId: string): Promise<TicketProject> {
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`禅道项目不存在: ${projectId}`);
    return project;
  }
}

function taskSummary(
  task: ZentaoTask,
  programId: string,
  baseUrl: string,
  executionName: string,
): TicketSummary {
  const priority = priorityOf(task.pri);
  return {
    key: `TASK-${task.id}`,
    id: task.id,
    ident: `TASK-${task.id}`,
    title: task.name,
    stateTitle:
      TASK_STATES.find((state) => state.status === task.status)?.title ??
      task.status,
    sprintTitle: executionName,
    programId,
    url: `${baseUrl}/task-view-${task.id}.html`,
    priority: priority.label,
    priorityRank: priority.rank,
    kind: "task",
  };
}

function bugSummary(
  bug: ZentaoBug,
  programId: string,
  baseUrl: string,
  productName: string,
): TicketSummary {
  const priority = priorityOf(bug.pri ?? bug.severity);
  return {
    key: `BUG-${bug.id}`,
    id: bug.id,
    ident: `BUG-${bug.id}`,
    title: bug.title,
    stateTitle:
      BUG_STATES.find((state) => state.status === bug.status)?.title ??
      bug.status,
    sprintTitle: productName,
    programId,
    url: `${baseUrl}/bug-view-${bug.id}.html`,
    priority: priority.label,
    priorityRank: priority.rank,
    kind: "bug",
  };
}
