import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Topic } from "@zy-aos/shared";
import { useShell } from "../../lib/shell-context";
import { IconChevronDown, IconGrid, IconPlus, IconTrash } from "./icons";
import { api } from "../../lib/api";

function topicStatus(
  topic: Topic,
  hasPending: boolean,
): "running" | "needs_you" | "idle" {
  if (hasPending) return "needs_you";
  if (
    topic.busy ||
    topic.pipelineStage === "developing" ||
    topic.pipelineStage === "testing" ||
    topic.pipelineStage === "reviewing"
  ) {
    return "running";
  }
  return "idle";
}

function statusLabel(status: "running" | "needs_you" | "idle"): string {
  if (status === "running") return "进行中";
  if (status === "needs_you") return "待确认";
  return "空闲";
}

function confirmCopy(topic: Topic, hasPending: boolean): string {
  const running =
    hasPending ||
    topic.busy ||
    topic.pipelineStage === "developing" ||
    topic.pipelineStage === "testing" ||
    topic.pipelineStage === "reviewing";
  if (running) {
    return "将停止当前流水线，并删除这个话题的消息。不能撤销。";
  }
  return "将删除这个话题的消息。不能撤销。";
}

/** 相对时间：刚看过没多久用「刚刚」，久了落到日期。 */
function relativeTime(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  if (ms < 60_000) return "刚刚";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}分钟前`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / 3_600_000)}小时前`;
  if (ms < 7 * 24 * 60 * 60_000) return `${Math.floor(ms / 86_400_000)}天前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const READ_AT_PREFIX = "zy-aos:read:";

function readAtOf(topicId: string): number {
  try {
    return Number(localStorage.getItem(READ_AT_PREFIX + topicId) ?? 0);
  } catch {
    return 0;
  }
}

function markRead(topicId: string): void {
  try {
    localStorage.setItem(READ_AT_PREFIX + topicId, String(Date.now()));
  } catch {
    // 持久化失败不影响使用
  }
}

function TopicListItem({
  topic,
  active,
  hasPending,
  unread,
  onSelect,
  onDelete,
}: {
  topic: Topic;
  active: boolean;
  hasPending: boolean;
  unread: boolean;
  onSelect: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const status = topicStatus(topic, hasPending);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  async function commit() {
    setDeleting(true);
    const ok = await onDelete();
    if (!ok) setDeleting(false);
  }

  return (
    <li className={confirming ? "topic-item confirming" : "topic-item"}>
      <div className={`topic-row ${active ? "active" : ""}`}>
        <button
          type="button"
          className="topic-select"
          onClick={() => {
            if (!active) markRead(topic.id);
            onSelect();
          }}
        >
          <div className="topic-row-head">
            {unread ? <span className="topic-unread" aria-label="有未读" /> : null}
            {status === "running" ? (
              <span className="topic-spinner" aria-label="进行中" title="智能体正在执行" />
            ) : null}
            <span className={`topic-title ${unread ? "is-unread" : ""}`}>{topic.title}</span>
            {status === "needs_you" ? (
              <span className={`status-chip status-${status}`}>
                {statusLabel(status)}
              </span>
            ) : null}
            <span className="topic-time">{relativeTime(topic.lastMessageAt)}</span>
          </div>
        </button>
        <button
          type="button"
          className="topic-delete"
          aria-label={`删除话题 ${topic.title}`}
          aria-expanded={confirming}
          disabled={deleting}
          onClick={() => setConfirming((open) => !open)}
        >
          <IconTrash />
        </button>
      </div>
      {confirming ? (
        <div
          className="topic-confirm"
          role="group"
          aria-label={`确认删除 ${topic.title}`}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleting) setConfirming(false);
          }}
        >
          <p>{confirmCopy(topic, hasPending)}</p>
          <div className="topic-confirm-actions">
            <button
              ref={cancelRef}
              type="button"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="danger"
              disabled={deleting}
              onClick={() => void commit()}
            >
              {deleting ? "删除中" : "删除"}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Sidebar() {
  const {
    workspaces,
    workspace,
    setWorkspaceId,
    topics,
    selectedTopicId,
    selectTopic,
    createTopic,
    deleteTopic,
    topicPendingIds,
    refreshAll,
  } = useShell();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 每分钟重渲染一次让「X分钟前」走表
  const [, setTimeTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTimeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter((t) => t.title.toLowerCase().includes(q));
  }, [topics, filter]);

  /** 下拉行内快捷删除：仅解除登记，当前选中的工作区不走此入口。 */
  async function handleDeleteWorkspaceById(target: {
    id: string;
    name: string;
  }) {
    const confirmed = window.confirm(
      `确定删除工作区「${target.name}」？仅解除登记，不会删除本地目录与话题记录。`,
    );
    if (!confirmed) return;
    try {
      await api.deleteWorkspace(target.id);
      await refreshAll();
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function handleDeleteWorkspace() {
    if (!workspace) return;
    const confirmed = window.confirm(
      `确定删除工作区「${workspace.name}」？仅解除登记，不会删除本地目录与话题记录。`,
    );
    if (!confirmed) {
      setMenuOpen(false);
      return;
    }
    try {
      await api.deleteWorkspace(workspace.id);
      setMenuOpen(false);
      await refreshAll();
    } catch (error) {
      setMenuOpen(false);
      alert(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function handleNewTopic() {
    setCreating(true);
    try {
      await createTopic("新话题");
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="workspace-menu">
          <button
            type="button"
            className="workspace-switcher-btn"
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            aria-label="工作区"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="workspace-switcher-label">
              <IconGrid />
              <span className="truncate">
                {workspace?.name ?? "暂无工作区"}
              </span>
            </span>
            <IconChevronDown />
          </button>
          {menuOpen ? (
            <div className="workspace-dropdown" role="listbox">
              {workspaces.map((w) => (
                <div
                  key={w.id}
                  className="workspace-option"
                  role="option"
                  aria-selected={w.id === workspace?.id}
                >
                  <button
                    type="button"
                    className={w.id === workspace?.id ? "active" : ""}
                    onClick={() => {
                      setWorkspaceId(w.id);
                      setMenuOpen(false);
                    }}
                  >
                    {w.name}
                  </button>
                  {w.id === workspace?.id ? null : (
                    <button
                      type="button"
                      className="workspace-option-remove"
                      aria-label={`删除工作区 ${w.name}`}
                      title="删除该工作区（仅解除登记）"
                      onClick={() => void handleDeleteWorkspaceById(w)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {workspaces.length === 0 ? (
                <p className="muted empty-hint">暂无工作区</p>
              ) : null}
              <div className="workspace-dropdown-links">
                <Link to="/workspaces/new" onClick={() => setMenuOpen(false)}>
                  新建工作区
                </Link>
                {workspace ? (
                  <>
                    <Link
                      to={`/workspaces/${workspace.id}`}
                      onClick={() => setMenuOpen(false)}
                    >
                      编辑工作区
                    </Link>
                    <button
                      type="button"
                      className="workspace-dropdown-danger"
                      onClick={() => void handleDeleteWorkspace()}
                    >
                      删除当前工作区
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="sidebar-section-head">
          <span>话题</span>
          <button
            type="button"
            className="section-action"
            disabled={!workspace || creating}
            onClick={() => void handleNewTopic()}
          >
            <IconPlus />
            {creating ? "…" : "新建"}
          </button>
        </div>

        <div className="sidebar-filter">
          <input
            type="search"
            placeholder="筛选话题"
            aria-label="筛选话题"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <ul className="topic-list">
        {filtered.map((topic) => (
          <TopicListItem
            key={topic.id}
            topic={topic}
            active={selectedTopicId === topic.id}
            hasPending={topicPendingIds.has(topic.id)}
            unread={
              topic.id !== selectedTopicId &&
              Boolean(
                topic.lastMessageAt &&
                  new Date(topic.lastMessageAt).getTime() >
                    readAtOf(topic.id),
              )
            }
            onSelect={() => selectTopic(topic.id)}
            onDelete={() => deleteTopic(topic.id)}
          />
        ))}
        {filtered.length === 0 ? (
          <li className="muted empty-hint">暂无话题</li>
        ) : null}
      </ul>

      <div className="sidebar-footer">
        <span>引擎 V4.2</span>
        <span className="engine-ok">● 均衡</span>
      </div>
    </aside>
  );
}
