import type { ZentaoEnvConfig } from "./credentials.js";

/**
 * ZenTao REST client (api.php/v1, validated against open-source 21.6.1).
 * Auth: POST /tokens with account+password → Token header, cached in-process
 * and refreshed once on 401 (same flow as the tianjin-library zentao-mcp).
 */

export class ZentaoClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZentaoClientError";
  }
}

export interface ZentaoRequestOptions {
  method?: string;
  body?: unknown;
  searchParams?: URLSearchParams;
}

export interface ZentaoProject {
  id: number;
  name: string;
  code?: string;
  status?: string;
}

export interface ZentaoExecution {
  id: number;
  name: string;
  project?: number;
  status?: string;
}

export interface ZentaoProduct {
  id: number;
  name: string;
  status?: string;
  /** 未解决 Bug 数；todo 拉取时可跳过为 0 的产品。 */
  unresolvedBugs?: number;
}

export interface ZentaoProductRef {
  id: number;
  name?: string;
}

export interface ZentaoExecutionDetail {
  id: number;
  name: string;
  project?: number;
  /** 执行关联的产品 —— Bug 的真实归属范围（21.6.1 实测字段）。 */
  products: ZentaoProductRef[];
}

export type ZentaoUserRef = string | { account?: string; realname?: string } | null;

export interface ZentaoTask {
  id: number;
  name: string;
  status: string;
  pri: number;
  assignedTo: ZentaoUserRef;
  execution?: number;
  project?: number;
  deadline?: string;
  openedBy?: ZentaoUserRef;
  desc?: string;
}

export interface ZentaoBug {
  id: number;
  title: string;
  status: string;
  severity?: number;
  pri?: number;
  assignedTo: ZentaoUserRef;
  product?: number;
  project?: number;
  openedBy?: ZentaoUserRef;
  deadline?: string;
  steps?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
/** 全量翻页上限（407 条 Bug = 5 页；留足余量）。 */
const FULL_PAGINATION_PAGES = 200;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function userAccount(value: ZentaoUserRef | unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object") {
    const ref = value as { account?: unknown; realname?: unknown };
    return asString(ref.account) ?? asString(ref.realname);
  }
  return undefined;
}

function expectList<T>(
  body: unknown,
  key: string,
  context: string,
  map: (row: Record<string, unknown>) => T | undefined,
): T[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])
      ? ((body as Record<string, unknown>)[key] as unknown[])
      : undefined;
  if (!raw) {
    throw new ZentaoClientError(`禅道 ${context} 响应格式不正确`);
  }
  const out: T[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const mapped = map(item as Record<string, unknown>);
    if (mapped) out.push(mapped);
  }
  return out;
}

function expectObject(
  body: unknown,
  context: string,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ZentaoClientError(`禅道 ${context} 响应格式不正确`);
  }
  return body as Record<string, unknown>;
}

export class ZentaoClient {
  private token: string | undefined;
  private authenticationPromise: Promise<string> | undefined;

  constructor(
    readonly config: ZentaoEnvConfig & { requestTimeoutMs?: number },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private apiUrl(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    return `${base}/api.php/v1${path}`;
  }

  private async authenticate(): Promise<string> {
    if (!this.authenticationPromise) {
      this.authenticationPromise = (async () => {
        const response = await this.fetcher(this.apiUrl("/tokens"), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            account: this.config.account,
            password: this.config.password,
          }),
          signal: AbortSignal.timeout(
            this.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
          ),
        });
        const body = (await response.json().catch(() => undefined)) as
          | Record<string, unknown>
          | undefined;
        const token = asString(body?.token);
        if (!response.ok || !token) {
          this.authenticationPromise = undefined;
          throw new ZentaoClientError(
            `禅道认证失败（HTTP ${response.status}），请检查服务地址、账号密码与 API 访问权限`,
            response.status,
          );
        }
        this.token = token;
        return token;
      })().finally(() => {
        this.authenticationPromise = undefined;
      });
    }
    return this.authenticationPromise;
  }

  async request<T>(
    path: string,
    options: ZentaoRequestOptions = {},
    retryAfterAuthentication = true,
  ): Promise<T> {
    const url = new URL(this.apiUrl(path));
    if (options.searchParams) url.search = options.searchParams.toString();
    const response = await this.fetcher(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Token: this.token ?? (await this.authenticate()),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(
        this.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ),
    });
    const text = await response.text();
    const body: unknown = text ? safeJsonParse(text) : undefined;
    if (!response.ok) {
      if (response.status === 401 && retryAfterAuthentication) {
        this.token = undefined;
        await this.authenticate();
        return this.request<T>(path, options, false);
      }
      throw new ZentaoClientError(
        `禅道 API 请求失败（HTTP ${response.status}）${errorDetail(body)}`,
        response.status,
      );
    }
    return body as T;
  }

  /** Download a file by id with the same Token auth (screenshots etc). */
  async downloadFile(
    fileId: number,
    retryAfterAuthentication = true,
  ): Promise<{ bytes: Buffer; mime?: string }> {
    const url = new URL(this.apiUrl(`/files/${fileId}`));
    const response = await this.fetcher(url, {
      headers: {
        Accept: "application/octet-stream,image/*",
        Token: this.token ?? (await this.authenticate()),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 401 && retryAfterAuthentication) {
        this.token = undefined;
        await this.authenticate();
        return this.downloadFile(fileId, false);
      }
      throw new ZentaoClientError(
        `禅道附件下载失败（HTTP ${response.status}）`,
        response.status,
      );
    }
    const array = await response.arrayBuffer();
    return {
      bytes: Buffer.from(array),
      mime: response.headers.get("content-type") ?? undefined,
    };
  }

  private async paged<T>(
    path: string,
    key: string,
    map: (row: Record<string, unknown>) => T | undefined,
    extraParams?: URLSearchParams,
    maxPages: number = MAX_PAGES,
  ): Promise<T[]> {
    const out: T[] = [];
    const limit = 100;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams(extraParams);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const body = await this.request<unknown>(path, { searchParams: params });
      const rows = expectList<T>(body, key, path, map);
      out.push(...rows);
      const meta =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const total = asNumber(meta.total);
      const serverLimit = asNumber(meta.limit) ?? limit;
      if (rows.length === 0) break;
      if (total !== undefined && out.length >= total) break;
      // Some servers clamp limit; stop only when the page came back short.
      if (rows.length < serverLimit && total === undefined) break;
    }
    return out;
  }

  listProjects(): Promise<ZentaoProject[]> {
    return this.paged<ZentaoProject>("/projects", "projects", (row) => {
      const id = asNumber(row.id);
      const name = asString(row.name);
      if (id === undefined || !name) return undefined;
      return {
        id,
        name,
        code: asString(row.code),
        status: asString(row.status),
      };
    });
  }

  listProjectExecutions(projectId: number): Promise<ZentaoExecution[]> {
    return this.paged<ZentaoExecution>(
      `/projects/${projectId}/executions`,
      "executions",
      (row) => {
        const id = asNumber(row.id);
        const name = asString(row.name);
        if (id === undefined || !name) return undefined;
        return {
          id,
          name,
          project: asNumber(row.project),
          status: asString(row.status),
        };
      },
    ).catch((error) => {
      // Some deployments expose executions only at the top level.
      if (error instanceof ZentaoClientError && error.status === 404) {
        return this.paged<ZentaoExecution>(
          "/executions",
          "executions",
          (row) => {
            const id = asNumber(row.id);
            const name = asString(row.name);
            if (id === undefined || !name) return undefined;
            if (asNumber(row.project) !== projectId) return undefined;
            return { id, name, project: asNumber(row.project) };
          },
        );
      }
      throw error;
    });
  }

  listProjectProducts(projectId: number): Promise<ZentaoProduct[]> {
    return this.paged<ZentaoProduct>(
      `/projects/${projectId}/products`,
      "products",
      (row) => mapProduct(row),
    ).catch((error) => {
      if (error instanceof ZentaoClientError && error.status === 404) {
        return this.paged<ZentaoProduct>("/products", "products", mapProduct);
      }
      throw error;
    });
  }

  listExecutionTasks(executionId: number): Promise<ZentaoTask[]> {
    return this.paged<ZentaoTask>(
      `/executions/${executionId}/tasks`,
      "tasks",
      mapTask,
    );
  }

  /** 执行详情：含关联产品（Bug 归属范围的可靠来源）。 */
  async getExecution(executionId: number): Promise<ZentaoExecutionDetail> {
    const row = expectObject(
      await this.request<unknown>(`/executions/${executionId}`),
      `执行 ${executionId}`,
    );
    const id = asNumber(row.id);
    const name = asString(row.name);
    if (id === undefined || !name) {
      throw new ZentaoClientError(`禅道执行 ${executionId} 不存在`, 404);
    }
    const rawProducts = Array.isArray(row.products) ? row.products : [];
    const products: ZentaoProductRef[] = [];
    for (const item of rawProducts) {
      const pid = asNumber(
        item && typeof item === "object"
          ? (item as Record<string, unknown>).id
          : item,
      );
      if (pid === undefined) continue;
      products.push({
        id: pid,
        name: asString(
          item && typeof item === "object"
            ? (item as Record<string, unknown>).name
            : undefined,
        ),
      });
    }
    return { id, name, project: asNumber(row.project), products };
  }

  /**
   * 产品 Bug 列表。full=true 时翻完 total（"指派给我"没有服务端过滤，
   * 必须全量拉取后按 assignedTo 过滤，对齐 tianjin-library zentao-mcp）。
   */
  listProductBugs(
    productId: number,
    options?: { full?: boolean },
  ): Promise<ZentaoBug[]> {
    return this.paged<ZentaoBug>(
      `/products/${productId}/bugs`,
      "bugs",
      mapBug,
      undefined,
      options?.full ? FULL_PAGINATION_PAGES : MAX_PAGES,
    );
  }

  async getTask(id: number): Promise<ZentaoTask> {
    const row = expectObject(
      await this.request<unknown>(`/tasks/${id}`),
      `任务 ${id}`,
    );
    const task = mapTask(row);
    if (!task) throw new ZentaoClientError(`禅道任务 ${id} 不存在`, 404);
    return task;
  }

  async getBug(id: number): Promise<ZentaoBug> {
    const row = expectObject(
      await this.request<unknown>(`/bugs/${id}`),
      `Bug ${id}`,
    );
    const bug = mapBug(row);
    if (!bug) throw new ZentaoClientError(`禅道 Bug ${id} 不存在`, 404);
    return bug;
  }

  async updateTaskStatus(id: number, status: string): Promise<void> {
    await this.request<unknown>(`/tasks/${id}`, {
      method: "PUT",
      body: { status },
    });
  }

  async resolveBug(
    id: number,
    input: { resolution?: string; comment?: string } = {},
  ): Promise<void> {
    await this.request<unknown>(`/bugs/${id}/resolve`, {
      method: "POST",
      body: {
        resolution: input.resolution ?? "fixed",
        ...(input.comment ? { comment: input.comment } : {}),
      },
    });
  }

  async closeBug(id: number, comment?: string): Promise<void> {
    await this.request<unknown>(`/bugs/${id}/close`, {
      method: "POST",
      body: comment ? { comment } : {},
    });
  }

  async activateBug(id: number, comment?: string): Promise<void> {
    await this.request<unknown>(`/bugs/${id}/activate`, {
      method: "POST",
      body: comment ? { comment } : {},
    });
  }
}

function mapProduct(row: Record<string, unknown>): ZentaoProduct | undefined {
  const id = asNumber(row.id);
  const name = asString(row.name);
  if (id === undefined || !name) return undefined;
  return {
    id,
    name,
    status: asString(row.status),
    unresolvedBugs: asNumber(row.unresolvedBugs),
  };
}

function mapTask(row: Record<string, unknown>): ZentaoTask | undefined {
  const id = asNumber(row.id);
  const name = asString(row.name);
  if (id === undefined || !name) return undefined;
  return {
    id,
    name,
    status: asString(row.status) ?? "",
    pri: asNumber(row.pri) ?? 3,
    assignedTo: (row.assignedTo as ZentaoUserRef) ?? null,
    execution: asNumber(row.execution),
    project: asNumber(row.project),
    deadline: asString(row.deadline),
    openedBy: (row.openedBy as ZentaoUserRef) ?? null,
    desc: typeof row.desc === "string" ? row.desc : undefined,
  };
}

function mapBug(row: Record<string, unknown>): ZentaoBug | undefined {
  const id = asNumber(row.id);
  const title = asString(row.title);
  if (id === undefined || !title) return undefined;
  return {
    id,
    title,
    status: asString(row.status) ?? "",
    severity: asNumber(row.severity),
    pri: asNumber(row.pri),
    assignedTo: (row.assignedTo as ZentaoUserRef) ?? null,
    product: asNumber(row.product),
    project: asNumber(row.project),
    openedBy: (row.openedBy as ZentaoUserRef) ?? null,
    deadline: asString(row.deadline),
    steps: typeof row.steps === "string" ? row.steps : undefined,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function errorDetail(body: unknown): string {
  if (body && typeof body === "object") {
    const message = asString((body as Record<string, unknown>).message);
    const error = asString((body as Record<string, unknown>).error);
    if (message) return `：${message}`;
    if (error) return `：${error}`;
  }
  return "";
}

/** Normalize "admin" / {account} user refs for assignedTo comparisons. */
export function zentaoUserAccount(value: ZentaoUserRef | unknown): string | undefined {
  return userAccount(value);
}
