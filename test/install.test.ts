import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { installDocset, removeDocset, updateDocsets } from "../src/install";
import type { HttpClient } from "../src/http";
import { pathExists, readCacheManifest } from "../src/cache";
import { defaultConfig, parseConfig } from "../src/config";
import {
  closeEmbeddingStorage,
  openEmbeddingStorage,
  queryEmbeddingStatus,
} from "../src/embeddings/storage";
import type { EmbeddingClient, EmbeddingInput, EmbeddingVector } from "../src/embeddings/openai";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installDocset", () => {
  test("downloads raw assets, extracts pages, and writes manifests", async () => {
    const cacheRoot = await createTempCacheRoot("install");
    const http = createFixtureHttpClient({
      "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
      "https://documents.devdocs.io/http/index.json": {
        entries: [{ name: "HTTP Overview", path: "index", type: "HTTP" }],
      },
      "https://documents.devdocs.io/http/db.json": {
        index: "<h1>HTTP</h1><p>Protocol docs.</p>",
      },
    });

    const result = await installDocset("http", {
      cacheRoot,
      http,
      now: new Date("2026-01-01T00:00:00Z"),
      config: defaultConfig(),
    });

    expect(result.status).toBe("installed");
    expect(result.pages).toBe(1);

    const manifest = JSON.parse(await readFile(join(cacheRoot, "docs", "http", "manifest.json"), "utf8"));
    expect(manifest.rawFiles.map((file: { file: string }) => file.file)).toEqual([
      "raw/docset.json",
      "raw/index.json",
      "raw/db.json",
    ]);
    expect(manifest.contentFormat).toBe("markdown");
    expect(manifest.pages[0].format).toBe("markdown");
    expect(manifest.pages[0].file.endsWith(".md")).toBe(true);
    expect(await readFile(join(cacheRoot, "docs", "http", manifest.pages[0].file), "utf8")).toContain("Protocol docs.");

    const topLevel = await readCacheManifest(cacheRoot);
    expect(topLevel.docs.http?.pageCount).toBe(1);
    expect(topLevel.docs.http?.contentFormat).toBe("markdown");
  });

  test("skips reinstall when mtime is current", async () => {
    const cacheRoot = await createTempCacheRoot("install-current");
    const http = createFixtureHttpClient({
      "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
      "https://documents.devdocs.io/http/index.json": {
        entries: [{ name: "HTTP Overview", path: "index", type: "HTTP" }],
      },
      "https://documents.devdocs.io/http/db.json": {
        index: "<h1>HTTP</h1><p>Protocol docs.</p>",
      },
    });

    await installDocset("http", { cacheRoot, http, config: defaultConfig() });
    const second = await installDocset("http", { cacheRoot, http, config: defaultConfig() });

    expect(second.status).toBe("skipped");
  });

  test("refreshes embeddings after installing docs when embeddings are configured", async () => {
    const cacheRoot = await createTempCacheRoot("install-embeddings");
    const http = createFixtureHttpClient(httpFixtures());
    const embeddingClient = new FakeEmbeddingClient();

    const result = await installDocset("http", {
      cacheRoot,
      http,
      config: embeddingConfig(),
      embeddingClient,
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("installed");
    expect(result.warnings).toEqual([]);
    expect(embeddingClient.calls.length).toBeGreaterThan(0);

    const storage = await openEmbeddingStorage(cacheRoot);
    try {
      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })).toEqual([
        expect.objectContaining({
          docsetSlug: "http",
          model: "fake-embedding-model",
          dimensions: 2,
          chunkCount: embeddingClient.inputCount,
          embeddedChunkCount: embeddingClient.inputCount,
          indexedChunkCount: embeddingClient.inputCount,
        }),
      ]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("does not call the embedding client for skipped docs with current embeddings", async () => {
    const cacheRoot = await createTempCacheRoot("install-current-embeddings");
    const http = createFixtureHttpClient(httpFixtures());
    const firstClient = new FakeEmbeddingClient();
    const config = embeddingConfig();

    await installDocset("http", { cacheRoot, http, config, embeddingClient: firstClient });
    expect(firstClient.inputCount).toBeGreaterThan(0);

    const secondClient = new FakeEmbeddingClient();
    const second = await installDocset("http", { cacheRoot, http, config, embeddingClient: secondClient });

    expect(second.status).toBe("skipped");
    expect(second.warnings).toEqual([]);
    expect(secondClient.inputCount).toBe(0);
  });

  test("refreshes missing embeddings when update skips already current docs", async () => {
    const cacheRoot = await createTempCacheRoot("update-current-missing-embeddings");
    const http = createFixtureHttpClient(httpFixtures());
    await installDocset("http", { cacheRoot, http, config: defaultConfig() });

    const embeddingClient = new FakeEmbeddingClient();
    const results = await updateDocsets("http", {
      cacheRoot,
      http,
      config: embeddingConfig(),
      embeddingClient,
      now: new Date("2026-01-02T00:00:00Z"),
    });

    expect(results).toEqual([
      expect.objectContaining({
        slug: "http",
        status: "skipped",
        warnings: [],
      }),
    ]);
    expect(embeddingClient.inputCount).toBeGreaterThan(0);

    const storage = await openEmbeddingStorage(cacheRoot);
    try {
      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })).toEqual([
        expect.objectContaining({
          docsetSlug: "http",
          model: "fake-embedding-model",
          embeddedChunkCount: embeddingClient.inputCount,
          indexedChunkCount: embeddingClient.inputCount,
        }),
      ]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("warns and keeps installed docs when embedding refresh fails", async () => {
    const cacheRoot = await createTempCacheRoot("install-embeddings-fail");
    const http = createFixtureHttpClient(httpFixtures());

    const result = await installDocset("http", {
      cacheRoot,
      http,
      config: embeddingConfig(),
      embeddingClient: new FakeEmbeddingClient(new Error("embedding service unavailable")),
    });

    expect(result.status).toBe("installed");
    expect(result.warnings).toEqual([
      "Failed to refresh embeddings for http; docs remain installed. embedding service unavailable",
    ]);
    const manifest = JSON.parse(await readFile(join(cacheRoot, "docs", "http", "manifest.json"), "utf8"));
    expect(manifest.pages).toHaveLength(1);
  });

  test("cleans partial docset directory when extraction fails", async () => {
    const cacheRoot = await createTempCacheRoot("install-extraction-fail");
    const http = createFixtureHttpClient({
      "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
      "https://documents.devdocs.io/http/index.json": {
        entries: [{ name: "HTTP Overview", path: "index", type: "HTTP" }],
      },
      "https://documents.devdocs.io/http/db.json": {},
    });

    await expect(installDocset("http", { cacheRoot, http, config: defaultConfig() })).rejects.toThrow(
      'Downloaded "http", but no pages could be extracted',
    );

    const docsEntries = await readdir(join(cacheRoot, "docs"));
    expect(docsEntries.filter((entry) => entry.startsWith("http.partial-"))).toEqual([]);
  });

  test("removes installed docs, cache manifest entries, and indexed embeddings", async () => {
    const cacheRoot = await createTempCacheRoot("remove");
    const http = createFixtureHttpClient(httpFixtures());
    const embeddingClient = new FakeEmbeddingClient();

    await installDocset("http", {
      cacheRoot,
      http,
      config: embeddingConfig(),
      embeddingClient,
    });

    const result = await removeDocset("http", {
      cacheRoot,
      now: new Date("2026-01-02T00:00:00Z"),
    });

    expect(result).toMatchObject({
      slug: "http",
      name: "HTTP",
      pages: 1,
      removedEmbeddings: {
        deletedDocsets: 1,
        deletedPages: 1,
        deletedChunks: embeddingClient.inputCount,
        deletedEmbeddings: embeddingClient.inputCount,
      },
    });
    expect(await pathExists(join(cacheRoot, "docs", "http"))).toBe(false);

    const topLevel = await readCacheManifest(cacheRoot);
    expect(topLevel.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(topLevel.docs.http).toBeUndefined();

    const storage = await openEmbeddingStorage(cacheRoot);
    try {
      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })).toEqual([]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("reports progress while updating installed docsets", async () => {
    const cacheRoot = await createTempCacheRoot("update-progress");
    const http = createFixtureHttpClient({
      "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
      "https://documents.devdocs.io/http/index.json": {
        entries: [{ name: "HTTP Overview", path: "index", type: "HTTP" }],
      },
      "https://documents.devdocs.io/http/db.json": {
        index: "<h1>HTTP</h1><p>Protocol docs.</p>",
      },
    });

    await installDocset("http", { cacheRoot, http, config: defaultConfig() });
    const events: string[] = [];
    await updateDocsets(undefined, {
      cacheRoot,
      http,
      force: true,
      config: defaultConfig(),
      onProgress(event) {
        events.push(`${event.phase}:${event.slug}:${event.index}/${event.total}`);
      },
    });

    expect(events).toEqual(["start:http:1/1", "done:http:1/1"]);
  });
});

async function createTempCacheRoot(prefix: string): Promise<string> {
  const root = join(process.cwd(), ".test-work", "install", `${prefix}-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function httpFixtures(): Record<string, unknown> {
  return {
    "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
    "https://documents.devdocs.io/http/index.json": {
      entries: [{ name: "HTTP Overview", path: "index", type: "HTTP" }],
    },
    "https://documents.devdocs.io/http/db.json": {
      index: "<h1>HTTP</h1><p>Protocol docs.</p>",
    },
  };
}

function embeddingConfig() {
  return parseConfig({
    openai: {
      baseURL: "http://localhost:11434/v1",
      embeddingModel: "fake-embedding-model",
    },
    embeddings: {
      enabled: true,
      batchSize: 1,
    },
  });
}

class FakeEmbeddingClient implements EmbeddingClient {
  readonly calls: string[][] = [];

  constructor(private readonly error?: Error) {}

  get inputCount(): number {
    return this.calls.reduce((count, call) => count + call.length, 0);
  }

  async createEmbeddings(input: EmbeddingInput): Promise<EmbeddingVector[]> {
    if (this.error) {
      throw this.error;
    }

    const values = typeof input === "string" ? [input] : [...input];
    this.calls.push(values);
    return values.map((_, index) => [index + 1, index + 2]);
  }
}

function createFixtureHttpClient(fixtures: Record<string, unknown>): HttpClient {
  return {
    async fetchJson<T>(url: string): Promise<T> {
      if (!(url in fixtures)) {
        throw new Error(`Missing fixture for ${url}`);
      }
      return fixtures[url] as T;
    },
    async downloadFile(url: string, destination: string) {
      if (!(url in fixtures)) {
        throw new Error(`Missing fixture for ${url}`);
      }
      const body = `${JSON.stringify(fixtures[url])}\n`;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body, "utf8");
      return {
        path: destination,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    },
  };
}
