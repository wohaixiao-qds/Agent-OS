import { mkdir, readdir, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Copy a skill directory. Existing files at the destination are kept. */
async function copySkillDir(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "references" && entry.isDirectory()) {
      const refSrc = join(srcDir, "references");
      const refDest = join(destDir, "references");
      await mkdir(refDest, { recursive: true });
      const refs = await readdir(refSrc, { withFileTypes: true });
      for (const ref of refs) {
        if (!ref.isFile()) continue;
        const out = join(refDest, ref.name);
        if (await pathExists(out)) continue;
        await writeFile(out, await readFile(join(refSrc, ref.name)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const out = join(destDir, entry.name);
    if (await pathExists(out)) continue;
    await writeFile(out, await readFile(join(srcDir, entry.name)));
  }
}

/** Bundled default skills shipped with @zy-aos/runtime (agent-os aligned). */
export function bundledSkillsRoot(): string {
  // tsx 源码：src/services → <runtime>/skills；
  // esbuild 产物是扁平的 dist/index.js（没有 dist/services），安装包内是
  // resources/runtime/index.js —— 两者都取同级的 ../skills。
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "skills"),
    join(here, "..", "skills"),
  ];
  return candidates.find((root) => existsSync(root)) ?? candidates[0]!;
}

/**
 * Install one bundled skill into `<homeDir>/.agents/skills/<id>/`.
 * Returns the SKILL.md path. Existing files are kept.
 */
export async function installBundledSkill(
  skillId: string,
  homeDir: string,
): Promise<string | undefined> {
  const src = join(bundledSkillsRoot(), skillId, "SKILL.md");
  if (!(await pathExists(src))) return undefined;
  const destDir = join(homeDir, ".agents", "skills", skillId);
  const dest = join(destDir, "SKILL.md");
  if (!(await pathExists(dest))) {
    await copySkillDir(dirname(src), destDir);
  }
  return dest;
}

/**
 * Copy missing bundled skills into `<workspace>/.agents/skills/`.
 * Never overwrites an existing SKILL.md.
 */
export async function seedBundledSkills(
  workspaceDir: string,
): Promise<string[]> {
  const root = bundledSkillsRoot();
  if (!(await pathExists(root))) {
    return [];
  }

  const seeded: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillId = entry.name;
    const src = join(root, skillId, "SKILL.md");
    if (!(await pathExists(src))) continue;

    const destDir = join(workspaceDir, ".agents", "skills", skillId);
    const dest = join(destDir, "SKILL.md");
    if (await pathExists(dest)) continue;

    await copySkillDir(dirname(src), destDir);
    seeded.push(skillId);
  }
  return seeded;
}
