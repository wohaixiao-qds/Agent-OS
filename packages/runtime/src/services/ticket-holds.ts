import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TicketProviderId } from "../tickets/provider.js";
import { dispatchKey } from "./ticket-dispatches.js";

interface HoldEntry {
  at: string;
}

/**
 * Manual「暂不处理」holds (`ticket-holds.json`, keyed by
 * `{provider}:{issueKey}` — same key format as dispatch records).
 * Held tickets are skipped by auto dispatch until manually released.
 */
export class TicketHoldStore {
  constructor(private readonly dataDir: string) {}

  private storePath(): string {
    return resolve(this.dataDir, "ticket-holds.json");
  }

  private async loadAll(): Promise<Map<string, HoldEntry>> {
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
        ? ((raw as { byKey?: Record<string, HoldEntry> }).byKey ?? {})
        : {};
    const map = new Map<string, HoldEntry>();
    for (const [key, value] of Object.entries(byKey)) {
      if (typeof value?.at === "string") {
        map.set(key, { at: value.at });
      }
    }
    return map;
  }

  async heldKeys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.keys());
  }

  async hold(provider: TicketProviderId, issueKey: string): Promise<void> {
    const all = await this.loadAll();
    all.set(dispatchKey(provider, issueKey), { at: new Date().toISOString() });
    await this.persist(all);
  }

  async release(provider: TicketProviderId, issueKey: string): Promise<boolean> {
    const all = await this.loadAll();
    const existed = all.delete(dispatchKey(provider, issueKey));
    if (existed) {
      await this.persist(all);
    }
    return existed;
  }

  private async persist(all: Map<string, HoldEntry>): Promise<void> {
    const byKey: Record<string, HoldEntry> = {};
    for (const [key, value] of all) {
      byKey[key] = value;
    }
    const path = this.storePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ byKey }, null, 2), "utf8");
  }
}
