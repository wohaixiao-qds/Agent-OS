import {
  resolveZentaoCredentials,
  updateStoredZentaoCredentials,
  viewZentaoCredentials,
  type UpdateZentaoCredentialsInput,
  type ZentaoCredentialsView,
} from "../zentao/credentials.js";
import { ZentaoClient } from "../zentao/client.js";

export type ZentaoIntegrationSnapshot = ZentaoCredentialsView;

export class ZentaoIntegrationService {
  constructor(private readonly dataDir: string) {}

  async get(): Promise<ZentaoIntegrationSnapshot> {
    return viewZentaoCredentials(this.dataDir);
  }

  async update(
    input: UpdateZentaoCredentialsInput,
  ): Promise<ZentaoIntegrationSnapshot> {
    return updateStoredZentaoCredentials(input, this.dataDir);
  }

  async testConnection(): Promise<{
    ok: boolean;
    message: string;
    projectCount?: number;
  }> {
    let client: ZentaoClient;
    try {
      client = new ZentaoClient(
        await resolveZentaoCredentials(this.dataDir),
      );
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "凭证不完整",
      };
    }
    try {
      const projects = await client.listProjects();
      const view = await viewZentaoCredentials(this.dataDir);
      const warning = view.insecureHttp
        ? "；注意：当前为 HTTP 明文连接，账号密码存在被窃听风险，建议启用 HTTPS"
        : "";
      return {
        ok: true,
        message: `连接成功（可见 ${projects.length} 个项目）${warning}`,
        projectCount: projects.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      return { ok: false, message };
    }
  }
}
