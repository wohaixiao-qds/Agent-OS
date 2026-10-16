// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChatMessage } from "@zy-aos/shared";
import { MessageList } from "./MessageList";
import { ticketIntakeView } from "./ticket-intake";

const LEGACY_CONTENT = [
  "[zentao] 已接入工单 BUG-41674",
  "http://intranet.example/zentao/bug-view-41674.html",
  "项目目录：/Users/demo/work/web-app/",
  "引擎：claude",
  "Cast：CEO助理（targetBotId=11111111-1111-1111-1111-111111111111）、开发工程师（targetBotId=22222222-2222-2222-2222-222222222222）",
  "描述摘要：新增按钮位置不在列表右上角，样式和系统不统一。",
  "用户补充：尽快修复",
].join("\n");

describe("ticketIntakeView", () => {
  it("parses legacy plain-text notices and strips targetBotId noise", () => {
    const view = ticketIntakeView(LEGACY_CONTENT);
    expect(view).not.toBeNull();
    expect(view?.provider).toBe("zentao");
    expect(view?.providerLabel).toBe("禅道");
    expect(view?.ident).toBe("BUG-41674");
    expect(view?.url).toBe("http://intranet.example/zentao/bug-view-41674.html");
    expect(view?.localPath).toBe("/Users/demo/work/web-app/");
    expect(view?.engine).toBe("claude");
    expect(view?.cast).toBe("CEO助理、开发工程师");
    expect(view?.summary).toContain("新增按钮位置");
    expect(view?.note).toBe("尽快修复");
  });

  it("returns null for non-intake system content", () => {
    expect(ticketIntakeView("已自动启动开发流水线")).toBeNull();
    expect(ticketIntakeView("普通用户消息")).toBeNull();
  });

  it("labels gitee notices", () => {
    const view = ticketIntakeView("[gitee] 已接入工单 #42\nhttps://gitee.com/a/b/issues/42");
    expect(view?.providerLabel).toBe("Gitee");
    expect(view?.ident).toBe("#42");
  });
});

function renderMessages(messages: ChatMessage[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <MessageList
        messages={messages}
        bots={[]}
        onAnswerClarification={vi.fn()}
        onDecideControl={vi.fn()}
      />,
    );
  });
  return container;
}

describe("MessageList ticket intake cards", () => {
  it("renders legacy notices and structured notices as cards", () => {
    const now = new Date().toISOString();
    const container = renderMessages([
      {
        id: "m1",
        topicId: "t1",
        author: "system",
        content: LEGACY_CONTENT,
        createdAt: now,
      },
      {
        id: "m2",
        topicId: "t1",
        author: "system",
        content: "[zentao] 已接入工单 TASK-9（structured）",
        createdAt: now,
        ticketIntake: {
          provider: "zentao",
          providerLabel: "禅道",
          ident: "TASK-9",
          title: "示例任务",
          cast: "开发工程师",
        },
      },
    ]);
    const titles = Array.from(
      container.querySelectorAll(".lark-card-header strong"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["工单已接入", "工单已接入"]);
    const subtitles = Array.from(
      container.querySelectorAll(".lark-card-header span"),
    ).map((el) => el.textContent);
    expect(subtitles).toEqual(["禅道 · BUG-41674", "禅道 · TASK-9"]);
    expect(container.textContent).toContain("CEO助理、开发工程师");
    expect(container.textContent).not.toContain("targetBotId");
    expect(container.textContent).toContain("示例任务");
  });
});
