/** UI types for the ticket inbox (API wiring later). */

export type TicketEngine = "claude" | "codex";

export type TicketRole =
  | "ceo"
  | "product"
  | "developer"
  | "tester"
  | "reviewer";

export type TicketPipelineStage =
  | "idle"
  | "developing"
  | "testing"
  | "reviewing"
  | "completed"
  | "blocked";

export interface TicketProject {
  id: string;
  name: string;
  programId: string;
  ident: string;
  localPath?: string;
  defaultEngine: TicketEngine;
  /** Bot id，或旧配置里的角色名。空数组表示不限制。 */
  cast: string[];
  testBaseUrl?: string;
  testStartCommand?: string;
}

export interface TicketItem {
  /** Detail/state/dispatch 用的稳定键。Gitee: String(id)；禅道: BUG-/TASK-。 */
  key: string;
  id: number;
  ident: string;
  /** 禅道行携带对象类型徽章。 */
  kind?: "bug" | "task";
  title: string;
  stateTitle: string;
  sprintId?: number;
  sprintTitle: string;
  programId: string;
  url: string;
  priority: string;
  priorityRank?: number;
  /** Set after hand-off (UI mock) */
  topicId?: string;
  pipelineStage?: TicketPipelineStage;
  /** 手动「暂不处理」：自动派单跳过，直到手工恢复。 */
  held?: boolean;
  /** 手动「已完成」：工单系统未回写终态时的本地结案标记。 */
  done?: boolean;
}

export interface TicketDetail extends TicketItem {
  description: string;
  authorName: string;
  planStartedAt?: string;
  deadline?: string;
  imageUrls: string[];
  /** 展示用图片地址（鉴权来源走本地代理），与 imageUrls 一一对应。 */
  imageSrcs?: string[];
}

export interface TicketSprintGroup {
  sprintTitle: string;
  tickets: TicketItem[];
}
