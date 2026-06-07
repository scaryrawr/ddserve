import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCacheManifest } from "../src/cache";
import {
  buildPiDdserveContext,
  DDSERVE_PI_CONTEXT_DOC_LIMIT,
  runDdserveSearch,
  type DdserveSearchResult,
  type DdserveSearchRunnerOptions,
} from "../src/pi-extension";
import type { CacheManifestDocset } from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pi extension ddserve context", () => {
  test("searches with detected installed project slugs and formats top distinct docs", async () => {
    const cwd = await createTempDir("pi-extension-project-");
    const cacheRoot = await createTempDir("pi-extension-cache-");
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.3.12",
        dependencies: { react: "19.2.0" },
        devDependencies: { typescript: "6.0.3" },
      }),
      "utf8",
    );
    await writeFile(join(cwd, "tsconfig.json"), "{}", "utf8");
    await seedCacheManifest(cacheRoot, [
      cacheDocsetSummary({ slug: "bun", name: "Bun", type: "bun" }),
      cacheDocsetSummary({ slug: "javascript", name: "JavaScript", type: "javascript" }),
      cacheDocsetSummary({ slug: "node", name: "Node.js", type: "node" }),
      cacheDocsetSummary({ slug: "react", name: "React", type: "react" }),
      cacheDocsetSummary({ slug: "typescript", name: "TypeScript", type: "typescript" }),
    ]);
    let seenOptions: DdserveSearchRunnerOptions | undefined;

    const context = await buildPiDdserveContext({
      prompt: "  useEffect cleanup <test>  ",
      cwd,
      cacheRoot,
      env: { ...process.env },
      runSearch: async (options) => {
        seenOptions = options;
        return {
          results: [
            searchResult(1, { pageName: "Effects <Hooks>", snippet: "Clean up & synchronize" }),
            searchResult(1, { snippet: "duplicate chunk" }),
            searchResult(2),
            searchResult(3),
            searchResult(4),
            searchResult(5),
            searchResult(6),
          ],
        };
      },
    });

    expect(seenOptions?.query).toBe("useEffect cleanup <test>");
    expect(seenOptions?.limit).toBe(15);
    expect(seenOptions?.slugs).toEqual(["node", "javascript", "bun", "react", "typescript"]);
    expect(context).toContain("<ddserve>");
    expect(context).toContain("<title>Effects &lt;Hooks&gt;</title>");
    expect(context).toContain("<info>Clean up &amp; synchronize</info>");
    expect(context).not.toContain("duplicate chunk");
    expect(context).not.toContain("Hooks>");
    expect(context?.match(/<doc slug=/g)?.length).toBe(DDSERVE_PI_CONTEXT_DOC_LIMIT);
    expect(context).not.toContain("page-6");
  });

  test("matches dependency names against currently installed docsets without hardcoded package mappings", async () => {
    const cwd = await createTempDir("pi-extension-dynamic-project-");
    const cacheRoot = await createTempDir("pi-extension-dynamic-cache-");
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "some-new-lib": "1.0.0" } }),
      "utf8",
    );
    await seedCacheManifest(cacheRoot, [
      cacheDocsetSummary({ slug: "javascript", name: "JavaScript", type: "javascript" }),
      cacheDocsetSummary({ slug: "node", name: "Node.js", type: "node" }),
      cacheDocsetSummary({ slug: "some_new_lib", name: "Some New Lib", type: "library" }),
    ]);
    let seenOptions: DdserveSearchRunnerOptions | undefined;

    await buildPiDdserveContext({
      prompt: "configure it",
      cwd,
      cacheRoot,
      env: { ...process.env },
      runSearch: async (options) => {
        seenOptions = options;
        return { results: [] };
      },
    });

    expect(seenOptions?.slugs).toEqual(["node", "javascript", "some_new_lib"]);
  });

  test("skips blank prompts", async () => {
    const cwd = await createTempDir("pi-extension-project-");
    const context = await buildPiDdserveContext({
      prompt: "   ",
      cwd,
      runSearch: async () => {
        throw new Error("search should not run");
      },
    });

    expect(context).toBeUndefined();
  });

  test("runs the ddserve command from PATH/configured command instead of importing Bun-only search code", async () => {
    const cwd = await createTempDir("pi-extension-command-");
    const captureFile = join(cwd, "args.txt");
    const command = join(cwd, "ddserve-stub.sh");
    await writeFile(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE_FILE"\nprintf '%s\\n' '{"results":[{"docsetSlug":"node","pageId":"fs","pageName":"File system","pagePath":"api/fs","snippet":"fs docs"}]}'\n`,
      "utf8",
    );
    await chmod(command, 0o755);

    const response = await runDdserveSearch({
      query: "read files",
      slugs: ["node", "typescript"],
      limit: 15,
      cwd,
      env: { ...process.env, DDSERVE_PI_COMMAND: command, CAPTURE_FILE: captureFile },
    });

    expect(response.results).toEqual([
      {
        docsetSlug: "node",
        pageId: "fs",
        pageName: "File system",
        pagePath: "api/fs",
        snippet: "fs docs",
      },
    ]);
    expect((await readFile(captureFile, "utf8")).trim().split("\n")).toEqual([
      "search",
      "read files",
      "--limit",
      "15",
      "--format",
      "json",
      "--slug",
      "node,typescript",
    ]);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function seedCacheManifest(cacheRoot: string, docsets: CacheManifestDocset[]): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  await writeCacheManifest(cacheRoot, {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: Object.fromEntries(docsets.map((docset) => [docset.slug, docset])),
  });
}

function searchResult(index: number, overrides: Partial<DdserveSearchResult> = {}): DdserveSearchResult {
  return {
    docsetSlug: "react",
    pageId: `page-${index}`,
    pageName: `Page ${index}`,
    pagePath: `reference/page-${index}`,
    pageType: "Guide",
    snippet: `snippet ${index}`,
    ...overrides,
  };
}

function cacheDocsetSummary(overrides: Partial<CacheManifestDocset> = {}): CacheManifestDocset {
  return {
    source: "devdocs",
    slug: "node",
    name: "Node.js",
    type: "node",
    contentFormat: "markdown",
    version: "1",
    release: "2026-01-01",
    mtime: 1,
    dbSize: 10,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: 1,
    ...overrides,
  };
}
