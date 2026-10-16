import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../store/json-store.js";
import { BotService } from "./bot-service.js";
import { WorkspaceService } from "./workspace-service.js";
import { ChatService, deriveTopicTitle } from "./chat-service.js";
import { MockCliAdapter } from "../cli/mock-adapter.js";
import type { AppState } from "../app-state.js";
import type { ChatMessage } from "@zy-aos/shared";

async function emptyState(dataDir: string): Promise<AppState> {
  return {
    settings: {
      theme: "dark",
      defaultEngine: "claude",
      dataDir,
      notifications: true,
    },
    bots: [],
    workspaces: [],
    topics: [],
    messages: [],
    pipelines: [],
  };
}

async function waitForMessages(
  chat: ChatService,
  topicId: string,
  predicate: (messages: ChatMessage[]) => boolean,
  attempts = 80,
): Promise<ChatMessage[]> {
  for (let i = 0; i < attempts; i++) {
    const list = await chat.listMessages(topicId);
    if (predicate(list)) return list;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for bot messages");
}

describe("ChatService", () => {
  let dir: string;
  let store: JsonStore;
  let chat: ChatService;
  let workspaceId: string;
  let botId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zy-aos-chat-"));
    store = new JsonStore(dir);
    await store.save(await emptyState(dir));

    const workspaceService = new WorkspaceService(store);
    const botService = new BotService(store);
    chat = new ChatService(
      store,
      workspaceService,
      botService,
      new MockCliAdapter(),
    );

    const workspace = await workspaceService.create({
      name: "demo",
      localPath: dir,
    });
    workspaceId = workspace.id;

    const bot = await botService.create({
      name: "Dev Bot",
      role: "developer",
      defaultEngine: "claude",
      instructions: "help",
      enabled: true,
    });
    botId = bot.id;
  });

  it("creates topic and lists by workspace", async () => {
    const topic = await chat.createTopic({
      workspaceId,
      title: "Feature A",
    });
    expect(topic.title).toBe("Feature A");
    expect(topic.pipelineStage).toBe("idle");

    const list = await chat.listTopics(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(topic.id);
  });

  it("stores user message only when no mentionBotId", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "T" });
    const messages = await chat.sendMessage(topic.id, { content: "hello" });
    expect(messages).toHaveLength(1);
    expect(messages[0].author).toBe("user");
    expect(messages[0].content).toBe("hello");
  });

  it("adds bot reply when mentionBotId is set", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "T" });
    const messages = await chat.sendMessage(topic.id, {
      content: "fix bug",
      mentionBotId: botId,
    });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const botMsg = messages.find((m) => m.author === "bot");
    expect(botMsg).toBeTruthy();
    expect(botMsg!.streaming).toBe(true);

    const settled = await waitForMessages(chat, topic.id, (list) => {
      const bot = list.find((m) => m.id === botMsg!.id);
      return Boolean(bot && !bot.streaming && bot.content.includes("Mock"));
    });
    const done = settled.find((m) => m.id === botMsg!.id)!;
    expect(done.content).toContain("Mock");
    expect(done.botId).toBe(botId);
  });

  it("requires mentionBotId to pick bot", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "T" });
    await expect(
      chat.sendMessage(topic.id, { content: "hi", mentionBotId: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("persists clarification message when mock emits clarify event", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "T" });
    await chat.sendMessage(topic.id, {
      content: "[clarify] pick approach",
      mentionBotId: botId,
    });

    const messages = await waitForMessages(chat, topic.id, (list) =>
      list.some((m) => m.kind === "clarification"),
    );
    const clarification = messages.find((m) => m.kind === "clarification");
    expect(clarification).toBeTruthy();
    expect(clarification!.clarification?.status).toBe("pending");
    expect(clarification!.clarification?.options).toHaveLength(2);
  });

  it("abort returns ok when nothing is running", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "T" });
    const result = await chat.abort(topic.id);
    expect(result).toEqual({ ok: true, aborted: false });
  });

  it("auto-titles a default topic from the first message", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "新话题" });
    await chat.sendMessage(topic.id, {
      content: "给登录页加手机号验证码\n次要：支持国际化",
    });
    const list = await chat.listTopics(workspaceId);
    expect(list[0].title).toBe("给登录页加手机号验证码");
  });

  it("keeps the auto title on later messages", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "新需求话题" });
    await chat.sendMessage(topic.id, { content: "第一句话" });
    await chat.sendMessage(topic.id, { content: "第二句话" });
    const list = await chat.listTopics(workspaceId);
    expect(list[0].title).toBe("第一句话");
  });

  it("does not rename a custom title", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "自定义标题" });
    await chat.sendMessage(topic.id, { content: "内容" });
    const list = await chat.listTopics(workspaceId);
    expect(list[0].title).toBe("自定义标题");
  });

  it("deriveTopicTitle strips leading mention and caps length", () => {
    expect(deriveTopicTitle("@CEO助理 做一个登录页")).toBe("做一个登录页");
    expect(deriveTopicTitle("  \n\n第二行才是内容")).toBe("第二行才是内容");
    expect(deriveTopicTitle("长".repeat(80)).length).toBe(40);
    expect(deriveTopicTitle("   ")).toBe("");
  });

  it("deletes a topic and its messages and pipeline", async () => {
    const topic = await chat.createTopic({ workspaceId, title: "丢弃" });
    const other = await chat.createTopic({ workspaceId, title: "留下" });
    await chat.sendMessage(topic.id, { content: "hello" });
    await store.transact((state) => {
      state.pipelines.push({
        id: "pipe-1",
        topicId: topic.id,
        title: "丢弃",
        stage: "blocked",
        stages: [],
      });
    });

    await chat.deleteTopic(topic.id);

    const state = await store.load();
    expect(state.topics.map((t) => t.id)).toEqual([other.id]);
    expect(state.messages.some((m) => m.topicId === topic.id)).toBe(false);
    expect(state.pipelines).toHaveLength(0);
    await expect(chat.deleteTopic(topic.id)).rejects.toThrow(/not found/i);
    expect(await chat.listMessages(other.id)).toEqual([]);
  });
});
