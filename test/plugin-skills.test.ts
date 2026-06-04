import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("Copilot plugin skills", () => {
  test("plugin manifests expose the skills directory", async () => {
    const plugin = JSON.parse(await readFile(join(import.meta.dir, "..", "plugin.json"), "utf8"));
    const marketplace = JSON.parse(
      await readFile(join(import.meta.dir, "..", ".github", "plugin", "marketplace.json"), "utf8"),
    );

    expect(plugin.skills).toEqual(["skills/"]);
    expect(marketplace.plugins.find((entry: { name?: string }) => entry.name === "ddserve")?.skills).toEqual([
      "skills/",
    ]);
  });

  test("ddserve docs MCP skill frontmatter matches its plugin path", async () => {
    const skill = await readFile(
      join(import.meta.dir, "..", "skills", "ddserve-docs-mcp", "SKILL.md"),
      "utf8",
    );

    expect(skill).toMatch(/^---\n/);
    expect(skill).toContain("name: ddserve-docs-mcp\n");
    expect(skill).toContain("description: ");
  });
});
