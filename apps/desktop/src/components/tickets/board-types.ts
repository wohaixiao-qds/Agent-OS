/** Task board + Gitee issue state types for desktop API. */

export type BoardTaskStatus = "running" | "completed" | "failed";

export type BoardFailureReason =
  | "cli_crash"
  | "user_reject"
  | "timeout"
  | "pipeline_blocked"
  | "unknown";

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

/** Provider-agnostic ticket reference (ADR-0007). */
export interface BoardExternalRef {
  provider: "gitee" | "zentao";
  projectId: string;
  issueId?: number;
  issueIdent: string;
  url: string;
  lastSyncedStateId?: number;
  lastSyncedStateTitle?: string;
  lastSyncedAt?: string;
}

export interface BoardTask {
  id: string;
  title: string;
  status: BoardTaskStatus;
  source: "gitee" | "zentao" | "pipeline" | "direct";
  gitee?: BoardGiteeRef;
  /** 来源工单引用（ADR-0007）；gitee 行同时保留镜像字段。 */
  external?: BoardExternalRef;
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

export interface BoardSummary {
  running: number;
  completed: number;
  failed: number;
  tokensToday: number;
}

export interface TicketIssueState {
  id: number;
  title: string;
}

export interface TicketIssueStateUpdate {
  stateId: number;
  stateTitle: string;
}
