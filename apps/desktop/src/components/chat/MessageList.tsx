import { useEffect, useRef, useState } from "react";
import type { BotConfig, ChatMessage } from "@zy-aos/shared";
import { BotAvatar } from "../BotAvatar";
import { botTone } from "../../lib/bot-style";
import { ClarificationCard } from "./ClarificationCard";
import { DispatchCard, TicketIntakeCard } from "./LarkCard";
import { MarkdownBody } from "./MarkdownBody";
import { RunCard } from "./RunCard";
import { AppToolCard, type ControlDecision } from "./AppToolCard";
import { providerLabel, ticketIntakeView } from "./ticket-intake";

type MessageListProps = {
  messages: ChatMessage[];
  bots: BotConfig[];
  onAnswerClarification: (clarificationId: string, optionId: string) => void;
  onDecideControl: (topicId: string, decision: ControlDecision) => void;
  onAbort?: () => void;
};

/** 距底部小于该值视为「在底部」：新消息继续贴底；翻历史时不打扰。 */
const STICK_THRESHOLD_PX = 80;

function authorLabel(
  message: ChatMessage,
  bots: BotConfig[],
): { name: string; role?: string; bot?: BotConfig } {
  if (message.author === "user") return { name: "我" };
  if (message.author === "system") return { name: "系统" };
  const bot = bots.find((b) => b.id === message.botId);
  return { name: bot?.name ?? "智能体", role: bot?.role, bot };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function MentionText({ content }: { content: string }) {
  const parts = content.split(/(@我)/g);
  return (
    <p className="mention-line">
      {parts.map((part, index) =>
        part === "@我" ? (
          <span key={index} className="mention">
            @我
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}
function handoffCard(
  content: string,
): { from: string; to: string; objective: string; footer: string } | null {
  const toProduct = content.match(/已自动交给\s*(.+?)\s*澄清/);
  if (toProduct) {
    return {
      from: "CEO助理",
      to: toProduct[1] ?? "产品经理",
      objective: "澄清需求并形成可验收的产品方案",
      footer: "完成后，结果会自动交回 CEO助理，并在方案写好后进入开发。",
    };
  }
  if (content.includes("已自动启动开发流水线")) {
    return {
      from: "产品经理",
      to: "开发工程师",
      objective: "按已确认规格实现，并进入测试与审查",
      footer: "开发、测试、审查会按流水线自动交接。",
    };
  }
  return null;
}

function BotBody({
  message,
}: {
  message: ChatMessage;
}) {
  if (!message.content && message.streaming) return null;
  return (
    <MarkdownBody content={message.content} streaming={Boolean(message.streaming)} />
  );
}

export function MessageList({
  messages,
  bots,
  onAnswerClarification,
  onDecideControl,
  onAbort,
}: MessageListProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  // 用 state 而不是 ref 承载内层节点：话题为空时走提前 return，内层不渲染，
  // observer effect 必须等内层真正挂载后才运行（ref 变化不触发 effect）。
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevTopicRef = useRef<string | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  const topicId = messages[0]?.topicId ?? null;
  const lastMessage = messages[messages.length - 1];

  // 切换话题：重置为贴底，等消息渲染后由下方 effect 滚过去
  if (prevTopicRef.current !== topicId) {
    prevTopicRef.current = topicId;
    stickToBottomRef.current = true;
    lastMessageIdRef.current = null;
    if (showJump) setShowJump(false);
  }

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    // 用户自己发了新消息：强制回到底部跟随回复
    if (
      lastMessage &&
      lastMessage.author === "user" &&
      lastMessage.id !== lastMessageIdRef.current
    ) {
      stickToBottomRef.current = true;
    }
    if (lastMessage) lastMessageIdRef.current = lastMessage.id;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // 图片/代码块在本次提交后才撑高布局：下一帧再钉一次
      requestAnimationFrame(() => {
        if (stickToBottomRef.current && el.isConnected) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [messages, lastMessage]);

  // 消息不变时内容也会撑高（流式增量、图片加载、卡片展开、代码高亮）：
  // 盯内容高度持续钉底，否则最新内容会被顶出视口、要手动滚一下才看得见。
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || !contentEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [contentEl]);

  function handleScroll() {
    const el = timelineRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_THRESHOLD_PX;
    setShowJump(distance >= STICK_THRESHOLD_PX * 4);
  }

  function jumpToBottom() {
    const el = timelineRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
  }

  if (messages.length === 0) {
    return (
      <div className="timeline">
        <p className="muted empty-hint">
          暂无消息。直接发送默认交给 CEO 助理，或 @ 指定智能体。
        </p>
      </div>
    );
  }

  return (
    <div className="timeline-wrap">
      <div
        className="timeline"
        ref={timelineRef}
        onScroll={handleScroll}
      >
        <div className="timeline-inner" ref={setContentEl}>
        {messages.map((msg) => {
        const meta = authorLabel(msg, bots);
        const isYou = msg.author === "user";
        if (msg.kind === "app-tool" && msg.appTool) {
          return (
            <article key={msg.id} className="msg msg-card">
              <AppToolCard
                message={msg}
                onDecide={(decision) => onDecideControl(msg.topicId, decision)}
              />
            </article>
          );
        }
        if (msg.kind === "clarification" && msg.clarification) {
          return (
            <ClarificationCard
              key={msg.id}
              message={msg}
              botName={meta.name}
              botRole={meta.role}
              onAnswer={onAnswerClarification}
            />
          );
        }
        if (msg.author === "system") {
          if (msg.content.startsWith("▶")) return null;
          const ticket = msg.ticketIntake
            ? {
                ...msg.ticketIntake,
                providerLabel:
                  msg.ticketIntake.providerLabel ??
                  providerLabel(msg.ticketIntake.provider),
              }
            : ticketIntakeView(msg.content);
          if (ticket) {
            return (
              <article key={msg.id} className="msg msg-card">
                <TicketIntakeCard {...ticket} />
                <span className="msg-time">{formatTime(msg.createdAt)}</span>
              </article>
            );
          }
          const structured = msg.dispatch;
          const card = structured
            ? {
                from: structured.fromName,
                to: structured.toName,
                objective: structured.objective,
                project: structured.project,
                reportTo: structured.reportToName,
                instruction: structured.instruction,
                expectedOutput: structured.expectedOutput,
              }
            : handoffCard(msg.content);
          if (card) {
            return (
              <article key={msg.id} className="msg msg-card">
                <DispatchCard {...card} />
                <span className="msg-time">{formatTime(msg.createdAt)}</span>
              </article>
            );
          }
        }
        if (isYou) {
          return (
            <article key={msg.id} className="msg msg-you">
              <div className="msg-bubble">{msg.content}</div>
              <span className="msg-time">我 · {formatTime(msg.createdAt)}</span>
            </article>
          );
        }
        return (
          <article key={msg.id} className="msg msg-bot">
            <BotAvatar
              bot={meta.bot ?? { name: meta.name, role: meta.role ?? "" }}
              large
              hidden
            />
            <div className="msg-col">
              <div className="msg-meta">
                <strong>{meta.name}</strong>
                {meta.role ? (
                  <span className={`role-pill tone-${botTone(meta.bot)}`}>
                    {meta.role}
                  </span>
                ) : null}
                <span className="msg-time">{formatTime(msg.createdAt)}</span>
              </div>
              <div
                className={
                  msg.author === "system"
                    ? "msg-body msg-body-plain"
                    : "msg-body"
                }
              >
                {msg.kind === "mention" ? (
                  <MentionText content={msg.content} />
                ) : msg.author === "bot" ? (
                  <RunCard message={msg} onAbort={onAbort}>
                    <BotBody message={msg} />
                  </RunCard>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          </article>
        );
        })}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          className="timeline-jump"
          onClick={jumpToBottom}
        >
          ↓ 回到最新
        </button>
      ) : null}
    </div>
  );
}
