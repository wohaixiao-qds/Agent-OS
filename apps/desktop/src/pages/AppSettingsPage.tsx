import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AppSettings, EngineKind } from "@zy-aos/shared";
import {
  api,
  type GiteeIntegrationSettings,
  type UpdateGiteeIntegrationInput,
  type ZentaoIntegrationSettings,
  type UpdateZentaoIntegrationInput,
} from "../lib/api";
import type { ThemeMode } from "../lib/theme";
import { pickFolder } from "../lib/tauri";
import type { AppOutletContext } from "../lib/app-context";

const THEMES: ThemeMode[] = ["warm", "light", "dark", "system"];
const ENGINES: EngineKind[] = ["claude", "codex"];

const THEME_LABEL: Record<ThemeMode, string> = {
  warm: "暖色",
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

const TOKEN_PLACEHOLDER = "••••";

export function AppSettingsPage() {
  const { theme, onThemeChange } = useOutletContext<AppOutletContext>();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [gitee, setGitee] = useState<GiteeIntegrationSettings | null>(null);
  const [integrationProvider, setIntegrationProvider] = useState<
    "gitee" | "zentao"
  >("gitee");
  const [tokenDraft, setTokenDraft] = useState("");
  const [enterpriseId, setEnterpriseId] = useState("");
  const [userId, setUserId] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [giteeError, setGiteeError] = useState<string | null>(null);
  const [zentao, setZentao] = useState<ZentaoIntegrationSettings | null>(null);
  const [zentaoBaseUrl, setZentaoBaseUrl] = useState("");
  const [zentaoAccount, setZentaoAccount] = useState("");
  const [zentaoPasswordDraft, setZentaoPasswordDraft] = useState("");
  const [zentaoError, setZentaoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus(err instanceof Error ? err.message : "加载设置失败");
          setSettings({
            theme,
            defaultEngine: "claude",
            dataDir: "",
            notifications: true,
          });
        }
      });
    api
      .getGiteeIntegration()
      .then((integration) => {
        if (cancelled) return;
        setGiteeError(null);
        applyGiteeView(integration);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "加载 Gitee 配置失败";
        setGiteeError(
          /404|Not Found/i.test(message)
            ? "Gitee 集成接口不可用（HTTP 404）。安装版请换带新 runtime 的安装包重装；开发版请重启 runtime（pnpm dev:runtime）"
            : message,
        );
      });
    api
      .getZentaoIntegration()
      .then((integration) => {
        if (cancelled) return;
        setZentaoError(null);
        applyZentaoView(integration);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setZentaoError(
          err instanceof Error ? err.message : "加载禅道配置失败",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [theme]);

  function applyZentaoView(integration: ZentaoIntegrationSettings) {
    setZentao(integration);
    setZentaoBaseUrl(integration.baseUrl);
    setZentaoAccount(integration.account);
    setZentaoPasswordDraft(integration.passwordMasked ?? "");
  }

  function applyGiteeView(integration: GiteeIntegrationSettings) {
    setGitee(integration);
    setTokenDraft(integration.tokenMasked ?? "");
    setEnterpriseId(integration.enterpriseId);
    setUserId(integration.userId);
    setApiBase(integration.apiBase);
  }

  async function persist(patch: Partial<AppSettings>) {
    if (!settings) return;
    setBusy(true);
    setStatus(null);
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const saved = await api.patchSettings(patch);
      setSettings(saved);
      setStatus("已保存");
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  function handleTheme(mode: ThemeMode) {
    onThemeChange(mode);
    setSettings((prev) => (prev ? { ...prev, theme: mode } : prev));
    setStatus("主题已更新");
  }

  async function handleBrowseDataDir() {
    const path = await pickFolder();
    if (path) await persist({ dataDir: path });
  }

  async function persistGitee(extra?: UpdateGiteeIntegrationInput) {
    setBusy(true);
    setStatus(null);
    try {
      const patch: UpdateGiteeIntegrationInput = {
        enterpriseId,
        userId,
        apiBase,
        ...extra,
      };
      const trimmedToken = tokenDraft.trim();
      if (
        trimmedToken &&
        !trimmedToken.startsWith(TOKEN_PLACEHOLDER) &&
        trimmedToken !== (gitee?.tokenMasked ?? "")
      ) {
        patch.token = trimmedToken;
      }
      const saved = await api.patchGiteeIntegration(patch);
      setGiteeError(null);
      applyGiteeView(saved);
      setStatus("Gitee 集成已保存");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "保存失败";
      setStatus(
        /404|Not Found/i.test(message)
          ? "保存失败：集成接口 404。安装版请换新安装包重装；开发版请重启 runtime（pnpm dev:runtime）"
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function clearGiteeToken() {
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api.patchGiteeIntegration({ clearToken: true });
      applyGiteeView(saved);
      setTokenDraft("");
      setStatus("已清除存档中的 Token（环境变量不受影响）");
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "清除失败");
    } finally {
      setBusy(false);
    }
  }

  async function testGitee() {
    setBusy(true);
    setStatus(null);
    try {
      const patch: UpdateGiteeIntegrationInput = {
        enterpriseId,
        userId,
        apiBase,
      };
      const trimmedToken = tokenDraft.trim();
      if (
        trimmedToken &&
        !trimmedToken.startsWith(TOKEN_PLACEHOLDER) &&
        trimmedToken !== (gitee?.tokenMasked ?? "")
      ) {
        patch.token = trimmedToken;
      }
      const saved = await api.patchGiteeIntegration(patch);
      applyGiteeView(saved);
      const result = await api.testGiteeConnection();
      setStatus(result.message);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  async function persistZentao(extra?: UpdateZentaoIntegrationInput) {
    setBusy(true);
    setStatus(null);
    try {
      const patch: UpdateZentaoIntegrationInput = {
        baseUrl: zentaoBaseUrl.trim(),
        account: zentaoAccount.trim(),
        ...extra,
      };
      const trimmed = zentaoPasswordDraft.trim();
      if (
        trimmed &&
        !trimmed.startsWith(TOKEN_PLACEHOLDER) &&
        trimmed !== (zentao?.passwordMasked ?? "")
      ) {
        patch.password = trimmed;
      }
      const saved = await api.patchZentaoIntegration(patch);
      setZentaoError(null);
      applyZentaoView(saved);
      setStatus("禅道配置已保存");
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function clearZentaoPassword() {
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api.patchZentaoIntegration({ clearPassword: true });
      applyZentaoView(saved);
      setZentaoPasswordDraft("");
      setStatus("已清除存档中的密码（环境变量不受影响）");
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "清除失败");
    } finally {
      setBusy(false);
    }
  }

  async function testZentao() {
    setBusy(true);
    setStatus(null);
    try {
      const patch: UpdateZentaoIntegrationInput = {
        baseUrl: zentaoBaseUrl.trim(),
        account: zentaoAccount.trim(),
      };
      const trimmed = zentaoPasswordDraft.trim();
      if (
        trimmed &&
        !trimmed.startsWith(TOKEN_PLACEHOLDER) &&
        trimmed !== (zentao?.passwordMasked ?? "")
      ) {
        patch.password = trimmed;
      }
      const saved = await api.patchZentaoIntegration(patch);
      applyZentaoView(saved);
      const result = await api.testZentaoConnection();
      setStatus(result.message);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="page">
        <p className="muted">正在加载设置…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="muted">设置</p>
          <h1>应用偏好</h1>
          <p className="page-lead">全局设置与开发环境配置。</p>
        </div>
      </header>

      <section className="panel-form">
        <h2 className="section-title">执行引擎</h2>
        <label className="field">
          <span>默认引擎</span>
          <select
            value={settings.defaultEngine}
            disabled={busy}
            onChange={(e) =>
              persist({ defaultEngine: e.target.value as EngineKind })
            }
          >
            {ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {engine === "codex" ? "Codex" : "Claude Code"}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel-form">
        <h2 className="section-title">工作区环境</h2>
        <label className="field">
          <span>默认数据目录</span>
          <div className="field-row">
            <input
              className="mono"
              value={settings.dataDir}
              disabled={busy}
              onChange={(e) =>
                setSettings({ ...settings, dataDir: e.target.value })
              }
              onBlur={() => persist({ dataDir: settings.dataDir })}
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={handleBrowseDataDir}
            >
              浏览
            </button>
          </div>
          <span className="field-hint">
            用于存放智能体日志、上下文文件与临时产物。
          </span>
        </label>
      </section>

      <section className="panel-form">
        <h2 className="section-title">集成工单</h2>

        <label className="field">
          <span>工单来源</span>
          <select
            value={integrationProvider}
            disabled={busy}
            onChange={(e) => {
              setIntegrationProvider(e.target.value as "gitee" | "zentao");
              setStatus(null);
            }}
          >
            <option value="gitee">Gitee 企业工单</option>
            <option value="zentao">禅道（Bug + 任务）</option>
          </select>
        </label>

        {integrationProvider === "gitee" ? (
          <>
            <p className="field-hint">
              如何获取：打开 Gitee 企业版 → 私人令牌 / Access
              Token，复制 token；企业 ID 与用户 ID 可在企业设置或 API
              文档中查看。
            </p>

            {giteeError ? <p className="form-error">{giteeError}</p> : null}

        {gitee?.envOverridesActive ? (
          <p className="form-status">
            当前有环境变量覆盖存档（
            {[
              gitee.sources.token === "env" ? "token" : null,
              gitee.sources.enterpriseId === "env" ? "enterpriseId" : null,
              gitee.sources.userId === "env" ? "userId" : null,
              gitee.sources.apiBase === "env" ? "apiBase" : null,
            ]
              .filter(Boolean)
              .join("、")}
            ）。测连通与工单将以环境变量为准。
          </p>
        ) : null}

        <label className="field">
          <span>Access Token</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={gitee?.tokenSet ? "已保存，留空或保持遮罩则不修改" : "粘贴 Gitee Token"}
            value={tokenDraft}
            disabled={busy}
            onChange={(e) => setTokenDraft(e.target.value)}
            onFocus={() => {
              if (tokenDraft.startsWith(TOKEN_PLACEHOLDER)) setTokenDraft("");
            }}
          />
        </label>
        <label className="field">
          <span>企业 ID</span>
          <input
            className="mono"
            value={enterpriseId}
            disabled={busy}
            onChange={(e) => setEnterpriseId(e.target.value)}
          />
        </label>
        <label className="field">
          <span>用户 ID</span>
          <input
            className="mono"
            value={userId}
            disabled={busy}
            onChange={(e) => setUserId(e.target.value)}
          />
        </label>
        <label className="field">
          <span>API Base（可选）</span>
          <input
            className="mono"
            value={apiBase}
            disabled={busy}
            onChange={(e) => setApiBase(e.target.value)}
          />
        </label>

        <div className="form-actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !gitee?.tokenSet}
            onClick={() => void clearGiteeToken()}
          >
            清除存档 Token
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => void testGitee()}
          >
            测试连接
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void persistGitee()}
          >
            保存 Gitee 配置
          </button>
        </div>
          </>
        ) : (
          <>
            <p className="field-hint">
              填写禅道服务地址（如 http://zentao.corp.local）与账号密码。认证使用
              REST API（api.php/v1），密码只保存在本机数据目录；HTTP
              地址为明文传输，建议内网可信环境或启用 HTTPS。
            </p>

            {zentaoError ? <p className="form-error">{zentaoError}</p> : null}

        {zentao?.envOverridesActive ? (
          <p className="form-status">
            当前有环境变量覆盖存档（
            {[
              zentao.sources.baseUrl === "env" ? "baseUrl" : null,
              zentao.sources.account === "env" ? "account" : null,
              zentao.sources.password === "env" ? "password" : null,
            ]
              .filter(Boolean)
              .join("、")}
            ）。测连通与工单将以环境变量为准（ZY_AOS_ZENTAO_*）。
          </p>
        ) : null}

        <label className="field">
          <span>服务地址</span>
          <input
            className="mono"
            placeholder="http://zentao.corp.local"
            value={zentaoBaseUrl}
            disabled={busy}
            onChange={(e) => setZentaoBaseUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span>账号</span>
          <input
            className="mono"
            value={zentaoAccount}
            disabled={busy}
            onChange={(e) => setZentaoAccount(e.target.value)}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={
              zentao?.passwordMasked
                ? "已保存，留空或保持遮罩则不修改"
                : "输入禅道账号密码"
            }
            value={zentaoPasswordDraft}
            disabled={busy}
            onChange={(e) => setZentaoPasswordDraft(e.target.value)}
            onFocus={() => {
              if (zentaoPasswordDraft.startsWith(TOKEN_PLACEHOLDER)) {
                setZentaoPasswordDraft("");
              }
            }}
          />
        </label>

        <div className="form-actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !zentao?.passwordMasked}
            onClick={() => void clearZentaoPassword()}
          >
            清除存档密码
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => void testZentao()}
          >
            测试连接
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void persistZentao()}
          >
            保存禅道配置
          </button>
        </div>
          </>
        )}

        {status ? <p className="form-status">{status}</p> : null}

        {integrationProvider === "gitee" ? (
          <>
            <h3 className="section-title" style={{ marginTop: 8 }}>
              项目绑定
            </h3>
        <p className="field-hint">
          登录后项目列表优先从 Gitee 拉取。本地工作目录与参与 Bot 在工作台工单面板配置。可选白名单文件：
          <code className="mono">
            {" "}
            {giteeError
              ? "（接口未就绪）"
              : (gitee?.projectsConfigPath ?? "（加载中）")}{" "}
          </code>
          {gitee?.projectsConfigViaEnv
            ? "（由环境变量 GITEE_PROJECTS_CONFIG / ZY_AOS_GITEE_PROJECTS_CONFIG 覆盖）"
            : "（默认位于数据目录；仓库内仅保留 example）"}
              {gitee != null ? ` · 白名单条目 ${gitee.allowlistCount}` : null}
            </p>
          </>
        ) : null}
      </section>

      <section className="panel-form">
        <h2 className="section-title">界面</h2>
        <div className="settings-row">
          <div>
            <strong>外观</strong>
            <p className="field-hint">默认暖色。也可切换浅色、深色，或跟随系统。</p>
          </div>
          <div className="segmented" role="group" aria-label="主题">
            {THEMES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? "active" : ""}
                onClick={() => handleTheme(mode)}
                disabled={busy}
              >
                {THEME_LABEL[mode]}
              </button>
            ))}
          </div>
        </div>
        <label className="field checkbox-field settings-row">
          <div>
            <strong>系统通知</strong>
            <p className="field-hint">
              当智能体需要人工确认（HITL）时提醒我。
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.notifications}
            disabled={busy}
            onChange={(e) => persist({ notifications: e.target.checked })}
          />
        </label>
      </section>

      {status ? <p className="form-status">{status}</p> : null}
    </div>
  );
}
