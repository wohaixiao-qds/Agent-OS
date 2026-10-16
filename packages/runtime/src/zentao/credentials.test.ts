import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveZentaoCredentials,
  updateStoredZentaoCredentials,
  viewZentaoCredentials,
  zentaoConfigured,
} from "./credentials.js";

const ENV_KEYS = [
  "ZY_AOS_ZENTAO_BASE_URL",
  "ZY_AOS_ZENTAO_ACCOUNT",
  "ZY_AOS_ZENTAO_PASSWORD",
  "ZENTAO_BASE_URL",
  "ZENTAO_ACCOUNT",
  "ZENTAO_PASSWORD",
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zy-aos-zentao-cred-"));
}

describe("zentao credentials", () => {
  it("resolves from the store and flags insecure http", async () => {
    const dir = await tempDir();
    try {
      await updateStoredZentaoCredentials(
        {
          baseUrl: "http://zentao.corp/",
          account: "dev",
          password: "secret",
        },
        dir,
      );
      const config = await resolveZentaoCredentials(dir);
      expect(config).toEqual({
        baseUrl: "http://zentao.corp",
        account: "dev",
        password: "secret",
      });
      const view = await viewZentaoCredentials(dir);
      expect(view.configured).toBe(true);
      expect(view.insecureHttp).toBe(true);
      expect(view.sources).toEqual({
        baseUrl: "store",
        account: "store",
        password: "store",
      });
      await expect(zentaoConfigured(dir)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("env vars win over the store and are flagged", async () => {
    const dir = await tempDir();
    process.env.ZY_AOS_ZENTAO_BASE_URL = "https://zentao.example";
    process.env.ZY_AOS_ZENTAO_ACCOUNT = "env-user";
    try {
      await updateStoredZentaoCredentials(
        { baseUrl: "http://ignored", account: "ignored", password: "store-pw" },
        dir,
      );
      const config = await resolveZentaoCredentials(dir);
      expect(config.baseUrl).toBe("https://zentao.example");
      expect(config.account).toBe("env-user");
      expect(config.password).toBe("store-pw");
      const view = await viewZentaoCredentials(dir);
      expect(view.envOverridesActive).toBe(true);
      expect(view.insecureHttp).toBe(false);
    } finally {
      delete process.env.ZY_AOS_ZENTAO_BASE_URL;
      delete process.env.ZY_AOS_ZENTAO_ACCOUNT;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("masked password placeholder keeps the stored value", async () => {
    const dir = await tempDir();
    try {
      await updateStoredZentaoCredentials(
        { baseUrl: "http://z", account: "a", password: "real" },
        dir,
      );
      const view = await updateStoredZentaoCredentials(
        { password: "••••cd" },
        dir,
      );
      expect(view.configured).toBe(true);
      const config = await resolveZentaoCredentials(dir);
      expect(config.password).toBe("real");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clearPassword wipes the secret", async () => {
    const dir = await tempDir();
    try {
      await updateStoredZentaoCredentials(
        { baseUrl: "http://z", account: "a", password: "real" },
        dir,
      );
      const view = await updateStoredZentaoCredentials(
        { clearPassword: true },
        dir,
      );
      expect(view.configured).toBe(false);
      await expect(resolveZentaoCredentials(dir)).rejects.toThrow(/不完整/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
