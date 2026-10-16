import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { ChatMessage } from "@zy-aos/shared";
import { MessageList } from "./MessageList";

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    void callback;
    MockResizeObserver.instances.push(this);
  }
}

function message(id: string, content: string): ChatMessage {
  return {
    id,
    topicId: "topic-1",
    author: "user",
    content,
    createdAt: new Date().toISOString(),
  } as ChatMessage;
}

describe("MessageList 贴底滚动", () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    MockResizeObserver.instances.length = 0;
  });

  it("空话题先渲染，消息到达后 ResizeObserver 必须挂到 timeline-inner", async () => {
    MockResizeObserver.instances.length = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <MessageList
          messages={[]}
          bots={[]}
          onAnswerClarification={vi.fn()}
          onDecideControl={vi.fn()}
        />,
      );
    });
    // 空态走提前 return：没有 timeline-inner 可观察
    expect(container.querySelector(".timeline-inner")).toBeNull();

    await act(async () => {
      root!.render(
        <MessageList
          messages={[message("m1", "@开发工程师 看一下")]}
          bots={[]}
          onAnswerClarification={vi.fn()}
          onDecideControl={vi.fn()}
        />,
      );
    });

    const inner = container.querySelector(".timeline-inner");
    expect(inner).not.toBeNull();
    const observed = MockResizeObserver.instances.flatMap((observer) =>
      observer.observe.mock.calls,
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0]?.[0]).toBe(inner);
  });
});
