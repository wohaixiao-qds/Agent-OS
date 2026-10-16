import type { BotConfig } from "@zy-aos/shared";

export type BotTone = "ceo" | "dev" | "test" | "review" | "default";

export function botTone(bot: Pick<BotConfig, "name" | "role"> | null | undefined): BotTone {
  const hay = `${bot?.name ?? ""} ${bot?.role ?? ""}`.toLowerCase();
  if (/ceo|orchestrat|助理/.test(hay)) return "ceo";
  if (/product|产品/.test(hay)) return "ceo";
  if (/dev|code|engineer|开发/.test(hay)) return "dev";
  if (/test|qa|测试/.test(hay)) return "test";
  if (/review|audit|security|审查/.test(hay)) return "review";
  return "default";
}

export function botInitial(bot: Pick<BotConfig, "name" | "role"> | null | undefined): string {
  const name = bot?.name?.trim() || bot?.role?.trim() || "?";
  const letter = name.replace(/^ml[-_\s]*/i, "").charAt(0);
  return (letter || name.charAt(0) || "?").toUpperCase();
}

/** Portrait files in apps/desktop/public, matched by role. */
export function botPortrait(
  bot: Pick<BotConfig, "name" | "role"> | null | undefined,
): string | undefined {
  const hay = `${bot?.name ?? ""} ${bot?.role ?? ""}`.toLowerCase();
  if (/product|产品/.test(hay)) return "/product.svg";
  if (/ceo|orchestrat|助理/.test(hay)) return "/ceo.svg";
  if (/review|audit|security|审查/.test(hay)) return "/reviewer.svg";
  if (/test|qa|测试/.test(hay)) return "/test.svg";
  if (/dev|code|engineer|开发/.test(hay)) return "/developer.svg";
  return undefined;
}
