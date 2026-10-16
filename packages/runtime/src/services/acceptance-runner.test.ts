import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAcceptanceSuite } from "./acceptance-runner.js";

describe("findAcceptanceSuite", () => {
  it("finds .zy-aos/acceptance playwright config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zy-aos-suite-"));
    try {
      const cfgDir = join(dir, ".zy-aos", "acceptance");
      await mkdir(cfgDir, { recursive: true });
      await writeFile(join(cfgDir, "playwright.config.ts"), "export default {}");
      const found = await findAcceptanceSuite(dir);
      expect(found).toContain("playwright.config.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
