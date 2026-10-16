import { resolve } from "node:path";
import {
  getIssueDetail,
  giteeConfigured,
  listIssueTypeStates,
  listMyTodoIssues,
  readGiteeEnvConfig,
  updateIssueState as giteeUpdateIssueState,
} from "../gitee/client.js";
import { downloadIssueImages } from "../gitee/issue-assets.js";
import {
  GiteeProjectsStore,
  type GiteeProjectConfig,
  type ProjectRuntimeSettings,
} from "../gitee/projects.js";
import { findWorkspaceRoot } from "../load-env.js";
import type {
  DownloadedImage,
  TicketDetail,
  TicketProvider,
  TicketProject,
  TicketProjectSettingsPatch,
  TicketStateOption,
  TicketSummary,
} from "./provider.js";

function toTicketProject(project: GiteeProjectConfig): TicketProject {
  return { ...project, programId: String(project.programId) };
}

function parseNumericIssueKey(issueKey: string): number {
  const key = issueKey.trim();
  if (!/^\d+$/.test(key)) {
    throw new Error(
      `工单详情需使用数字 id（收到: ${key}）。请从列表点击工单卡片。`,
    );
  }
  return Number(key);
}

/** Enrolls the existing gitee/* modules behind the TicketProvider contract. */
export class GiteeTicketProvider implements TicketProvider {
  readonly id = "gitee" as const;
  readonly label = "Gitee";

  constructor(private readonly projects: GiteeProjectsStore) {}

  async status(): Promise<{ configured: boolean; projectsPath: string }> {
    return {
      configured: giteeConfigured(),
      projectsPath:
        process.env.GITEE_PROJECTS_CONFIG?.trim() ||
        resolve(findWorkspaceRoot(), "config", "gitee-projects.json"),
    };
  }
  async listProjects(): Promise<TicketProject[]> {
    return (await this.projects.list()).map(toTicketProject);
  }

  async getProject(projectId: string): Promise<TicketProject | undefined> {
    const project = await this.projects.get(projectId);
    return project ? toTicketProject(project) : undefined;
  }

  async updateProjectSettings(
    projectId: string,
    patch: TicketProjectSettingsPatch,
  ): Promise<TicketProject> {
    const updated = await this.projects.updateSettings(
      projectId,
      patch as ProjectRuntimeSettings,
    );
    return toTicketProject(updated);
  }

  async listTodos(
    projectId: string,
    options?: { includeAllStates?: boolean },
  ): Promise<TicketSummary[]> {
    const project = await this.requireProject(projectId);
    const issues = await listMyTodoIssues({
      programId: project.programId,
      includeAllStates: options?.includeAllStates,
    });
    return issues.map((issue) => ({
      ...issue,
      key: String(issue.id),
      programId: issue.programId,
    }));
  }

  async getDetail(projectId: string, issueKey: string): Promise<TicketDetail> {
    await this.requireProject(projectId);
    const detail = await getIssueDetail(parseNumericIssueKey(issueKey));
    return { ...detail, key: String(detail.id) };
  }

  async listStates(
    projectId: string,
    issueKey: string,
  ): Promise<TicketStateOption[]> {
    await this.requireProject(projectId);
    const detail = await getIssueDetail(parseNumericIssueKey(issueKey));
    if (detail.issueTypeId == null) {
      throw new Error("工单缺少 issue_type，无法列状态");
    }
    return listIssueTypeStates(detail.issueTypeId);
  }

  async updateState(input: {
    projectId: string;
    issueKey: string;
    stateId: number;
  }): Promise<{ stateId: number; stateTitle: string }> {
    await this.requireProject(input.projectId);
    return giteeUpdateIssueState({
      issueId: parseNumericIssueKey(input.issueKey),
      issueStateId: input.stateId,
    });
  }

  async downloadImages(input: {
    localPath: string;
    ident: string;
    urls: string[];
  }): Promise<DownloadedImage[]> {
    return downloadIssueImages({
      config: readGiteeEnvConfig(),
      localPath: input.localPath,
      ident: input.ident,
      urls: input.urls,
    });
  }

  private async requireProject(projectId: string): Promise<TicketProject> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Gitee 项目不存在: ${projectId}`);
    return project;
  }
}
