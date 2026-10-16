import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * ZenTao credentials, dual-channel like Gitee (ADR-0001/0002):
 * env (ZY_AOS_ZENTAO_*) > dataDir store > none.
 * baseUrl points at the ZenTao root, e.g. http://zentao.corp.local.
 */
export interface ZentaoEnvConfig {
  baseUrl: string;
  account: string;
  password: string;
}

export type ZentaoFieldSource = "env" | "store" | "none";

export interface ZentaoCredentialsView {
  baseUrl: string;
  account: string;
  /** Masked unless absent. */
  passwordMasked?: string;
  configured: boolean;
  sources: {
    baseUrl: ZentaoFieldSource;
    account: ZentaoFieldSource;
    password: ZentaoFieldSource;
  };
  envOverridesActive: boolean;
  insecureHttp: boolean;
}

export interface UpdateZentaoCredentialsInput {
  baseUrl?: string;
  account?: string;
  /** Masked placeholder ("••••") keeps the stored password. */
  password?: string;
  clearPassword?: boolean;
}

const STORE_FILE = "zentao-credentials.json";

const StoreSchema = z.object({
  baseUrl: z.string().trim().default(""),
  account: z.string().trim().default(""),
  password: z.string().default(""),
});

type ZentaoStoredCredentials = z.infer<typeof StoreSchema>;

const MASK = "••••";
const SETTINGS_HINT = "可在「设置 → 集成工单系统 → 禅道」填写，或用环境变量 ZY_AOS_ZENTAO_*。";

let credentialsDataDir: string | undefined;

export function setZentaoCredentialsDataDir(dataDir: string): void {
  credentialsDataDir = dataDir;
}

function storePath(dataDir?: string): string {
  return resolve(dataDir ?? credentialsDataDir ?? process.cwd(), STORE_FILE);
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function readStore(dataDir?: string): Promise<ZentaoStoredCredentials> {
  try {
    const raw = await readFile(storePath(dataDir), "utf8");
    return StoreSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { baseUrl: "", account: "", password: "" };
    }
    throw error;
  }
}

export function maskZentaoSecret(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return `${text.slice(0, 2)}${MASK}${text.slice(-2)}`;
}

export async function resolveZentaoCredentials(
  dataDir?: string,
): Promise<ZentaoEnvConfig> {
  const stored = await readStore(dataDir);
  const baseUrl =
    envValue("ZY_AOS_ZENTAO_BASE_URL", "ZENTAO_BASE_URL") ??
    (stored.baseUrl || "");
  const account =
    envValue("ZY_AOS_ZENTAO_ACCOUNT", "ZENTAO_ACCOUNT") ??
    (stored.account || "");
  const password =
    envValue("ZY_AOS_ZENTAO_PASSWORD", "ZENTAO_PASSWORD") ??
    (stored.password || "");
  if (!baseUrl || !account || !password) {
    throw new Error(
      `禅道凭证不完整（服务地址/账号/密码）。${SETTINGS_HINT}`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), account, password };
}

export async function zentaoConfigured(dataDir?: string): Promise<boolean> {
  try {
    await resolveZentaoCredentials(dataDir);
    return true;
  } catch {
    return false;
  }
}

export async function viewZentaoCredentials(
  dataDir?: string,
): Promise<ZentaoCredentialsView> {
  const stored = await readStore(dataDir);
  const envBaseUrl = envValue("ZY_AOS_ZENTAO_BASE_URL", "ZENTAO_BASE_URL");
  const envAccount = envValue("ZY_AOS_ZENTAO_ACCOUNT", "ZENTAO_ACCOUNT");
  const envPassword = envValue("ZY_AOS_ZENTAO_PASSWORD", "ZENTAO_PASSWORD");
  const baseUrl = envBaseUrl ?? stored.baseUrl ?? "";
  const account = envAccount ?? stored.account ?? "";
  const password = envPassword ?? stored.password ?? "";
  return {
    baseUrl,
    account,
    passwordMasked: password ? maskZentaoSecret(password) : undefined,
    configured: Boolean(baseUrl && account && password),
    sources: {
      baseUrl: envBaseUrl ? "env" : stored.baseUrl ? "store" : "none",
      account: envAccount ? "env" : stored.account ? "store" : "none",
      password: envPassword ? "env" : stored.password ? "store" : "none",
    },
    envOverridesActive: Boolean(envBaseUrl || envAccount || envPassword),
    insecureHttp: baseUrl.trim().toLowerCase().startsWith("http://"),
  };
}

export async function updateStoredZentaoCredentials(
  input: UpdateZentaoCredentialsInput,
  dataDir?: string,
): Promise<ZentaoCredentialsView> {
  const current = await readStore(dataDir);
  const next: ZentaoStoredCredentials = {
    baseUrl:
      input.baseUrl !== undefined
        ? input.baseUrl.trim().replace(/\/+$/, "")
        : current.baseUrl,
    account:
      input.account !== undefined
        ? input.account.trim()
        : current.account,
    password: input.clearPassword
      ? ""
      : input.password !== undefined
        ? // Masked placeholder keeps the stored value (ADR-0003 semantics).
          /(^|^[^•]{0,2})•{2,}/.test(input.password) || input.password.includes(MASK)
          ? current.password
          : input.password
        : current.password,
  };
  const path = storePath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return viewZentaoCredentials(dataDir);
}
