import { describe, expect, it } from "vitest";
import { folderLastName } from "./workspace-name.js";

describe("folderLastName", () => {
  it("takes the last segment of a unix path", () => {
    expect(folderLastName("/Users/zhangyu/CodeDevelopment/Agent-OS")).toBe(
      "Agent-OS",
    );
  });

  it("takes the last segment of a windows path", () => {
    expect(folderLastName("E:\\projects\\backend-api")).toBe("backend-api");
  });

  it("ignores trailing separators", () => {
    expect(folderLastName("/Users/zhangyu/My Project/")).toBe("My Project");
  });

  it("keeps folder names containing dots", () => {
    expect(folderLastName("/srv/www/my.repo.v2")).toBe("my.repo.v2");
  });

  it("returns empty for a bare root", () => {
    expect(folderLastName("/")).toBe("");
    expect(folderLastName("")).toBe("");
  });
});
