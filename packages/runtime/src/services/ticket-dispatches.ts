import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { TicketProviderId } from "../tickets/provider.js";

const DispatchRecordSchema = z.object({
  provider: z.enum(["gitee", "zentao"]),
  issueId: z.number(),
  /** Stable ticket key. Gitee: String(id); ZenTao: BUG-/TASK- ident. */
  issueKey: z.string(),
  ident: z.string(),
  projectId: z.string(),
  topicId: z.string(),
  cast: z.array(z.string()),
  localPath: z.string(),
  engine: z.enum(["claude", "codex"]),
  at: z.string(),
});

/** Legacy gitee-only dispatch file written before ADR-0007. */
const LegacyGiteeRecordSchema = z.object({
  issueId: z.number().optional(),
  ident: z.string().optional(),
  projectId: z.string().optional(),
  topicId: z.string(),
  cast: z.array(z.string()).optional(),
  localPath: z.string().optional(),
  engine: z.enum(["claude", "codex"]).optional(),
  at: z.string().optional(),
});

const LegacyFileSchema = z.object({
  byIssueId: z.record(LegacyGiteeRecordSchema).default({}),
});

export type TicketDispatchRecord = z.infer<typeof DispatchRecordSchema>;

export function dispatchKey(
  provider: TicketProviderId,
  issueKey: string,
): string {
  return `${provider}:${issueKey}`;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Unified dispatch store (`ticket-dispatches.json`, keyed by
 * `{provider}:{issueKey}`). The legacy `gitee-dispatches.json` is merged
 * read-only so existing installs keep their cast bindings.
 */
export class TicketDispatchStore {
  constructor(private readonly dataDir: string) {}

  private storePath(): string {
    return resolve(this.dataDir, "ticket-dispatches.json");
  }

  private legacyPath(): string {
    return resolve(this.dataDir, "gitee-dispatches.json");
  }

  async loadAll(): Promise<Map<string, TicketDispatchRecord>> {
    const byKey = new Map<string, TicketDispatchRecord>();

    const legacyRaw = await readJsonFile(this.legacyPath());
    if (legacyRaw) {
      const legacy = LegacyFileSchema.parse(legacyRaw);
      for (const record of Object.values(legacy.byIssueId)) {
        const issueKey = String(record.issueId ?? "unknown");
        byKey.set(dispatchKey("gitee", issueKey), {
          provider: "gitee",
          issueKey,
          issueId: record.issueId ?? 0,
          ident: record.ident ?? "",
          projectId: record.projectId ?? "",
          topicId: record.topicId,
          cast: record.cast ?? [],
          localPath: record.localPath ?? "",
          engine: record.engine ?? "claude",
          at: record.at ?? "",
        });
      }
    }

    const unifiedRaw = await readJsonFile(this.storePath());
    if (unifiedRaw) {
      const parsed = z
        .object({ byKey: z.record(DispatchRecordSchema).default({}) })
        .parse(unifiedRaw);
      for (const [key, record] of Object.entries(parsed.byKey)) {
        byKey.set(key, record);
      }
    }
    return byKey;
  }

  async find(
    provider: TicketProviderId,
    issueKey: string,
  ): Promise<TicketDispatchRecord | undefined> {
    return (await this.loadAll()).get(dispatchKey(provider, issueKey));
  }

  async save(record: TicketDispatchRecord): Promise<void> {
    const all = await this.loadAll();
    all.set(dispatchKey(record.provider, record.issueKey), record);
    const path = this.storePath();
    await mkdir(dirname(path), { recursive: true });
    const byKey = Object.fromEntries(all);
    await writeFile(
      path,
      `${JSON.stringify({ byKey }, null, 2)}\n`,
      "utf8",
    );
  }

  /** Cast constraint for a dispatched topic (team-handoff hook). */
  async topicCast(topicId: string): Promise<string[] | null> {
    for (const record of (await this.loadAll()).values()) {
      if (record.topicId === topicId) return record.cast;
    }
    return null;
  }

  /** Remove records bound to a deleted topic; returns the removed records. */
  async removeByTopicId(topicId: string): Promise<TicketDispatchRecord[]> {
    const all = await this.loadAll();
    const removed: TicketDispatchRecord[] = [];
    for (const [key, record] of all) {
      if (record.topicId === topicId) {
        all.delete(key);
        removed.push(record);
      }
    }
    if (removed.length > 0) {
      const path = this.storePath();
      await mkdir(dirname(path), { recursive: true });
      const byKey = Object.fromEntries(all);
      await writeFile(
        path,
        `${JSON.stringify({ byKey }, null, 2)}\n`,
        "utf8",
      );
    }
    return removed;
  }
}
