/**
 * Ticket provider contract (ADR-0007). Gitee and ZenTao implement the same
 * surface so TicketService, pulls, board and the inbox UI stay provider-blind.
 */

export type TicketProviderId = "gitee" | "zentao";

export type TicketProjectSettingsPatch = {
  localPath?: string;
  defaultEngine?: "claude" | "codex";
  cast?: string[];
  testBaseUrl?: string;
  testStartCommand?: string;
};

export interface TicketProject {
  id: string;
  name: string;
  ident?: string;
  /** Provider-side project id (Gitee programId / ZenTao projectId). */
  programId: string;
  localPath?: string;
  defaultEngine: "claude" | "codex";
  /** Bot ids, or legacy role names. Empty = whole team. */
  cast: string[];
  testBaseUrl?: string;
  testStartCommand?: string;
  /** True when the row came from the provider API rather than local JSON. */
  fromRemote?: boolean;
}

export type TicketKind = "bug" | "task";

export interface TicketSummary {
  /** Stable key for detail/state/dispatch calls. Gitee: String(id); ZenTao: BUG-/TASK- ident. */
  key: string;
  id: number;
  ident: string;
  title: string;
  stateTitle: string;
  sprintId?: string;
  sprintTitle: string;
  programId: number | string;
  url: string;
  priority: string;
  priorityRank?: number;
  /** ZenTao rows carry their object kind for badges and state mapping. */
  kind?: TicketKind;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  authorName: string;
  planStartedAt?: string;
  deadline?: string;
  /** 原始图片地址（派发下载、浏览器打开原图用）。 */
  imageUrls: string[];
  /** 展示用图片地址（需鉴权的来源走本地代理路由）。与 imageUrls 一一对应。 */
  imageSrcs?: string[];
  /** Gitee issue-type states need it; ZenTao ignores. */
  issueTypeId?: number;
}

export interface TicketStateOption {
  id: number;
  title: string;
}

export interface DownloadedImage {
  url: string;
  localPath?: string;
  error?: string;
}

export interface TicketProvider {
  readonly id: TicketProviderId;
  readonly label: string;
  status(): Promise<{ configured: boolean; projectsPath?: string }>;
  listProjects(): Promise<TicketProject[]>;
  getProject(projectId: string): Promise<TicketProject | undefined>;
  updateProjectSettings(
    projectId: string,
    patch: TicketProjectSettingsPatch,
  ): Promise<TicketProject>;
  listTodos(
    projectId: string,
    options?: { includeAllStates?: boolean },
  ): Promise<TicketSummary[]>;
  getDetail(projectId: string, issueKey: string): Promise<TicketDetail>;
  listStates(
    projectId: string,
    issueKey: string,
  ): Promise<TicketStateOption[]>;
  updateState(input: {
    projectId: string;
    issueKey: string;
    stateId: number;
  }): Promise<{ stateId: number; stateTitle: string }>;
  downloadImages(input: {
    projectId: string;
    localPath: string;
    ident: string;
    urls: string[];
  }): Promise<DownloadedImage[]>;
  /** 按原始 URL 取附件内容（鉴权来源的图片显示代理）。可不实现。 */
  fetchAttachment?(url: string): Promise<{ bytes: Buffer; mime?: string }>;
}
