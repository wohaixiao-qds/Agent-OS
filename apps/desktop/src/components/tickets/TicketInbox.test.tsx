// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TicketInbox } from "./TicketInbox";
import { api } from "../../lib/api";

vi.mock("../../lib/shell-context", () => ({
  useShell: () => ({
    workspace: { id: "ws-1", name: "demo", localPath: "E:\\\\demo" },
    setWorkspaceId: vi.fn(),
    selectTopic: vi.fn(),
    refreshAll: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    ticketsStatus: vi.fn(async () => ({
      providers: [
        { id: "gitee", label: "Gitee", configured: true },
        { id: "zentao", label: "禅道", configured: false },
      ],
    })),
    listTicketProjects: vi.fn(async () => [
      {
        id: "hangyan",
        name: "航研所项目",
        programId: "818309",
        ident: "PJ20251201",
        localPath: "E:\\\\demo",
        defaultEngine: "claude",
        cast: [],
      },
    ]),
    listTicketTodos: vi.fn(async () => [
      {
        id: 101,
        ident: "IHY-128",
        title: "登录页支持邮箱验证码",
        stateTitle: "待办",
        sprintTitle: "Sprint 12",
        programId: "818309",
        url: "https://example.com",
        priority: "主要",
        priorityRank: 10,
      },
    ]),
    getTicketDetail: vi.fn(async () => ({
      id: 101,
      ident: "IHY-128",
      title: "登录页支持邮箱验证码",
      stateTitle: "待办",
      sprintTitle: "Sprint 12",
      programId: "818309",
      url: "https://example.com",
      priority: "主要",
      priorityRank: 10,
      description: "详细说明",
      authorName: "测试",
      imageUrls: [],
    })),
    updateTicketProject: vi.fn(),
    dispatchTicket: vi.fn(),
    setTicketHold: vi.fn(async () => ({ held: true })),
    listWorkspaces: vi.fn(async () => []),
    listTicketIssueStates: vi.fn(async () => [
      { id: 1, title: "待办" },
      { id: 2, title: "完成" },
    ]),
    updateTicketIssueState: vi.fn(async () => ({
      stateId: 2,
      stateTitle: "完成",
    })),
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("TicketInbox (API)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    // 菜单走 portal 挂 body；清掉上个用例的容器与悬浮菜单残留
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(api.listTicketIssueStates).mockClear();
    vi.mocked(api.updateTicketIssueState).mockClear();
  });

  it("loads projects and todos from API", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TicketInbox onCollapse={vi.fn()} />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("工单");
    // 未配置的来源以「＋来源」引导出现，点击跳设置。
    expect(container.textContent).toContain("＋禅道");
    expect(container.textContent).toContain("航研所项目");
    expect(container.textContent).toContain("IHY-128");
    expect(container.textContent).toContain("交给 CEO");
    // 队列摘要条可见
    expect(container.textContent).toContain("待派 1");

    // 次要操作收进 ⋯ 菜单：打开后可见（portal 挂在 body 上）
    const moreBtn = container.querySelector("button.ticket-more") as HTMLButtonElement | null;
    expect(moreBtn).toBeTruthy();
    await act(async () => {
      moreBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("改状态");
    expect(document.body.textContent).toContain("暂不处理");
    expect(document.body.textContent).toContain("打开原单");
  });

  it("requests issue states when opening change-state picker", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TicketInbox onCollapse={vi.fn()} />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const moreBtn = container.querySelector("button.ticket-more") as HTMLButtonElement | null;
    expect(moreBtn).toBeTruthy();

    await act(async () => {
      moreBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const changeBtn = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent === "改状态",
    );
    expect(changeBtn).toBeTruthy();

    await act(async () => {
      changeBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.listTicketIssueStates).toHaveBeenCalledWith(
      "gitee",
      "hangyan",
      "101",
    );
    expect(container.textContent).toContain("完成");
  });

  it("hold toggle flips the ticket into a visibly held state", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TicketInbox onCollapse={vi.fn()} />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 暂不处理收在 ⋯ 菜单里
    const moreBtn = container.querySelector("button.ticket-more") as HTMLButtonElement | null;
    expect(moreBtn).toBeTruthy();
    await act(async () => {
      moreBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const holdItem = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent === "暂不处理",
    );
    expect(holdItem).toBeTruthy();
    expect(container.querySelector(".ticket-held-chip")).toBeNull();

    await act(async () => {
      holdItem!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.setTicketHold).toHaveBeenCalledWith({
      provider: "gitee",
      projectId: "hangyan",
      issueKey: "101",
      held: true,
    });
    // 卡片进入 held 态：徽标 + 左竖条 + 提示文案；菜单项翻转为「恢复派单」
    expect(container.querySelector(".ticket-held-chip")?.textContent).toBe(
      "暂不处理",
    );
    expect(container.querySelector(".ticket-card.is-held")).toBeTruthy();
    expect(container.textContent).toContain("已标记暂不处理");

    await act(async () => {
      moreBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (el) => el.textContent === "恢复派单",
      ),
    ).toBe(true);
  });
});
