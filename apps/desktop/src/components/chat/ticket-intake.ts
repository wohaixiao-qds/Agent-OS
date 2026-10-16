export type TicketIntakeView = {
  provider: string;
  providerLabel: string;
  ident: string;
  title?: string;
  url?: string;
  localPath?: string;
  engine?: string;
  cast?: string;
  summary?: string;
  note?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  gitee: "Gitee",
  zentao: "禅道",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Parse legacy plain-text intake notices ("[zentao] 已接入工单 BUG-1 …")
 * into card data. Messages written before the structured ticketIntake field
 * exist only in this format.
 */
export function ticketIntakeView(content: string): TicketIntakeView | null {
  const head = content.match(/^\[(gitee|zentao)\] 已接入工单 (\S+)/);
  if (!head) return null;
  const line = (label: string) =>
    content.match(new RegExp(`^${label}：(.+)$`, "m"))?.[1]?.trim();
  return {
    provider: head[1] ?? "",
    providerLabel: providerLabel(head[1] ?? ""),
    ident: head[2] ?? "",
    url: content.match(/^(https?:\/\/\S+)$/m)?.[1],
    localPath: line("项目目录"),
    engine: line("引擎"),
    // Legacy messages embed "（targetBotId=…）" per member; names only for display.
    cast: line("Cast")?.replace(/（targetBotId=[^）]*）/g, ""),
    summary: line("描述摘要"),
    note: line("用户补充"),
  };
}
