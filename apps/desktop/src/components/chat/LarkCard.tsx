import type { ReactNode } from "react";
import type { TicketIntakeView } from "./ticket-intake";

type LarkCardProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

export function LarkCard({ title, subtitle, children }: LarkCardProps) {
  return (
    <section className="lark-card">
      <header className="lark-card-header">
        <strong>{title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
      </header>
      <div className="lark-card-body">{children}</div>
    </section>
  );
}

export function TicketIntakeCard({
  providerLabel,
  ident,
  title,
  url,
  localPath,
  engine,
  cast,
  summary,
  note,
}: TicketIntakeView) {
  return (
    <LarkCard title="工单已接入" subtitle={`${providerLabel} · ${ident}`}>
      {title ? (
        <p className="lark-card-lead">
          <strong>{title}</strong>
        </p>
      ) : null}
      {localPath || engine || cast ? (
        <div className="lark-card-meta ticket-intake-meta">
          {localPath ? (
            <div>
              <span>项目目录</span>
              <strong className="mono ticket-intake-path">{localPath}</strong>
            </div>
          ) : null}
          {engine ? (
            <div>
              <span>引擎</span>
              <strong>{engine}</strong>
            </div>
          ) : null}
          {cast ? (
            <div>
              <span>Cast</span>
              <strong>{cast}</strong>
            </div>
          ) : null}
        </div>
      ) : null}
      {summary ? (
        <details className="run-details">
          <summary>描述摘要</summary>
          <p>{summary}</p>
        </details>
      ) : null}
      {note ? <p className="lark-card-foot">用户补充：{note}</p> : null}
      {url ? (
        <p className="lark-card-foot">
          <a href={url} target="_blank" rel="noreferrer">
            在{providerLabel}打开 ↗
          </a>
        </p>
      ) : null}
    </LarkCard>
  );
}

export function DispatchCard({
  from,
  to,
  objective,
  project,
  reportTo,
  instruction,
  expectedOutput,
  footer,
}: {
  from: string;
  to: string;
  objective: string;
  project?: string;
  reportTo?: string;
  instruction?: string;
  expectedOutput?: string;
  footer?: string;
}) {
  return (
    <LarkCard title="协作任务已派发" subtitle={`${from} → ${to}`}>
      <p className="lark-card-lead">
        <strong>
          {to}，请接手：{objective}
        </strong>
      </p>
      <div className="lark-card-meta">
        <div>
          <span>项目</span>
          <strong>{project || "当前工作区"}</strong>
        </div>
        <div>
          <span>结果交给</span>
          <strong>{reportTo || from}</strong>
        </div>
      </div>
      {expectedOutput ? (
        <p className="lark-card-foot">期望产出：{expectedOutput}</p>
      ) : footer ? (
        <p className="lark-card-foot">{footer}</p>
      ) : null}
      {instruction ? (
        <details className="run-details">
          <summary>查看任务说明</summary>
          <p>{instruction}</p>
        </details>
      ) : null}
    </LarkCard>
  );
}
