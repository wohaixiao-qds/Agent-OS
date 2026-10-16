import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store/json-store.js";
import type { BotRunService } from "./bot-run-service.js";
import type { BotService } from "./bot-service.js";
import type { ChatService } from "./chat-service.js";
import type { WorkspaceService } from "./workspace-service.js";
import { TaskBoardService, boardTaskIdForTicket } from "./task-board-service.js";
import { TicketDispatchStore } from "./ticket-dispatches.js";
import type {
  TicketProvider,
  TicketProviderId,
  TicketProject,
  TicketProjectSettingsPatch,
  TicketStateOption,
  TicketSummary,
  TicketDetail,
} from "../tickets/provider.js";

export type TicketListItem = TicketSummary & {
  topicId?: string;
  pipelineStage?: string;
};

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export class TicketService {
  private readonly dispatches: TicketDispatchStore;
  private readonly taskBoard: TaskBoardService;

  constructor(
    private readonly dataDir: string,
    private readonly store: JsonStore,
    private readonly workspaceService: WorkspaceService,
    private readonly botService: BotService,
    private readonly chatService: ChatService,
    private readonly botRunService: BotRunService,
    providers: Partial<Record<TicketProviderId, TicketProvider>>,
    taskBoard?: TaskBoardService,
  ) {
    this.providers = providers;
    this.taskBoard = taskBoard ?? new TaskBoardService(dataDir);
    this.dispatches = new TicketDispatchStore(dataDir);
  }

  private readonly providers: Partial<
    Record<TicketProviderId, TicketProvider>
  >;

  private provider(providerId: string): TicketProvider {
    const provider = this.providers[providerId as TicketProviderId];
    if (!provider) throw new Error(`未知工单来源: ${providerId}`);
    return provider;
  }

  async status(): Promise<{
    providers: Array<{
      id: TicketProviderId;
      label: string;
      configured: boolean;
      projectsPath?: string;
    }>;
  }> {
    const providers = Object.values(this.providers).filter(
      (p): p is TicketProvider => Boolean(p),
    );
    return {
      providers: await Promise.all(
        providers.map(async (p) => ({
          ...(await p.status()),
          id: p.id,
          label: p.label,
        })),
      ),
    };
  }

  listProjects(providerId: string): Promise<TicketProject[]> {
    return this.provider(providerId).listProjects();
  }

  /**
   * 该项目派出的工单中仍在处理的（话题里有活跃 CLI 运行）。
   * 定时拉单据此实现「完成一张再派下一张」的串行节奏。
   */
  async inProgressDispatches(
    providerId: string,
    projectId: string,
  ): Promise<Array<{ ident: string; topicId: string }>> {
    const all = await this.dispatches.loadAll();
    const inProgress: Array<{ ident: string; topicId: string }> = [];
    for (const record of all.values()) {
      if (record.provider !== providerId || record.projectId !== projectId) {
        continue;
      }
      if (this.botRunService.isTopicBusy(record.topicId)) {
        inProgress.push({
          ident: record.ident ?? record.issueKey,
          topicId: record.topicId,
        });
      }
    }
    return inProgress;
  }

  updateProject(
    providerId: string,
    projectId: string,
    patch: TicketProjectSettingsPatch,
  ): Promise<TicketProject> {
    return this.provider(providerId).updateProjectSettings(projectId, patch);
  }

  async listTodos(
    providerId: string,
    projectId: string,
    options?: { includeAllStates?: boolean },
  ): Promise<TicketListItem[]> {
    const provider = this.provider(providerId);
    const todos = await provider.listTodos(projectId, options);
    const state = await this.store.load();
    return Promise.all(
      todos.map(async (todo) => {
        const record = await this.dispatches.find(provider.id, todo.key);
        const topic = record
          ? state.topics.find((t) => t.id === record.topicId)
          : undefined;
        return {
          ...todo,
          topicId: record?.topicId,
          pipelineStage: topic?.pipelineStage,
        };
      }),
    );
  }

  getTodoDetail(
    providerId: string,
    projectId: string,
    issueKey: string,
  ): Promise<TicketDetail> {
    return this.provider(providerId).getDetail(projectId, issueKey);
  }

  /** 鉴权来源的附件代理（工单详情内图片显示用）。 */
  async fetchAttachment(
    providerId: string,
    url: string,
  ): Promise<{ bytes: Buffer; mime?: string }> {
    const provider = this.provider(providerId);
    if (!provider.fetchAttachment) {
      throw new Error(`${provider.label} 附件无需代理，请直接访问原地址`);
    }
    return provider.fetchAttachment(url);
  }

  async listIssueStates(
    providerId: string,
    projectId: string,
    issueKey: string,
  ): Promise<TicketStateOption[]> {
    return this.provider(providerId).listStates(projectId, issueKey);
  }

  async updateIssueState(input: {
    provider: TicketProviderId;
    projectId: string;
    issueKey: string;
    issueStateId: number;
  }): Promise<{ stateTitle: string; stateId: number }> {
    const provider = this.provider(input.provider);
    const project = await provider.getProject(input.projectId);
    if (!project) {
      throw new Error(`${provider.label} 项目不存在: ${input.projectId}`);
    }
    const detail = await provider.getDetail(
      input.projectId,
      input.issueKey,
    );
    if (String(detail.programId) !== String(project.programId)) {
      throw new Error(
        `工单不属于当前项目：issue programId=${detail.programId}, project programId=${project.programId}`,
      );
    }

    const result = await provider.updateState({
      projectId: input.projectId,
      issueKey: input.issueKey,
      stateId: input.issueStateId,
    });

    let stateTitle = result.stateTitle.trim();
    if (!stateTitle) {
      try {
        const states = await provider.listStates(
          input.projectId,
          input.issueKey,
        );
        stateTitle =
          states.find((s) => s.id === result.stateId)?.title ??
          states.find((s) => s.id === input.issueStateId)?.title ??
          "";
      } catch {
        // keep empty title if lookup fails
      }
    }

    const synced = { stateId: result.stateId, stateTitle };
    const boardRow = await this.taskBoard.findByExternalIssue(
      provider.id,
      detail.ident,
    );
    if (boardRow) {
      await this.taskBoard.recordExternalSync(boardRow.id, {
        id: synced.stateId,
        title: synced.stateTitle,
      });
    }
    return synced;
  }

  async dispatchToCeo(input: {
    provider: TicketProviderId;
    projectId: string;
    issueKey: string;
    workspaceId?: string;
    note?: string;
  }): Promise<{ topicId: string; botId: string }> {
    const provider = this.provider(input.provider);
    const project = await provider.getProject(input.projectId);
    if (!project) {
      throw new Error(`${provider.label} 项目不存在: ${input.projectId}`);
    }
    if (!project.localPath?.trim()) {
      throw new Error("请先在工单项目配置中填写本地工作目录");
    }

    const detail = await provider.getDetail(
      input.projectId,
      input.issueKey,
    );
    if (!detail) throw new Error(`找不到工单 ${input.issueKey}`);

    const workspace = await this.resolveWorkspace(
      project.localPath,
      project.name,
      input.workspaceId,
    );

    const bots = await this.botService.list();
    const ceo = bots.find(
      (b) => b.enabled && b.role.toLowerCase() === "ceo",
    );
    if (!ceo) throw new Error("未找到已启用的 CEO 助理");

    const downloads = await provider.downloadImages({
      projectId: input.projectId,
      localPath: project.localPath,
      ident: detail.ident,
      urls: detail.imageUrls,
    });

    const topic = await this.chatService.createTopic({
      workspaceId: workspace.id,
      title: `${detail.ident} ${detail.title}`.slice(0, 120),
    });

    const castMembers = bots.filter(
      (bot) =>
        bot.enabled &&
        project.cast.some(
          (token) =>
            token === bot.id ||
            token.toLowerCase() === bot.role.toLowerCase(),
        ),
    );
    const castLabel =
      project.cast.length === 0
        ? "全团队（未限制 Cast）"
        : castMembers.length > 0
          ? castMembers
              .map((bot) => `${bot.name}（targetBotId=${bot.id}）`)
              .join("、")
          : project.cast.join("、");
    // prompt 里的 targetBotId 是 CEO 调 dispatch_task 需要的；聊天系统消息只展示名字。
    const castDisplay =
      project.cast.length === 0
        ? "全团队（未限制 Cast）"
        : castMembers.length > 0
          ? castMembers.map((bot) => bot.name).join("、")
          : project.cast.join("、");
    const castHas = (role: string) =>
      castMembers.some((bot) => bot.role.toLowerCase() === role);

    const descriptionBlock = detail.description.trim()
      ? detail.description.trim()
      : "（无描述）";

    const summaryText = detail.description.trim();
    const userNote = input.note?.trim() ?? "";
    const noteBlock = userNote
      ? ["", "—— 用户补充 ——", userNote]
      : [];

    const imageLines =
      downloads.length === 0
        ? ["附图：无"]
        : [
            "附图（本地优先，失败则用 URL）：",
            ...downloads.map((item, i) => {
              if (item.localPath) {
                return `  ${i + 1}. ${item.localPath}`;
              }
              return `  ${i + 1}. [下载失败: ${item.error ?? "unknown"}] ${item.url}`;
            }),
          ];

    const prompt = [
      `用户从 ${provider.label} 待办中选中了一条工单，请你作为 CEO 助理组织后续工作。`,
      `项目：${project.name}（${project.ident ?? project.programId}）`,
      `迭代：${detail.sprintTitle || "（无迭代信息）"}`,
      `工作项：${detail.ident}`,
      `标题：${detail.title}`,
      `链接：${detail.url}`,
      `工作目录：${project.localPath}`,
      `默认引擎：${project.defaultEngine}`,
      `参与 Cast：${castLabel}`,
      "",
      "—— 工单描述 ——",
      descriptionBlock,
      ...noteBlock,
      "",
      ...imageLines,
      "",
      project.cast.length > 0
        ? `约束：后续 dispatch_task 只能派给 Cast 内成员（${castLabel}）；不要派给名单外成员。`
        : "可按需派给 product / developer / tester / reviewer。",
      castHas("developer") && !castHas("product")
        ? "这是已指派的缺陷/工程工单且 Cast 含 developer、不含 product：读完描述后必须立刻调用 dispatch_task，targetBotId=developer（可用 objective/instruction 写清修复点）。禁止长篇分析后让用户手工开工。"
        : "请先阅读描述与附图（及用户补充，若有），确认范围后立刻调用 dispatch_task；新需求优先 product，已明确的修复任务优先 developer。",
      "禁止写「启动流水线」或让用户点不存在的按钮；口头「已交给某某」无效。不要自己写代码。",
    ].join("\n");

    await this.store.transact((state) => {
      state.messages.push({
        id: randomUUID(),
        topicId: topic.id,
        author: "system",
        content: [
          `[${provider.id}] 已接入工单 ${detail.ident}`,
          detail.url,
          `项目目录：${project.localPath}`,
          `引擎：${project.defaultEngine}`,
          `Cast：${castDisplay}`,
          summaryText
            ? `描述摘要：${summaryText.slice(0, 240)}`
            : "描述：（无描述）",
          userNote ? `用户补充：${userNote.slice(0, 240)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        createdAt: new Date().toISOString(),
        ticketIntake: {
          provider: provider.id,
          providerLabel: provider.label,
          ident: detail.ident,
          title: detail.title,
          url: detail.url,
          localPath: project.localPath,
          engine: project.defaultEngine,
          cast: castDisplay,
          summary: summaryText ? summaryText.slice(0, 240) : undefined,
          note: userNote ? userNote.slice(0, 240) : undefined,
        },
      });
    });

    // Must be "chat" (not "handoff"): handoff marks inCollaboration and skips
    // team-leader-guard, so CEO can dump analysis without dispatch_task.
    // clearSession: avoid resuming a prior analysis session that never dispatched.
    await this.botRunService.start({
      topicId: topic.id,
      botId: ceo.id,
      origin: "chat",
      clearSession: true,
      prompt,
    });

    await this.dispatches.save({
      provider: provider.id,
      issueId: detail.id,
      issueKey: detail.key,
      ident: detail.ident,
      projectId: project.id,
      topicId: topic.id,
      cast: project.cast,
      localPath: project.localPath,
      engine: project.defaultEngine,
      at: new Date().toISOString(),
    });

    await this.taskBoard.upsert({
      id: boardTaskIdForTicket(
        provider.id,
        String(detail.programId),
        detail.ident,
      ),
      title: `${detail.ident} ${detail.title}`.slice(0, 200),
      status: "running",
      source: provider.id,
      external: {
        provider: provider.id,
        projectId: String(detail.programId),
        issueId: detail.id,
        issueIdent: detail.ident,
        url: detail.url,
        issueTypeId: detail.issueTypeId,
      },
      topicId: topic.id,
      botId: ceo.id,
      stage: topic.pipelineStage ?? "idle",
    });

    return { topicId: topic.id, botId: ceo.id };
  }

  private async resolveWorkspace(
    localPath: string,
    projectName: string,
    preferredId?: string,
  ) {
    const workspaces = await this.workspaceService.list();
    if (preferredId) {
      const preferred = workspaces.find((w) => w.id === preferredId);
      if (preferred && pathKey(preferred.localPath) === pathKey(localPath)) {
        return preferred;
      }
    }
    const matched = workspaces.find(
      (w) => pathKey(w.localPath) === pathKey(localPath),
    );
    if (matched) return matched;
    return this.workspaceService.create({
      name: projectName,
      localPath,
    });
  }
}
