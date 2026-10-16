# ADR 0007：多工单来源与 Provider 抽象

> 状态：**已定稿**。
> 工单系统从 Gitee 单一来源扩展为 Gitee + 禅道（ZenTao）双来源。

## 背景

ADR-0006 定稿的工单模块直接围绕 Gitee 企业工单实现：`TicketService` 直接
import `gitee/client` 等模块，派单记录、任务看板、Cast 约束、定时拉单
全部隐含 "Gitee issue" 假设。接入第二个来源（禅道开源版 21.6.1，REST
`api.php/v1`）前，需要把这些耦合收敛到统一的 provider 契约后面。

## 决策

1. **TicketProvider 契约**（`packages/runtime/src/tickets/provider.ts`）：
   `status / listProjects / getProject / updateProjectSettings / listTodos /
   getDetail / listStates / updateState / downloadImages`。Gitee 与禅道
   平级实现，TicketService、拉单调度、看板、收件箱 UI 对来源无感。
2. **统一工单模型**：每条工单带稳定 `key`（Gitee: `String(id)`；禅道:
   `BUG-{id}` / `TASK-{id}`）。详情、改状态、派发、拉单全部以 `key`
   寻址，避免禅道 Bug/Task 数字 id 空间重叠的歧义。禅道行额外携带
   `kind: bug|task` 供徽章展示。
3. **禅道的范围**：收件箱聚合「指派给我的 Bug + 任务」。Bug 挂在产品下、
   任务挂在执行（execution）下，拉取路径为 项目 → executions → tasks 与
   项目 → products → bugs；迭代分组名任务取执行名、Bug 取产品名。
   默认待办 = 任务 `wait/doing` + Bug `active`。
4. **优先级映射**：禅道 pri 1–4 映射为 紧急/严重/主要/次要
   （rank 0/10/20/30），复用 Gitee 的 `priority.ts` 排序与拉单阈值语义。
5. **状态写回**：任务 `PUT /tasks/{id}` 改 status；Bug 按目标状态走
   `resolve / close / activate` 语义端点（对齐 tianjin-library zentao-mcp
   的实战经验）。状态选项为静态映射，id 为枚举序号。
6. **认证**：禅道 REST `POST /tokens`（账号+密码）换临时 token，进程内
   缓存、401 自动重认证；密码不写日志。凭证双通道与 Gitee 一致
   （env `ZY_AOS_ZENTAO_*` > `dataDir/zentao-credentials.json`），遮罩
   占位不覆盖已存密码。HTTP 明文地址在测连通时给出风险提示。
7. **派单与看板泛化**：
   - 派单记录统一 `ticket-dispatches.json`（key `{provider}:{issueKey}`），
     旧 `gitee-dispatches.json` 只读合并，Cast 约束行为不变；
   - 任务看板行 `source` 扩展 `"zentao"`，工单引用泛化为 `external`
     （provider/projectId/issueId/issueIdent/lastSyncedState*），存量 gitee
     行读取时自动映射，并保留 `gitee` 镜像字段兼容旧前端。
8. **HTTP API**：`/api/tickets/:provider/...` 来源段（`dispatch` body 带
   `provider`，缺省 gitee）；`/api/tickets/status` 返回双来源配置状态；
   `/api/integrations/zentao(+/test)` 镜像 Gitee 集成路由。
9. **UI**：右栏收件箱顶部 [Gitee | 禅道] Tab，各自独立的项目与待办状态，
   未配置来源显示黄点与引导；禅道卡片带 缺陷/任务 徽章；设置页「集成工单」
   分 Gitee / 禅道两张凭证卡片；定时拉单按来源+项目唯一。

## 不做（本期）

- 需求（Story）对象接入禅道收件箱；
- 禅道评论写回、附件上传；
- 跨来源合并收件箱视图（保持 Tab 隔离）；
- Gitee 数据文件迁移（旧文件原样保留、读取时合并）。

## 后果

- 新增第三个来源（如 Jira）只需实现 provider 契约 + 注册，不动编排层；
- `gitee/` 目录代码未改，Gitee 行为零变化（测试断言保持通过）；
- 禅道任务分页、状态端点在不同禅道版本可能略有差异，client 层做了
  404 回退（executions/products 顶层列表兜底），联调时如遇差异在
  `packages/runtime/src/zentao/client.ts` 内收敛。
