import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, type TicketProviderId, type TicketsStatus } from "../../lib/api";
import { useShell } from "../../lib/shell-context";
import { IconActivity, IconSettings, IconTicket } from "../shell/icons";
import { groupTicketsBySprint } from "./ticket-mock";
import { TicketDetailDrawer } from "./TicketDetailDrawer";
import { TicketProjectConfig } from "./TicketProjectConfig";
import { TicketStatePicker } from "./TicketStatePicker";
import { TicketStatusPopover } from "./TicketStatusPopover";
import type { TicketDetail, TicketItem, TicketProject } from "./ticket-types";

type TicketInboxProps = {
  onCollapse: () => void;
};

const PROVIDERS: Array<{ id: TicketProviderId; label: string }> = [
  { id: "gitee", label: "Gitee" },
  { id: "zentao", label: "禅道" },
];

function toProject(row: Awaited<ReturnType<typeof api.listTicketProjects>>[number]): TicketProject {
  return {
    id: row.id,
    name: row.name,
    programId: row.programId,
    ident: row.ident ?? row.programId,
    localPath: row.localPath,
    defaultEngine: row.defaultEngine,
    cast: row.cast,
    testBaseUrl: row.testBaseUrl,
    testStartCommand: row.testStartCommand,
  };
}

function toTicket(row: Awaited<ReturnType<typeof api.listTicketTodos>>[number]): TicketItem {
  return {
    key: row.key ?? String(row.id),
    id: row.id,
    ident: row.ident,
    title: row.title,
    stateTitle: row.stateTitle,
    sprintId: row.sprintId,
    sprintTitle: row.sprintTitle,
    programId: row.programId,
    url: row.url,
    priority: row.priority ?? "未设置",
    priorityRank: row.priorityRank,
    kind: row.kind,
    topicId: row.topicId,
    pipelineStage: row.pipelineStage as TicketItem["pipelineStage"],
    held: row.held,
  };
}

function toDetail(
  row: Awaited<ReturnType<typeof api.getTicketDetail>>,
): TicketDetail {
  return {
    ...toTicket(row as Awaited<ReturnType<typeof api.listTicketTodos>>[number]),
    description: row.description ?? "",
    authorName: row.authorName ?? "未知",
    planStartedAt: row.planStartedAt,
    deadline: row.deadline,
    imageUrls: row.imageUrls ?? [],
    imageSrcs: row.imageSrcs,
  };
}

const PROVIDER_STORAGE_KEY = "zy-aos:tickets:provider";

function readStoredProviderId(): TicketProviderId | null {
  try {
    const value = localStorage.getItem(PROVIDER_STORAGE_KEY);
    return value === "gitee" || value === "zentao" ? value : null;
  } catch {
    return null;
  }
}

function readStoredProjectId(provider: TicketProviderId): string | null {
  try {
    return localStorage.getItem(`zy-aos:tickets:project:${provider}`);
  } catch {
    return null;
  }
}

export function TicketInbox({ onCollapse }: TicketInboxProps) {
  const {
    workspace,
    setWorkspaceId,
    selectTopic,
    refreshAll,
  } = useShell();
  const navigate = useNavigate();

  const [provider, setProvider] = useState<TicketProviderId>(
    () => readStoredProviderId() ?? "gitee",
  );
  const [providerStatus, setProviderStatus] = useState<TicketsStatus["providers"]>([]);
  const [projects, setProjects] = useState<TicketProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statePickerOpen, setStatePickerOpen] = useState(false);
  const [statePickerTicket, setStatePickerTicket] = useState<TicketItem | null>(
    null,
  );
  const [configOpen, setConfigOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [notesByTicketKey, setNotesByTicketKey] = useState<Record<string, string>>(
    {},
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [todosLoading, setTodosLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [includeAll, setIncludeAll] = useState(false);
  // 队列筛选：全部 / 待派 / 处理中 / 已完成 / 暂不处理
  const [queueFilter, setQueueFilter] = useState<
    "all" | "pending" | "active" | "done" | "held"
  >("all");
  // 当前打开 ⋯ 菜单的工单 key（同时只开一个）；菜单走 portal 悬浮，
  // 不受工单列表滚动容器裁剪
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  function closeMenu() {
    setMenuKey(null);
    setMenuPos(null);
  }

  function openMenu(ticket: TicketItem, button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    const MENU_W = 136;
    const MENU_H = 132;
    const left = Math.max(
      8,
      Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8),
    );
    const top =
      rect.bottom + 4 + MENU_H > window.innerHeight
        ? Math.max(8, rect.top - MENU_H - 4)
        : rect.bottom + 4;
    setMenuPos({ top, left });
    setMenuKey(ticket.key);
  }

  const providerLabel =
    PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  // 只展示已配置的来源；未配置的以「＋去配置」引导形式出现。
  const configuredProviders = useMemo(
    () =>
      PROVIDERS.filter(
        (item) =>
          providerStatus.find((s) => s.id === item.id)?.configured ?? false,
      ),
    [providerStatus],
  );
  const unconfiguredProviders = useMemo(
    () =>
      PROVIDERS.filter(
        (item) =>
          providerStatus.length > 0 &&
          !(providerStatus.find((s) => s.id === item.id)?.configured ?? false),
      ),
    [providerStatus],
  );



  const project = projects.find((p) => p.id === projectId) ?? null;

  // 队列口径：暂不处理优先归 held；已派未完成 = 处理中；完成/阻塞单列
  const queue = useMemo(() => {
    let pending = 0;
    let active = 0;
    let done = 0;
    let held = 0;
    for (const t of tickets) {
      if (t.held) held++;
      else if (t.pipelineStage === "completed") done++;
      else if (t.topicId) active++;
      else pending++;
    }
    return { pending, active, done, held };
  }, [tickets]);

  const visibleTickets = useMemo(() => {
    if (queueFilter === "all") return tickets;
    return tickets.filter((t) => {
      if (queueFilter === "held") return Boolean(t.held);
      if (queueFilter === "pending") return !t.topicId && !t.held;
      if (queueFilter === "active")
        return Boolean(t.topicId) && t.pipelineStage !== "completed" && !t.held;
      return t.pipelineStage === "completed" && !t.held;
    });
  }, [tickets, queueFilter]);

  const groups = useMemo(
    () => groupTicketsBySprint(visibleTickets),
    [visibleTickets],
  );
  const selected =
    tickets.find((t) => t.key === selectedKey) ?? tickets[0] ?? null;

  const loadProjects = useCallback(async (target: TicketProviderId) => {
    const status = await api.ticketsStatus();
    setProviderStatus(status.providers);
    // 目标来源未配置时自动落到第一个已配置来源（事件处修正，不进 effect）。
    const configuredIds = status.providers
      .filter((item) => item.configured)
      .map((item) => item.id);
    const resolved = configuredIds.includes(target)
      ? target
      : ((configuredIds[0] as TicketProviderId | undefined) ?? target);
    if (resolved !== target) {
      setProvider(resolved);
      setSelectedKey(null);
      setNotice(null);
      target = resolved;
      try {
        localStorage.setItem(PROVIDER_STORAGE_KEY, resolved);
      } catch {
        // 持久化失败不影响使用
      }
    }
    const list = (await api.listTicketProjects(target)).map(toProject);
    setProjects(list);
    // 切页回来时优先恢复上次选中的项目（按来源分别记忆）
    const stored = readStoredProjectId(target);
    setProjectId((prev) => {
      const next = list.some((p) => p.id === prev)
        ? prev
        : list.some((p) => p.id === stored)
          ? (stored as string)
          : (list[0]?.id ?? "");
      if (next) {
        try {
          localStorage.setItem(`zy-aos:tickets:project:${target}`, next);
        } catch {
          // 持久化失败不影响使用
        }
      }
      return next;
    });
  }, []);

  const loadTodos = useCallback(
    async (target: TicketProviderId, id: string, all: boolean) => {
      if (!id) {
        setTickets([]);
        return;
      }
      const list = (await api.listTicketTodos(target, id, { all })).map(toTicket);
      setTickets(list);
      setSelectedKey((prev) =>
        list.some((t) => t.key === prev) ? prev : (list[0]?.key ?? null),
      );
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProjects([]);
    setTickets([]);
    setProjectId("");
    void (async () => {
      try {
        await loadProjects(provider);
        if (!cancelled) setNotice(null);
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : "加载工单项目失败");
          setProjects([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, loadProjects]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setTodosLoading(true);
    void (async () => {
      try {
        await loadTodos(provider, projectId, includeAll);
        if (!cancelled) setNotice(null);
      } catch (error) {
        if (!cancelled) {
          setTickets([]);
          setNotice(error instanceof Error ? error.message : "拉取待办失败");
        }
      } finally {
        if (!cancelled) setTodosLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, projectId, includeAll, loadTodos]);

  async function openDetail(ticket: TicketItem) {
    if (!project) return;
    setSelectedKey(ticket.key);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setNotice(null);
    try {
      const row = await api.getTicketDetail(provider, project.id, ticket.key);
      setDetail(toDetail(row));
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "拉取工单详情失败",
      );
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleHandOff(ticket: TicketItem) {
    if (!project) return;
    if (!project.localPath?.trim()) {
      setNotice("请先配置该项目的本地工作目录。");
      setConfigOpen(true);
      return;
    }
    setBusy(true);
    setNotice(null);
    const note = notesByTicketKey[ticket.key]?.trim() || undefined;
    try {
      const result = await api.dispatchTicket({
        provider,
        projectId: project.id,
        issueKey: ticket.key,
        workspaceId: workspace?.id,
        note,
      });
      // 先刷新列表/对齐工作区（切换工作区会重置选择），最后激活派单话题
      await refreshAll();
      const workspaces = await api.listWorkspaces();
      const matched = workspaces.find((w) =>
        w.localPath.replace(/\\/g, "/").toLowerCase() ===
        project.localPath!.replace(/\\/g, "/").toLowerCase(),
      );
      if (matched) setWorkspaceId(matched.id);
      selectTopic(result.topicId);
      // 待办重拉较慢（内网聚合），放后台不挡激活
      void loadTodos(provider, project.id, includeAll).catch(() => {});
      setNotesByTicketKey((prev) => {
        const next = { ...prev };
        delete next[ticket.key];
        return next;
      });
      setDetailOpen(false);
      setNotice(`已交给 CEO：${ticket.ident}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "派发失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleHoldToggle(ticket: TicketItem) {
    if (!project) return;
    const held = !ticket.held;
    setBusy(true);
    setNotice(null);
    try {
      await api.setTicketHold({
        provider,
        projectId: project.id,
        issueKey: ticket.key,
        held,
      });
      setTickets((prev) =>
        prev.map((t) => (t.key === ticket.key ? { ...t, held: held || undefined } : t)),
      );
      setNotice(
        held
          ? `已标记暂不处理：${ticket.ident}（自动派单会跳过）`
          : `已恢复派单：${ticket.ident}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProject(next: TicketProject) {
    const saved = toProject(
      await api.updateTicketProject(provider, next.id, {
        localPath: next.localPath,
        defaultEngine: next.defaultEngine,
        cast: next.cast,
        testBaseUrl: next.testBaseUrl,
        testStartCommand: next.testStartCommand,
      }),
    );
    setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
    setNotice(`已保存「${saved.name}」配置`);
  }

  return (
    <div className="ticket-inbox">
      <header className="ticket-inbox-header">
        <div className="ticket-inbox-title">
          <IconTicket size={15} />
          <span>工单</span>
        </div>
        <div className="ticket-inbox-tools">
          <button
            type="button"
            className="icon-btn"
            title="刷新项目"
            aria-label="刷新项目"
            disabled={loading || todosLoading}
            onClick={() => {
              setLoading(true);
              setTodosLoading(true);
              void (async () => {
                try {
                  await loadProjects(provider);
                  if (projectId) {
                    await loadTodos(provider, projectId, includeAll);
                  }
                  setNotice(`已从 ${providerLabel} 刷新项目列表`);
                } catch (error) {
                  setNotice(
                    error instanceof Error ? error.message : "刷新失败",
                  );
                } finally {
                  setLoading(false);
                  setTodosLoading(false);
                }
              })();
            }}
          >
            ↻
          </button>
          <button
            type="button"
            className="icon-btn"
            title="工单状态"
            aria-label="工单状态"
            onClick={() => setStatusOpen(true)}
          >
            <IconActivity size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="项目配置"
            aria-label="项目配置"
            onClick={() => setConfigOpen(true)}
            disabled={!project}
          >
            <IconSettings size={15} />
          </button>
          <button
            type="button"
            className="icon-btn right-panel-collapse"
            onClick={onCollapse}
            title="折叠右侧面板"
            aria-label="折叠右侧面板"
          >
            ›
          </button>
        </div>
      </header>

      {configuredProviders.length > 0 &&
      (configuredProviders.length > 1 || unconfiguredProviders.length > 0) ? (
        <div
          className="ticket-provider-tabs"
          role="tablist"
          aria-label="工单来源"
        >
          {configuredProviders.map((item) => {
            const active = item.id === provider;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={
                  active ? "ticket-provider-tab is-active" : "ticket-provider-tab"
                }
                onClick={() => {
                  if (!active) {
                    setProvider(item.id);
                    setSelectedKey(null);
                    setNotice(null);
                    try {
                      localStorage.setItem(PROVIDER_STORAGE_KEY, item.id);
                    } catch {
                      // 持久化失败不影响使用
                    }
                  }
                }}
              >
                {item.label}
              </button>
            );
          })}
          {unconfiguredProviders.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ticket-provider-tab is-unconfigured"
              title={`尚未配置${item.label}，点击去设置`}
              onClick={() => navigate("/settings")}
            >
              ＋{item.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="ticket-project-bar">
        <label className="ticket-project-select">
          <span className="sr-only">工单项目</span>
          <select
            value={projectId}
            disabled={projects.length === 0 || todosLoading}
            onChange={(e) => {
              setProjectId(e.target.value);
              setSelectedKey(null);
              setNotice(null);
              try {
                localStorage.setItem(
                  `zy-aos:tickets:project:${provider}`,
                  e.target.value,
                );
              } catch {
                // 持久化失败不影响使用
              }
            }}
          >
            {projects.length === 0 ? (
              <option value="">未配置项目</option>
            ) : (
              projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="ticket-project-meta">
          <span className={`ticket-engine is-${project?.defaultEngine ?? "claude"}`}>
            {project?.defaultEngine === "codex" ? "Codex" : "Claude"}
          </span>
          {project?.localPath ? (
            <span className="ticket-path-chip mono" title={project.localPath}>
              {project.localPath.replace(/^.*[\\/]/, "") || project.localPath}
            </span>
          ) : project ? (
            <button
              type="button"
              className="ticket-path-missing"
              onClick={() => setConfigOpen(true)}
              title="为此项目绑定本地工作目录"
            >
              配置本地目录
            </button>
          ) : null}
          <label className="ticket-scope-toggle">
            <input
              type="checkbox"
              checked={includeAll}
              onChange={(e) => setIncludeAll(e.target.checked)}
            />
            <span>含非待办</span>
          </label>
        </div>
      </div>

      <div className="ticket-queue-bar" aria-label="工单队列">
        {(
          [
            ["all", `全部 ${tickets.length}`],
            ["pending", `待派 ${queue.pending}`],
            ["active", `处理中 ${queue.active}`],
            ["done", `已完成 ${queue.done}`],
            ["held", `暂不处理 ${queue.held}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={
              queueFilter === key
                ? "ticket-queue-chip is-active"
                : "ticket-queue-chip"
            }
            aria-pressed={queueFilter === key}
            onClick={() => setQueueFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {notice ? (
        <p className="ticket-notice" role="status">
          {notice}
        </p>
      ) : null}
      {providerStatus.length > 0 && configuredProviders.length === 0 ? (
        <div className="ticket-notice" role="status">
          <p>还没有配置任何工单来源。</p>
          <button
            type="button"
            className="ticket-path-missing"
            onClick={() => navigate("/settings")}
          >
            去设置 → 集成工单
          </button>
        </div>
      ) : null}

      {configuredProviders.length === 0 ? null : (
      <div className="ticket-inbox-scroll" onScroll={closeMenu}>
        {loading || todosLoading ? (
          <div className="ticket-loading" role="status" aria-live="polite">
            <span className="ticket-loading-spinner" aria-hidden />
            <p>{loading ? "加载项目列表…" : "正在拉取工单…"}</p>
          </div>
        ) : groups.length === 0 ? (
          <p className="ticket-empty-hint">
            {projects.length === 0
              ? provider === "gitee"
                ? "未拉到 Gitee 项目。请检查凭证，或点刷新；也可放一份可选白名单 config/gitee-projects.json。"
                : "未拉到禅道项目。请检查服务地址与账号权限，或点刷新。"
              : "当前项目没有待办工单。"}
          </p>
        ) : (
          groups.map((group, groupIndex) => (
            <section
              key={group.sprintTitle}
              className="ticket-sprint"
              style={{ animationDelay: `${groupIndex * 60}ms` }}
            >
              <header className="ticket-sprint-head">
                <span className="ticket-sprint-rail" aria-hidden />
                <h4>{group.sprintTitle}</h4>
                <span className="ticket-sprint-count">{group.tickets.length}</span>
              </header>
              <ul className="ticket-card-list">
                {group.tickets.map((ticket, index) => {
                  const active = selected?.key === ticket.key;
                  // 左侧状态竖条：处理中呼吸、暂不处理琥珀、完成绿、阻塞红
                  const rail = ticket.held
                    ? "is-held"
                    : ticket.pipelineStage === "completed"
                      ? "is-done"
                      : ticket.pipelineStage === "blocked"
                        ? "is-blocked"
                        : ticket.topicId
                          ? "is-running"
                          : "";
                  return (
                    <li
                      key={ticket.key}
                      className={[
                        "ticket-card",
                        active ? "is-active" : "",
                        rail,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ animationDelay: `${80 + index * 45}ms` }}
                    >
                      <button
                        type="button"
                        className="ticket-card-main"
                        onClick={() => void openDetail(ticket)}
                      >
                        <div className="ticket-card-top">
                          {ticket.kind ? (
                            <span
                              className={
                                ticket.kind === "bug"
                                  ? "ticket-kind-dot is-bug"
                                  : "ticket-kind-dot is-task"
                              }
                              title={ticket.kind === "bug" ? "缺陷" : "任务"}
                              aria-hidden="true"
                            />
                          ) : null}
                          <span className="ticket-ident mono">{ticket.ident}</span>
                          <span
                            className={`ticket-priority-badge is-rank-${Math.min(3, Math.floor((ticket.priorityRank ?? 40) / 10))}`}
                          >
                            {ticket.priority}
                          </span>
                          {ticket.held ? (
                            <span className="ticket-held-chip">暂不处理</span>
                          ) : null}
                        </div>
                        <p className="ticket-card-title">{ticket.title}</p>
                      </button>
                      <div className="ticket-card-actions">
                        <button
                          type="button"
                          className="ticket-handoff"
                          disabled={busy}
                          onClick={() => void handleHandOff(ticket)}
                        >
                          交给 CEO
                        </button>
                        <button
                          type="button"
                          className="ticket-more"
                          aria-label="更多操作"
                          aria-haspopup="menu"
                          aria-expanded={menuKey === ticket.key}
                          title="改状态 / 暂不处理 / 打开原单"
                          disabled={busy}
                          onClick={(e) => {
                            if (menuKey === ticket.key) {
                              closeMenu();
                              return;
                            }
                            openMenu(ticket, e.currentTarget);
                          }}
                        >
                          ⋯
                        </button>
                        {menuKey === ticket.key && menuPos
                          ? createPortal(
                              <>
                                <div
                                  className="ticket-menu-backdrop"
                                  onClick={closeMenu}
                                  aria-hidden="true"
                                />
                                <div
                                  className="ticket-card-menu"
                                  role="menu"
                                  style={menuPos}
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      closeMenu();
                                      setSelectedKey(ticket.key);
                                      setStatePickerTicket(ticket);
                                      setStatePickerOpen(true);
                                      setNotice(null);
                                    }}
                                  >
                                    改状态
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      closeMenu();
                                      void handleHoldToggle(ticket);
                                    }}
                                  >
                                    {ticket.held ? "恢复派单" : "暂不处理"}
                                  </button>
                                  {ticket.url ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        closeMenu();
                                        window.open(ticket.url, "_blank", "noopener");
                                      }}
                                    >
                                      打开原单
                                    </button>
                                  ) : null}
                                </div>
                              </>,
                              document.body,
                            )
                          : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      )}

      <TicketDetailDrawer
        open={detailOpen}
        loading={detailLoading}
        error={detailError}
        detail={detail}
        provider={provider}
        note={detail ? (notesByTicketKey[detail.key] ?? "") : ""}
        onNoteChange={(value) => {
          if (!detail) return;
          setNotesByTicketKey((prev) => ({ ...prev, [detail.key]: value }));
        }}
        onClose={() => {
          if (detail) {
            setNotesByTicketKey((prev) => {
              const next = { ...prev };
              delete next[detail.key];
              return next;
            });
          }
          setDetailOpen(false);
        }}
      />
      <TicketStatusPopover
        open={statusOpen}
        project={project}
        ticket={selected}
        onClose={() => setStatusOpen(false)}
      />
      <TicketStatePicker
        open={statePickerOpen}
        provider={provider}
        projectId={project?.id ?? null}
        ticket={statePickerTicket}
        onClose={() => {
          setStatePickerOpen(false);
          setStatePickerTicket(null);
        }}
        onApplied={(stateTitle) => {
          setNotice(`已同步：${stateTitle}`);
          if (project) {
            void loadTodos(provider, project.id, includeAll).catch((error) => {
              setNotice(
                error instanceof Error ? error.message : "刷新工单失败",
              );
            });
          }
        }}
      />
      <TicketProjectConfig
        open={configOpen}
        project={project}
        defaultLocalPath={workspace?.localPath}
        onClose={() => setConfigOpen(false)}
        onSave={(next) => void handleSaveProject(next)}
      />
    </div>
  );
}
