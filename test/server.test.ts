import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cachePaths, writeCacheManifest } from "../src/cache";
import { parseConfig } from "../src/config";
import {
  closeEmbeddingStorage,
  openEmbeddingStorage,
  upsertChunkEmbeddings,
  type EmbeddingStorage,
} from "../src/embeddings/storage";
import type { EmbeddingClient } from "../src/embeddings/openai";
import { createServerApp, resolveServeOptions } from "../src/server";
import type { CacheManifestDocset, DocsetManifest, PageManifestEntry } from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server API", () => {
  test("lists installed docsets without exposing local file paths", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const response = await app.handle(new Request("http://localhost/api/docsets"));
    const body = (await response.json()) as { docsets: unknown[] };

    expect(response.status).toBe(200);
    expect(body.docsets).toEqual([
      expect.objectContaining({
        slug: "http",
        name: "HTTP",
        pageCount: 1,
        links: expect.objectContaining({
          self: "/api/docsets/http",
          pages: "/api/docsets/http/pages",
        }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(cacheRoot);
  });

  test("fetches full and line-ranged page content through manifest page IDs", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const full = await app.handle(new Request("http://localhost/api/docsets/http/pages/overview/content"));
    const fullBody = (await full.json()) as { content: string; startLine: number; totalLines: number };

    expect(full.status).toBe(200);
    expect(fullBody.content).toContain("# HTTP Overview");
    expect(fullBody.startLine).toBe(1);
    expect(fullBody.totalLines).toBe(6);
    expect(JSON.stringify(fullBody)).not.toContain(cacheRoot);
    expect(JSON.stringify(fullBody)).not.toContain("pages/overview.md");

    const range = await app.handle(
      new Request("http://localhost/api/docsets/http/pages/overview/content?startLine=3&endLine=4"),
    );
    const rangeBody = await range.json();

    expect(range.status).toBe(200);
    expect(rangeBody).toMatchObject({
      startLine: 3,
      endLine: 4,
      totalLines: 6,
      content: "Protocol docs.\nHeader details.",
    });
  });

  test("rejects invalid line ranges and unknown pages", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const invalidRange = await app.handle(
      new Request("http://localhost/api/docsets/http/pages/overview/content?startLine=5&endLine=2"),
    );
    expect(invalidRange.status).toBe(400);
    expect(await invalidRange.json()).toEqual({
      error: {
        code: "invalid_line_range",
        message: "startLine must be less than or equal to endLine",
      },
    });

    const missingPage = await app.handle(new Request("http://localhost/api/docsets/http/pages/missing"));
    expect(missingPage.status).toBe(404);
    expect(await missingPage.json()).toEqual({
      error: {
        code: "not_found",
        message: 'Page "missing" is not installed for docset "http"',
      },
    });
  });

  test("rejects path traversal attempts through page identifiers and manifest file paths", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const traversalPageId = await app.handle(
      new Request("http://localhost/api/docsets/http/pages/..%2F..%2Fsecret/content"),
    );
    expect(traversalPageId.status).toBe(404);
    expect(await traversalPageId.json()).toEqual({
      error: {
        code: "not_found",
        message: 'Page "../../secret" is not installed for docset "http"',
      },
    });

    await seedDocset(cacheRoot, {
      pages: [pageEntry({ id: "escape", file: "../outside.md" })],
    });
    await writeFile(join(cachePaths(cacheRoot).docsRoot, "outside.md"), "outside secret", "utf8");

    const traversalManifestFile = await app.handle(
      new Request("http://localhost/api/docsets/http/pages/escape/content"),
    );
    const body = await traversalManifestFile.json();

    expect(traversalManifestFile.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request could not be completed",
      },
    });
    expect(JSON.stringify(body)).not.toContain("outside secret");
    expect(JSON.stringify(body)).not.toContain(cacheRoot);
  });

  test("search returns remote-safe document references and links", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const storage = await openEmbeddingStorage(cacheRoot);

    try {
      upsertSearchFixture(storage);
    } finally {
      closeEmbeddingStorage(storage);
    }

    const app = createServerApp({
      cacheRoot,
      config: parseConfig({
        openai: { embeddingModel: "model-a" },
        embeddings: { enabled: true },
      }),
      embeddingClient: vectorEmbeddingClient([1, 0]),
    });

    const response = await app.handle(new Request("http://localhost/api/search?q=hooks&slug=http"));
    const body = (await response.json()) as {
      results: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      query: "hooks",
      mode: "semantic",
      model: "model-a",
      dimensions: 2,
      resolvedSlugs: ["http"],
    });
    expect(body.results[0]).toMatchObject({
      docsetSlug: "http",
      pageId: "overview",
      pageName: "HTTP Overview",
      pagePath: "index",
      snippet: "hooks protocol docs",
      links: {
        self: "/api/docsets/http/pages/overview",
        content: "/api/docsets/http/pages/overview/content",
      },
    });
    expect(body.results[0]).not.toHaveProperty("pageFilePath");
    expect(body.results[0]).not.toHaveProperty("installedFilePath");
    expect(JSON.stringify(body)).not.toContain(cacheRoot);
  });

  test("supports POST search request bodies", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const storage = await openEmbeddingStorage(cacheRoot);

    try {
      upsertSearchFixture(storage);
    } finally {
      closeEmbeddingStorage(storage);
    }

    const app = createServerApp({
      cacheRoot,
      config: parseConfig({
        openai: { embeddingModel: "model-a" },
        embeddings: { enabled: true },
      }),
      embeddingClient: vectorEmbeddingClient([1, 0]),
    });

    const response = await app.handle(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "hooks", slugs: ["http"], limit: 1 }),
      }),
    );
    const body = (await response.json()) as { results: Array<{ docsetSlug: string }> };

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.docsetSlug).toBe("http");
  });

  test("omits filesystem paths from embeddings status", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const dbPath = cachePaths(cacheRoot).embeddingsDb;
    const app = createServerApp({
      cacheRoot,
      config: parseConfig({
        openai: { embeddingModel: "model-a" },
        embeddings: { enabled: true },
      }),
    });

    expect(await Bun.file(dbPath).exists()).toBe(false);
    const response = await app.handle(new Request("http://localhost/api/embeddings/status"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(await Bun.file(dbPath).exists()).toBe(false);
    expect(body).not.toHaveProperty("databasePath");
    expect(JSON.stringify(body)).not.toContain(dbPath);
    expect(body).toMatchObject({
      enabled: true,
      configured: true,
      model: "model-a",
      installed: { docsets: 1, pages: 1 },
    });
  });

  test("sanitizes path-bearing internal errors", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    await writeFile(cachePaths(cacheRoot).manifest, "{ nope", "utf8");
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const response = await app.handle(new Request("http://localhost/api/docsets"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request could not be completed",
      },
    });
    expect(JSON.stringify(body)).not.toContain(cacheRoot);
  });

  test("returns JSON error envelopes for framework errors", async () => {
    const cacheRoot = await createTempCacheRoot();
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const missingRoute = await app.handle(new Request("http://localhost/api/missing"));
    expect(missingRoute.status).toBe(404);
    expect(missingRoute.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await missingRoute.json()).toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });

    const malformedJson = await app.handle(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await malformedJson.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be valid JSON",
      },
    });
  });

  test("enforces optional bearer auth and configurable CORS", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({
      cacheRoot,
      config: parseConfig({
        serve: {
          auth: { tokenEnv: "DDSERVE_TEST_TOKEN" },
          cors: { origins: ["http://client.test"] },
        },
      }),
      env: { DDSERVE_TEST_TOKEN: "secret" },
    });

    const unauthorized = await app.handle(
      new Request("http://localhost/api", { headers: { origin: "http://client.test" } }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe("http://client.test");

    const authorized = await app.handle(
      new Request("http://localhost/api", {
        headers: {
          authorization: "Bearer secret",
          origin: "http://client.test",
        },
      }),
    );
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("access-control-allow-origin")).toBe("http://client.test");
  });

  test("responds to configured CORS preflight requests", async () => {
    const cacheRoot = await createTempCacheRoot();
    const app = createServerApp({
      cacheRoot,
      config: parseConfig({
        serve: {
          cors: { origins: ["http://client.test"] },
        },
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/api/search", {
        method: "OPTIONS",
        headers: { origin: "http://client.test" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://client.test");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("rejects unexpected host headers on localhost binds", async () => {
    const cacheRoot = await createTempCacheRoot();
    await seedDocset(cacheRoot);
    const app = createServerApp({ cacheRoot, config: parseConfig({}) });

    const response = await app.handle(new Request("http://evil.test/api"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Host header is not allowed",
      },
    });
  });

  test("resolves serve host and port defaults from config and overrides", () => {
    const config = parseConfig({
      serve: {
        bindAddress: "0.0.0.0",
        port: 12345,
      },
    });

    expect(resolveServeOptions(config)).toEqual({ host: "0.0.0.0", port: 12345 });
    expect(resolveServeOptions(config, { host: "127.0.0.1", port: 2222 })).toEqual({
      host: "127.0.0.1",
      port: 2222,
    });
  });
});

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `server-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

async function seedDocset(
  cacheRoot: string,
  options: {
    pages?: PageManifestEntry[];
  } = {},
): Promise<void> {
  const page = options.pages?.[0] ?? pageEntry();
  const manifest = manifestWithPages(options.pages ?? [page]);
  const paths = cachePaths(cacheRoot);
  await mkdir(join(paths.docsRoot, "http", "pages"), { recursive: true });
  await writeFile(
    join(paths.docsRoot, "http", page.file),
    "# HTTP Overview\n\nProtocol docs.\nHeader details.\nFinal line.\n",
    "utf8",
  );
  await Bun.write(join(paths.docsRoot, "http", "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeCacheManifest(cacheRoot, {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: {
      http: cacheDocsetSummary(),
    },
  });
}

function upsertSearchFixture(storage: EmbeddingStorage): void {
  upsertChunkEmbeddings(storage, {
    docset: {
      slug: "http",
      name: "HTTP",
      source: "devdocs",
      contentFormat: "markdown",
      installedAt: "2026-01-01T00:00:00.000Z",
      manifestUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    model: "model-a",
    dimensions: 2,
    indexedAt: "2026-01-01T00:00:00.000Z",
    chunks: [
      {
        page: {
          id: "overview",
          filePath: "pages/overview.md",
          title: "HTTP Overview",
          name: "HTTP Overview",
          path: "index",
          type: "Guide",
          contentHash: "page-hash",
        },
        ordinal: 0,
        contentHash: "chunk-hash",
        sourceHash: "page-hash",
        text: "hooks protocol docs",
        vector: [1, 0],
      },
    ],
  });
}

function cacheDocsetSummary(): CacheManifestDocset {
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
  };
}

function pageEntry(overrides: Partial<PageManifestEntry> = {}): PageManifestEntry {
  return {
    id: "overview",
    name: "HTTP Overview",
    path: "index",
    type: "Guide",
    file: "pages/overview.md",
    format: "markdown",
    sourceKey: "index",
    ...overrides,
  };
}

function manifestWithPages(pages: PageManifestEntry[]): DocsetManifest {
  return {
    schemaVersion: 1,
    extractorVersion: 4,
    contentFormat: "markdown",
    source: "devdocs",
    status: "installed",
    slug: "http",
    name: "HTTP",
    type: "http",
    version: "1",
    release: "2026-01-01",
    mtime: 1,
    dbSize: 10,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    upstream: {
      docsIndexUrl: "https://devdocs.io/docs.json",
      indexUrl: "https://documents.devdocs.io/http/index.json",
      dbUrl: "https://documents.devdocs.io/http/db.json",
    },
    rawFiles: [],
    pages,
    skippedEntries: 0,
  };
}

function vectorEmbeddingClient(vector: number[]): EmbeddingClient {
  return {
    async createEmbeddings(input) {
      const count = typeof input === "string" ? 1 : input.length;
      return Array.from({ length: count }, () => [...vector]);
    },
  };
}
