import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseConfig } from "../src/config";
import { refreshDocsetEmbeddings } from "../src/embeddings";
import type { EmbeddingClient } from "../src/embeddings/openai";
import { closeEmbeddingStorage, openEmbeddingStorage, queryEmbeddingStatus } from "../src/embeddings/storage";
import type { DocsetManifest, PageManifestEntry } from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("refreshDocsetEmbeddings", () => {
  test("embeds only changed chunks and prunes stale rows on subsequent refreshes", async () => {
    const { cacheRoot, manifest } = await createFixtureDocset("Initial protocol docs.");
    const calls: string[][] = [];
    const client = recordingEmbeddingClient(calls);
    const config = parseConfig({
      openai: { embeddingModel: "fake-refresh-model" },
      embeddings: { enabled: true, batchSize: 1 },
    });

    await expect(
      refreshDocsetEmbeddings({
        cacheRoot,
        manifest,
        config,
        client,
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      status: "refreshed",
      chunks: 1,
      embeddedChunks: 1,
      skippedChunks: 0,
    });

    await writeFixturePage(cacheRoot, "Updated protocol docs with new content.");
    await expect(
      refreshDocsetEmbeddings({
        cacheRoot,
        manifest,
        config,
        client,
        now: new Date("2026-01-02T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      status: "refreshed",
      chunks: 1,
      embeddedChunks: 1,
      skippedChunks: 0,
    });

    await expect(
      refreshDocsetEmbeddings({
        cacheRoot,
        manifest,
        config,
        client,
        now: new Date("2026-01-03T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      chunks: 1,
      embeddedChunks: 0,
      skippedChunks: 1,
    });
    expect(calls).toHaveLength(2);

    const storage = await openEmbeddingStorage(cacheRoot);
    try {
      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })).toEqual([
        expect.objectContaining({
          docsetSlug: "http",
          model: "fake-refresh-model",
          chunkCount: 1,
          embeddedChunkCount: 1,
          indexedChunkCount: 1,
          indexedAt: "2026-01-03T00:00:00.000Z",
        }),
      ]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });
});

async function createFixtureDocset(markdownBody: string): Promise<{ cacheRoot: string; manifest: DocsetManifest }> {
  const cacheRoot = await createTempCacheRoot();
  await writeFixturePage(cacheRoot, markdownBody);
  return { cacheRoot, manifest: manifestWithPages([pageEntry()]) };
}

async function writeFixturePage(cacheRoot: string, markdownBody: string): Promise<void> {
  const docsetRoot = join(cacheRoot, "docs", "http");
  await mkdir(join(docsetRoot, "pages"), { recursive: true });
  await Bun.write(join(docsetRoot, "pages", "overview.md"), `# HTTP Overview\n\n${markdownBody}`);
}

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `embeddings-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
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

function recordingEmbeddingClient(calls: string[][]): EmbeddingClient {
  return {
    async createEmbeddings(input) {
      const batch = typeof input === "string" ? [input] : [...input];
      calls.push(batch);
      return batch.map((text) => [text.length, 1]);
    },
  };
}
