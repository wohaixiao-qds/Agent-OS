import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TicketProviderId } from "../tickets/provider.js";
import { dispatchKey } from "./ticket-dispatches.js";

interface FlagEntry {
  at: string;
  /** Marked from this topic (used to clean up when the topic is deleted). */
  topicId?: string;
}

/**
 * Per-ticket manual flags stored as a keyed JSON file (`{provider}:{issueKey}`,
 * same key format as dispatch records). Backs「暂不处理」holds and manual
 *「已完成」completions; each instance owns one file.
 */
export class TicketFlagStore {
  constructor(
    private readonly dataDir: string,
    private readonly fileName: string,
  ) {}

  private storePath(): string {
    return resolve(this.dataDir, this.fileName);
  }

  private async loadAll(): Promise<Map<string, FlagEntry>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.storePath(), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw error;
    }
    const byKey =
      typeof raw === "object" && raw !== null && "byKey" in raw
        ? ((raw as { byKey?: Record<string, FlagEntry> }).byKey ?? {})
        : {};
    const map = new Map<string, FlagEntry>();
    for (const [key, value] of Object.entries(byKey)) {
      if (typeof value?.at === "string") {
        map.set(key, { at: value.at, topicId: value.topicId });
      }
    }
    return map;
  }

  async keys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.keys());
  }

  async mark(
    provider: TicketProviderId,
    issueKey: string,
    topicId?: string,
  ): Promise<void> {
    const all = await this.loadAll();
    all.set(dispatchKey(provider, issueKey), {
      at: new Date().toISOString(),
      topicId,
    });
    await this.persist(all);
  }

  async unmark(provider: TicketProviderId, issueKey: string): Promise<boolean> {
    const all = await this.loadAll();
    const existed = all.delete(dispatchKey(provider, issueKey));
    if (existed) {
      await this.persist(all);
    }
    return existed;
  }

  /** Remove entries bound to a deleted topic; returns removed keys. */
  async removeByTopicId(topicId: string): Promise<string[]> {
    const all = await this.loadAll();
    const removed: string[] = [];
    for (const [key, entry] of all) {
      if (entry.topicId === topicId) {
        all.delete(key);
        removed.push(key);
      }
    }
    if (removed.length > 0) {
      await this.persist(all);
    }
    return removed;
  }

  private async persist(all: Map<string, FlagEntry>): Promise<void> {
    const byKey: Record<string, FlagEntry> = {};
    for (const [key, value] of all) {
      byKey[key] = value;
    }
    const path = this.storePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ byKey }, null, 2), "utf8");
  }
}
