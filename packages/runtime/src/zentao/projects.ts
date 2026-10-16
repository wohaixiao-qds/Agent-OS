import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ZentaoClient, type ZentaoProject } from "./client.js";
import { resolveZentaoCredentials } from "./credentials.js";

const ProjectRuntimeSettingsSchema = z.object({
  localPath: z.string().trim().min(1).optional(),
  defaultEngine: z.enum(["claude", "codex"]).optional(),
  cast: z.array(z.string().trim().min(1).max(80)).optional(),
  testBaseUrl: z.string().trim().min(1).max(300).optional(),
  testStartCommand: z.string().trim().min(1).max(500).optional(),
});

const SettingsFileSchema = z.object({
  projects: z.record(ProjectRuntimeSettingsSchema).default({}),
});

export type ZentaoProjectSettings = z.infer<typeof ProjectRuntimeSettingsSchema>;

export type ZentaoProjectConfig = {
  id: string;
  name: string;
  ident?: string;
  programId: string;
  localPath?: string;
  defaultEngine: "claude" | "codex";
  cast: string[];
  testBaseUrl?: string;
  testStartCommand?: string;
  fromRemote?: boolean;
};

type ClientFactory = () => Promise<ZentaoClient>;

/**
 * ZenTao project list (from /projects) with runtime settings overlaid from
 * dataDir/zentao-project-settings.json — same shape as the Gitee store.
 */
export class ZentaoProjectsStore {
  constructor(
    private readonly dataDir: string,
    private readonly createClient: ClientFactory = async () =>
      new ZentaoClient(await resolveZentaoCredentials(this.dataDir)),
  ) {}

  private settingsPath(): string {
    return resolve(this.dataDir, "zentao-project-settings.json");
  }

  private async loadSettings(): Promise<Record<string, ZentaoProjectSettings>> {
    try {
      const raw = await readFile(this.settingsPath(), "utf8");
      return SettingsFileSchema.parse(JSON.parse(raw)).projects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async saveSettings(
    projects: Record<string, ZentaoProjectSettings>,
  ): Promise<void> {
    const path = this.settingsPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ projects }, null, 2)}\n`,
      "utf8",
    );
  }

  private merge(
    project: Pick<ZentaoProjectConfig, "id" | "name" | "ident" | "programId">,
    settings: Record<string, ZentaoProjectSettings>,
    fromRemote: boolean,
  ): ZentaoProjectConfig {
    const overlay = settings[project.id] ?? {};
    return {
      ...project,
      localPath: overlay.localPath,
      defaultEngine: overlay.defaultEngine ?? "claude",
      cast: overlay.cast ?? [],
      testBaseUrl: overlay.testBaseUrl,
      testStartCommand: overlay.testStartCommand,
      fromRemote,
    };
  }

  async list(): Promise<ZentaoProjectConfig[]> {
    const settings = await this.loadSettings();
    let remote: ZentaoProject[] = [];
    let remoteError: string | undefined;
    try {
      remote = await (await this.createClient()).listProjects();
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error);
    }

    if (remote.length > 0) {
      return remote.map((project) =>
        this.merge(
          {
            id: String(project.id),
            name: project.name,
            ident: project.code,
            programId: String(project.id),
          },
          settings,
          true,
        ),
      );
    }

    // Offline fallback: configured projects only (names unknown without API).
    const known = Object.entries(settings).filter(
      ([, value]) => value.localPath,
    );
    if (known.length > 0) {
      return known.map(([id]) =>
        this.merge(
          { id, name: id, programId: id },
          settings,
          false,
        ),
      );
    }

    if (remoteError) {
      throw new Error(`无法从禅道拉取项目列表：${remoteError}`);
    }
    return [];
  }

  async get(projectId: string): Promise<ZentaoProjectConfig | undefined> {
    const list = await this.list();
    return list.find(
      (p) => p.id === projectId || p.programId === projectId,
    );
  }

  async updateSettings(
    projectId: string,
    patch: ZentaoProjectSettings,
  ): Promise<ZentaoProjectConfig> {
    const current = await this.get(projectId);
    if (!current) throw new Error(`禅道项目不存在: ${projectId}`);
    const settings = await this.loadSettings();
    const prev = settings[current.id] ?? {};
    settings[current.id] = {
      localPath:
        patch.localPath !== undefined
          ? patch.localPath.trim() || undefined
          : prev.localPath,
      defaultEngine: patch.defaultEngine ?? prev.defaultEngine,
      cast: patch.cast ?? prev.cast,
      testBaseUrl:
        patch.testBaseUrl !== undefined
          ? patch.testBaseUrl.trim() || undefined
          : prev.testBaseUrl,
      testStartCommand:
        patch.testStartCommand !== undefined
          ? patch.testStartCommand.trim() || undefined
          : prev.testStartCommand,
    };
    await this.saveSettings(settings);
    const merged = await this.get(current.id);
    if (!merged) throw new Error(`禅道项目不存在: ${projectId}`);
    return merged;
  }
}
