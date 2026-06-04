import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { cachePaths, pathExists } from "../src/cache";
import {
  closeEmbeddingStorage,
  deleteStaleChunksForDocsetModel,
  getChunkEmbeddingState,
  isChunkEmbeddingCurrent,
  openEmbeddingStorage,
  queryEmbeddingStatus,
  upsertChunkEmbeddings,
  type EmbeddingChunkInput,
  type EmbeddingStorage,
} from "../src/embeddings/storage";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("embedding storage", () => {
  test("opens the cache-local SQLite database and initializes schema metadata", async () => {
    const cacheRoot = await createTempCacheRoot();
    const storage = await openEmbeddingStorage(cacheRoot);

    try {
      expect(storage.path).toBe(cachePaths(cacheRoot).embeddingsDb);
      expect(await pathExists(storage.path)).toBe(true);
      expect(
        storage.db
          .prepare<{ value: string }, [string]>("SELECT value FROM embedding_schema_metadata WHERE key = ?")
          .get("schema_version")?.value,
      ).toBe("1");
      expect(storage.db.prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(storage.db.prepare<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(storage.db.prepare<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(1);
      expect(storage.db.prepare<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
      expect(storage.db.prepare<{ temp_store: number }, []>("PRAGMA temp_store").get()?.temp_store).toBe(2);
      expect(
        storage.db
          .prepare<{ name: string }, []>("PRAGMA index_list(embeddings)")
          .all()
          .map((row) => row.name),
      ).toContain("embeddings_model_chunk_idx");
      expect(
        storage.db
          .prepare<{ name: string }, []>("PRAGMA index_list(chunks)")
          .all()
          .map((row) => row.name),
      ).toContain("chunks_docset_id_idx");
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("upserts chunk embeddings and detects current, stale, and missing records", async () => {
    const storage = await openTestStorage();

    try {
      upsertChunkEmbeddings(storage, {
        docset: {
          slug: "http",
          name: "HTTP",
          contentFormat: "markdown",
          manifestUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
        model: "text-embedding-3-small",
        dimensions: 3,
        indexedAt: "2026-01-01T00:00:00.000Z",
        chunks: [
          chunk({ ordinal: 0, contentHash: "hash-a", text: "HTTP overview", vector: [0.1, 0.2, 0.3] }),
          chunk({ ordinal: 1, contentHash: "hash-b", text: "HTTP methods", vector: [0.4, 0.5, 0.6] }),
        ],
      });

      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })).toEqual([
        {
          docsetSlug: "http",
          docsetName: "HTTP",
          model: "text-embedding-3-small",
          dimensions: 3,
          chunkCount: 2,
          embeddedChunkCount: 2,
          indexedChunkCount: 2,
          indexedAt: "2026-01-01T00:00:00.000Z",
          lastEmbeddedAt: "2026-01-01T00:00:00.000Z",
          docsetUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(
        isChunkEmbeddingCurrent(storage, {
          docsetSlug: "http",
          pageId: "overview",
          ordinal: 0,
          contentHash: "hash-a",
          model: "text-embedding-3-small",
          dimensions: 3,
        }),
      ).toBe(true);
      expect(
        getChunkEmbeddingState(storage, {
          docsetSlug: "http",
          pageId: "overview",
          ordinal: 0,
          contentHash: "changed",
          model: "text-embedding-3-small",
          dimensions: 3,
        }),
      ).toBe("stale");
      expect(
        getChunkEmbeddingState(storage, {
          docsetSlug: "http",
          pageId: "missing",
          ordinal: 0,
          contentHash: "hash-a",
          model: "text-embedding-3-small",
          dimensions: 3,
        }),
      ).toBe("missing");
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("deletes stale chunks for a docset and model in a transaction", async () => {
    const storage = await openTestStorage();

    try {
      upsertChunkEmbeddings(storage, {
        docset: { slug: "http", name: "HTTP" },
        model: "text-embedding-3-small",
        dimensions: 2,
        indexedAt: "2026-01-01T00:00:00.000Z",
        chunks: [
          chunk({ ordinal: 0, contentHash: "old", text: "old overview", vector: [0.1, 0.2] }),
          chunk({ ordinal: 1, contentHash: "keep", text: "methods", vector: [0.3, 0.4] }),
        ],
      });
      upsertChunkEmbeddings(storage, {
        docset: { slug: "http", name: "HTTP" },
        model: "text-embedding-3-small",
        dimensions: 2,
        indexedAt: "2026-01-02T00:00:00.000Z",
        chunks: [chunk({ ordinal: 0, contentHash: "new", text: "new overview", vector: [0.5, 0.6] })],
      });

      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })[0]?.chunkCount).toBe(3);

      const result = deleteStaleChunksForDocsetModel(storage, {
        docsetSlug: "http",
        model: "text-embedding-3-small",
        currentChunks: [
          { pageId: "overview", ordinal: 0, contentHash: "new" },
          { pageId: "overview", ordinal: 1, contentHash: "keep" },
        ],
        deletedAt: "2026-01-03T00:00:00.000Z",
      });

      expect(result).toEqual({ deletedEmbeddings: 1, deletedChunks: 1, deletedPages: 0 });
      expect(queryEmbeddingStatus(storage, { docsetSlug: "http" })[0]).toMatchObject({
        chunkCount: 2,
        embeddedChunkCount: 2,
        indexedChunkCount: 2,
        indexedAt: "2026-01-03T00:00:00.000Z",
      });
      expect(
        getChunkEmbeddingState(storage, {
          docsetSlug: "http",
          pageId: "overview",
          ordinal: 0,
          contentHash: "old",
          model: "text-embedding-3-small",
          dimensions: 2,
        }),
      ).toBe("stale");
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("deletes stale embeddings only for the requested model", async () => {
    const storage = await openTestStorage();

    try {
      const oldChunk = chunk({ ordinal: 0, contentHash: "old", text: "old overview", vector: [0.1, 0.2] });
      upsertChunkEmbeddings(storage, {
        docset: { slug: "http", name: "HTTP" },
        model: "model-a",
        dimensions: 2,
        indexedAt: "2026-01-01T00:00:00.000Z",
        chunks: [oldChunk],
      });
      upsertChunkEmbeddings(storage, {
        docset: { slug: "http", name: "HTTP" },
        model: "model-b",
        dimensions: 2,
        indexedAt: "2026-01-01T00:00:00.000Z",
        chunks: [oldChunk],
      });

      const result = deleteStaleChunksForDocsetModel(storage, {
        docsetSlug: "http",
        model: "model-a",
        currentChunks: [{ pageId: "overview", ordinal: 0, contentHash: "new" }],
        deletedAt: "2026-01-02T00:00:00.000Z",
      });

      expect(result).toEqual({ deletedEmbeddings: 1, deletedChunks: 0, deletedPages: 0 });
      expect(
        getChunkEmbeddingState(storage, {
          docsetSlug: "http",
          pageId: "overview",
          ordinal: 0,
          contentHash: "old",
          model: "model-a",
          dimensions: 2,
        }),
      ).toBe("missing");
      expect(
        isChunkEmbeddingCurrent(storage, {
          docsetSlug: "http",
          pageId: "overview",
          ordinal: 0,
          contentHash: "old",
          model: "model-b",
          dimensions: 2,
        }),
      ).toBe(true);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });
});

async function openTestStorage(): Promise<EmbeddingStorage> {
  return openEmbeddingStorage(await createTempCacheRoot());
}

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `embedding-storage-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function chunk(overrides: {
  ordinal: number;
  contentHash: string;
  text: string;
  vector: readonly number[];
}): EmbeddingChunkInput {
  return {
    page: {
      id: "overview",
      filePath: "pages/overview.md",
      title: "Overview",
      name: "Overview",
      path: "overview",
      contentHash: "page-hash",
    },
    sourceHash: "page-hash",
    metadataJson: JSON.stringify({ fixture: true }),
    ...overrides,
  };
}
