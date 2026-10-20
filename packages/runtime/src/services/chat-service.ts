import { randomUUID } from "node:crypto";
import type { ChatMessage, Topic } from "@zy-aos/shared";
import type { JsonStore } from "../store/json-store.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { BotService } from "./bot-service.js";
import type { SettingsService } from "./settings-service.js";
import type { CliAdapter } from "../cli/types.js";
import { BotRunService } from "./bot-run-service.js";
import {
  compactCliSession,
  parseCompactCommand,
} from "../cli/compact-session.js";

export interface CreateTopicInput {
  workspaceId: string;
  title: string;
}

export interface SendMessageInput {
  content: string;
  mentionBotId?: string;
}

export type ChatEvent =
  | { type: "message.upsert"; message: ChatMessage }
  | { type: "topic.update"; topic: Topic }
  | {
      type: "pipeline.update";
      topicId: string;
      pipelineStage: Topic["pipelineStage"];
    };

const DEFAULT_TOPIC_TITLES = new Set(["新话题", "新需求话题", "New topic"]);
const AUTO_TITLE_MAX = 40;

/** First meaningful line without a leading @mention, capped for the sidebar. */
export function deriveTopicTitle(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const withoutMention = firstLine.replace(/^@[^\s@]+\s*/, "").trim();
  return (withoutMention || firstLine).slice(0, AUTO_TITLE_MAX);
}

export class ChatService {
  private readonly botRun: BotRunService;

  constructor(
    private readonly store: JsonStore,
    private readonly workspaceService: WorkspaceService,
    private readonly botService: BotService,
    adapter?: CliAdapter,
    private readonly emit?: (event: ChatEvent) => void,
    private readonly settingsService?: SettingsService,
    botRun?: BotRunService,
  ) {
    this.botRun =
      botRun ??
      new BotRunService(
        store,
        workspaceService,
        botService,
        settingsService,
        emit
          ? (event) => {
              this.emit?.(event);
            }
          : undefined,
        adapter,
      );
  }

  async abort(topicId: string): Promise<{ ok: true; aborted: boolean }> {
    return this.botRun.abort(topicId);
  }

  async deleteTopic(id: string): Promise<void> {
    const topic = await this.getTopic(id);
    if (!topic) {
      throw new Error(`Topic not found: ${id}`);
    }
    this.botRun.discard(id);
    await this.store.transact((state) => {
      state.topics = state.topics.filter((t) => t.id !== id);
      state.messages = state.messages.filter((m) => m.topicId !== id);
      state.pipelines = state.pipelines.filter((p) => p.topicId !== id);
    });
  }

  async createTopic(input: CreateTopicInput): Promise<Topic> {
    const workspace = await this.workspaceService.get(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }

    const topic: Topic = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      createdAt: new Date().toISOString(),
      pipelineStage: "idle",
    };
    await this.store.transact((state) => {
      state.topics.push(topic);
    });

    this.emit?.({
      type: "pipeline.update",
      topicId: topic.id,
      pipelineStage: topic.pipelineStage,
    });
    // 新话题立即广播 topic.update：后台创建（定时拉单派单）时，
    // 前端靠这个事件把话题加进侧边栏列表。
    this.emit?.({ type: "topic.update", topic });

    return topic;
  }

  async listTopics(workspaceId?: string): Promise<Topic[]> {
    const state = await this.store.load();
    const scoped = workspaceId
      ? state.topics.filter((t) => t.workspaceId === workspaceId)
      : state.topics;
    // 侧边栏「多久没动静/未读」需要每个话题最后一条消息的时间
    const lastAt = new Map<string, string>();
    for (const message of state.messages) {
      const prev = lastAt.get(message.topicId);
      if (!prev || message.createdAt > prev) {
        lastAt.set(message.topicId, message.createdAt);
      }
    }
    return scoped.map((topic) => ({
      ...topic,
      lastMessageAt: lastAt.get(topic.id) ?? topic.createdAt,
    }));
  }

  async getTopic(id: string): Promise<Topic | undefined> {
    const state = await this.store.load();
    return state.topics.find((t) => t.id === id);
  }

  async listMessages(topicId: string): Promise<ChatMessage[]> {
    const topic = await this.getTopic(topicId);
    if (!topic) {
      throw new Error(`Topic not found: ${topicId}`);
    }
    const state = await this.store.load();
    return state.messages
      .filter((m) => m.topicId === topicId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendMessage(
    topicId: string,
    input: SendMessageInput,
  ): Promise<ChatMessage[]> {
    const topic = await this.getTopic(topicId);
    if (!topic) {
      throw new Error(`Topic not found: ${topicId}`);
    }

    const userMessage = await this.appendMessage({
      topicId,
      author: "user",
      content: input.content,
    });

    const compact = parseCompactCommand(input.content);
    if (compact.isCompact) {
      if (!input.mentionBotId) {
        const note = await this.appendMessage({
          topicId,
          author: "system",
          content: "使用 /compact 时请先 @ 一个智能体，以整理该 Bot 的 CLI 会话。",
        });
        return [userMessage, note];
      }
      const bot = await this.botService.get(input.mentionBotId);
      if (!bot) {
        throw new Error(`Bot not found: ${input.mentionBotId}`);
      }
      const sessionId = topic.cliSessions?.[bot.id];
      if (!sessionId) {
        const note = await this.appendMessage({
          topicId,
          author: "system",
          content: `${bot.name} 还没有可整理的 CLI 会话。先正常对话一轮后再 /compact。`,
        });
        return [userMessage, note];
      }
      const workspace = await this.workspaceService.get(topic.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${topic.workspaceId}`);
      }
      try {
        const engine = bot.defaultEngine === "codex" ? "codex" : "claude";
        const result = await compactCliSession({
          engine,
          sessionId,
          cwd: workspace.localPath,
          instructions: compact.instructions,
        });
        const note = await this.appendMessage({
          topicId,
          author: "system",
          content: result.message?.trim()
            ? `已整理 ${bot.name} 的上下文。\n${result.message.trim()}`
            : `已整理 ${bot.name} 的上下文（/compact）。`,
        });
        return [userMessage, note];
      } catch (error) {
        const message = error instanceof Error ? error.message : "上下文整理失败";
        const note = await this.appendMessage({
          topicId,
          author: "system",
          content: `[compact] ${message}`,
        });
        return [userMessage, note];
      }
    }

    await this.autoTitleTopic(topic, input.content);

    // 不带 @ 的裸消息默认交给 CEO 助理（团队调度者）；没有可用 CEO 时提示。
    let targetBotId = input.mentionBotId;
    if (!targetBotId) {
      const bots = await this.botService.list();
      const ceo = bots.find(
        (item) => item.enabled && item.role.toLowerCase() === "ceo",
      );
      if (!ceo) {
        const note = await this.appendMessage({
          topicId,
          author: "system",
          content:
            "没有已启用的 CEO 助理：请在「智能体」页启用，或用 @ 指定要对话的成员。",
        });
        return [userMessage, note];
      }
      targetBotId = ceo.id;
    }

    const botMessage = await this.botRun.start({
      topicId,
      botId: targetBotId,
      prompt: input.content,
      origin: "chat",
    });

    return [userMessage, botMessage];
  }

  private async appendMessage(
    input: Pick<ChatMessage, "topicId" | "author" | "content"> & {
      botId?: string;
    },
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: randomUUID(),
      topicId: input.topicId,
      author: input.author,
      content: input.content,
      createdAt: new Date().toISOString(),
      ...(input.botId ? { botId: input.botId } : {}),
    };
    await this.store.transact((state) => {
      state.messages.push(message);
    });
    this.emit?.({ type: "message.upsert", message });
    return message;
  }

  /** Replace a default topic title with one derived from the first message. */
  private async autoTitleTopic(topic: Topic, content: string): Promise<void> {
    if (!DEFAULT_TOPIC_TITLES.has(topic.title)) return;
    const title = deriveTopicTitle(content);
    if (!title) return;
    let updated: Topic | undefined;
    await this.store.transact((state) => {
      const target = state.topics.find((t) => t.id === topic.id);
      if (!target || !DEFAULT_TOPIC_TITLES.has(target.title)) return;
      target.title = title;
      updated = target;
    });
    if (updated) this.emit?.({ type: "topic.update", topic: updated });
  }
}
