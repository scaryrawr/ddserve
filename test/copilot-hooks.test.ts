import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cachePaths, writeCacheManifest } from "../src/cache";
import {
  COPILOT_HOOKS_BASE_PATH,
  COPILOT_SESSION_START_HOOK_PATH,
  COPILOT_SESSION_START_SEARCH_LIMIT,
  sessionStartHookDto,
} from "../src/copilot-hooks";
import { DEFAULT_SERVE_PORT, parseConfig } from "../src/config";
import { DdserveError } from "../src/errors";
import type { SearchResponse, SearchResult } from "../src/search";
import type { ServerOperationRuntime } from "../src/server-shared";
import type { CacheManifestDocset } from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Copilot hook DTOs", () => {
  test("exports stable hook route constants", () => {
    expect(COPILOT_HOOKS_BASE_PATH).toBe("/copilot/hooks");
    expect(COPILOT_SESSION_START_HOOK_PATH).toBe("/copilot/hooks/sessionStart");
  });

  test("plugin manifest references the session start hook config", async () => {
    const plugin = JSON.parse(await readFile(join(import.meta.dir, "..", "plugin.json"), "utf8"));
    const hooks = JSON.parse(await readFile(join(import.meta.dir, "..", "hooks.json"), "utf8"));

    expect(plugin.hooks).toBe("hooks.json");
    expect(hooks).toEqual({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: "http",
            url: `http://127.0.0.1:${DEFAULT_SERVE_PORT}${COPILOT_SESSION_START_HOOK_PATH}`,
            timeoutSec: 5,
          },
        ],
      },
    });
  });

  test("formats installed docsets and top prompt search matches without local paths", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedCacheManifest(cacheRoot, [
      cacheDocsetSummary({ slug: "js", name: "JavaScript", pageCount: 2 }),
      cacheDocsetSummary({ slug: "http", name: "HTTP", pageCount: 1 }),
    ]);
    let seenQuery = "";
    let seenLimit = 0;
    const runtime = testRuntime(cacheRoot, async (options) => {
      seenQuery = options.query;
      seenLimit = options.limit ?? 0;
      return searchResponse(options.query, cacheRoot, 5);
    });

    const response = await sessionStartHookDto(runtime, {
      sessionId: "session-1",
      timestamp: 1,
      cwd: "/workspace",
      source: "startup",
      initialPrompt: "  hooks  ",
    });

    expect(seenQuery).toBe("hooks");
    expect(seenLimit).toBe(COPILOT_SESSION_START_SEARCH_LIMIT);
    expect(response.additionalContext).toContain("Installed docsets (2):");
    expect(response.additionalContext).toContain("- http: HTTP (1 page)");
    expect(response.additionalContext).toContain("- js: JavaScript (2 pages)");
    expect(response.additionalContext).toContain("Prompt-specific matches (4):");
    expect(response.additionalContext).toContain("1. http/overview-1 — HTTP Overview 1 (semantic 0.9)");
    expect(response.additionalContext).toContain("Links: page /api/docsets/http/pages/overview-1; content /api/docsets/http/pages/overview-1/content");
    expect(response.additionalContext).not.toContain("overview-5");
    expect(response.additionalContext).not.toContain("pageFilePath");
    expect(response.additionalContext).not.toContain(cacheRoot);
  });

  test("returns docset context and a skip note when no prompt is provided", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedCacheManifest(cacheRoot, [cacheDocsetSummary()]);
    const runtime = testRuntime(cacheRoot, async () => {
      throw new Error("search should not run without an initial prompt");
    });

    const response = await sessionStartHookDto(runtime, { initialPrompt: "   " });

    expect(response.additionalContext).toContain("- http: HTTP (1 page)");
    expect(response.additionalContext).toContain("Prompt-specific matches skipped: no initial prompt was provided.");
  });

  test("keeps docset context when prompt search is unavailable", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedCacheManifest(cacheRoot, [cacheDocsetSummary()]);
    const runtime = testRuntime(cacheRoot, async () => {
      throw new DdserveError("Embeddings are disabled. Enable embeddings in config before semantic search.");
    });

    const response = await sessionStartHookDto(runtime, { initialPrompt: "hooks" });

    expect(response.additionalContext).toContain("- http: HTTP (1 page)");
    expect(response.additionalContext).toContain(
      "Prompt-specific matches unavailable: Embeddings are disabled. Enable embeddings in config before semantic search.",
    );
  });

  test("rejects malformed request bodies", async () => {
    const cacheRoot = await createTempCacheRoot();
    const runtime = testRuntime(cacheRoot);

    await expect(sessionStartHookDto(runtime, null)).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "Session start hook request body must be a JSON object",
    });
    await expect(sessionStartHookDto(runtime, { initialPrompt: 42 })).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: 'Request body field "initialPrompt" must be a string',
    });
  });

  test("sanitizes docset listing failures instead of exposing cache paths", async () => {
    const cacheRoot = await createTempCacheRoot();
    await writeFile(cachePaths(cacheRoot).manifest, "{ nope", "utf8");
    const runtime = testRuntime(cacheRoot);

    try {
      await sessionStartHookDto(runtime, {});
      throw new Error("Expected sessionStartHookDto to reject");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "invalid_request",
        message: "Request could not be completed",
      });
      expect(error instanceof Error ? error.message : String(error)).not.toContain(cacheRoot);
    }
  });
});

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `copilot-hooks-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

async function seedCacheManifest(cacheRoot: string, docsets: CacheManifestDocset[]): Promise<void> {
  await writeCacheManifest(cacheRoot, {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: Object.fromEntries(docsets.map((docset) => [docset.slug, docset])),
  });
}

function testRuntime(
  cacheRoot: string,
  search: ServerOperationRuntime["search"] = async () => searchResponse("", cacheRoot, 0),
): ServerOperationRuntime {
  return {
    cacheRoot,
    config: parseConfig({}),
    search,
  };
}

function searchResponse(query: string, cacheRoot: string, count: number): SearchResponse {
  return {
    query,
    mode: "semantic",
    model: "model-a",
    dimensions: 2,
    results: Array.from({ length: count }, (_, index) => searchResult(index + 1, cacheRoot)),
  };
}

function searchResult(index: number, cacheRoot: string): SearchResult {
  return {
    score: 0.91 - index / 100,
    mode: "semantic",
    docsetSlug: "http",
    docsetName: "HTTP",
    pageId: `overview-${index}`,
    pageName: `HTTP Overview ${index}`,
    pagePath: `overview-${index}`,
    pageType: "Guide",
    pageFilePath: join(cacheRoot, "docs", "http", "pages", `overview-${index}.md`),
    chunkId: index,
    chunkOrdinal: 0,
    chunkContentHash: `chunk-hash-${index}`,
    snippet: `hook docs snippet ${index}`,
    text: `hook docs text ${index}`,
  };
}

function cacheDocsetSummary(overrides: Partial<CacheManifestDocset> = {}): CacheManifestDocset {
  return {
    source: "devdocs",
    slug: "http",
    name: "HTTP",
    type: "http",
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
