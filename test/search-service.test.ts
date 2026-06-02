import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseConfig } from "../src/config";
import type { EmbeddingClient, EmbeddingVector } from "../src/embeddings/openai";
import {
  closeEmbeddingStorage,
  openEmbeddingStorage,
  upsertChunkEmbeddings,
  type EmbeddingChunkInput,
  type EmbeddingStorage,
} from "../src/embeddings/storage";
import { DdserveError } from "../src/errors";
import { search } from "../src/search";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("search service", () => {
  test("embeds the query and ranks semantic results by cosine similarity", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [
        [0, "a0", "hooks state overview", [1, 0]],
        [1, "a1", "unrelated routing", [0, 1]],
      ]);
      upsertFixtureDocset(storage, "beta", "Beta", "model-a", [[0, "b0", "component hooks guide", [0.8, 0.6]]]);

      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-a"),
        client: fixedEmbeddingClient([1, 0]),
        query: "hooks state",
        limit: 2,
        storage,
        pageSize: 1,
      });

      expect(result.mode).toBe("semantic");
      expect(result.model).toBe("model-a");
      expect(result.dimensions).toBe(2);
      expect(result.results.map((item) => item.chunkContentHash)).toEqual(["a0", "b0"]);
      expect(result.results[0]).toMatchObject({
        score: 1,
        mode: "semantic",
        docsetSlug: "alpha",
        docsetName: "Alpha",
        pageId: "alpha-page-0",
        pageName: "Alpha Page 0",
        pagePath: "alpha/page-0",
        pageType: "Guide",
        pageFilePath: "alpha/page-0.md",
        chunkOrdinal: 0,
        snippet: "hooks state overview",
        text: "hooks state overview",
      });
      expect(result.results[1]?.score).toBeCloseTo(0.8);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("sanitizes data URI and base64 noise from snippets without changing result text", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      const imagePayload = `iVBORw0KGgo${"A".repeat(140)}`;
      const standalonePayload = "QUJD".repeat(30);
      const noisyText = [
        "React hooks overview",
        `![architecture diagram](data:image/png;base64,${imagePayload})`,
        `[inline image](data:image/jpeg;base64,${imagePayload})`,
        standalonePayload,
        "useEffect keeps component state readable.",
      ].join("\n");

      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [[0, "a0", noisyText, [1, 0]]]);

      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-a"),
        client: fixedEmbeddingClient([1, 0]),
        query: "React hooks",
        limit: 1,
        storage,
      });

      const item = result.results[0];
      expect(item?.text).toBe(noisyText);
      expect(item?.snippet).toBe(
        "React hooks overview architecture diagram inline image useEffect keeps component state readable.",
      );
      expect(item?.snippet).not.toContain("data:image");
      expect(item?.snippet).not.toContain(imagePayload);
      expect(item?.snippet).not.toContain(standalonePayload);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("filters semantic candidates across multiple slugs without keyword fallback for partial indexes", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [[0, "a0", "alpha hooks", [1, 0]]]);
      upsertFixtureDocset(storage, "beta", "Beta", "model-a", [[0, "b0", "beta hooks", [0, 1]]]);
      upsertFixtureDocset(storage, "gamma", "Gamma", "model-b", [[0, "g0", "gamma hooks keyword", [1, 0]]]);

      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-a"),
        client: fixedEmbeddingClient([1, 0]),
        query: "gamma hooks",
        resolvedSlugs: ["gamma", "beta"],
        limit: 10,
        storage,
      });

      expect(result.mode).toBe("semantic");
      expect(result.results.map((item) => item.docsetSlug)).toEqual(["beta"]);
      expect(result.results[0]?.mode).toBe("semantic");
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("runs keyword fallback when no vectors exist for the selected model and scope", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [
        [0, "a0", "alpha hooks overview", [1, 0]],
        [1, "a1", "component state", [0, 1]],
      ]);

      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-b"),
        client: fixedEmbeddingClient([1, 0]),
        query: "hooks",
        resolvedSlugs: ["alpha"],
        limit: 10,
        storage,
      });

      expect(result.mode).toBe("keyword");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        score: 1,
        mode: "keyword",
        docsetSlug: "alpha",
        chunkContentHash: "a0",
        text: "alpha hooks overview",
      });
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("returns an empty keyword result when no semantic or keyword candidates match", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-a"),
        client: fixedEmbeddingClient([1, 0]),
        query: "missing",
        limit: 5,
        storage,
      });

      expect(result).toMatchObject({
        mode: "keyword",
        model: "model-a",
        dimensions: 2,
        results: [],
      });
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("validates query text and limit before searching", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      await expect(
        search({
          cacheRoot,
          config: embeddingConfig("model-a"),
          client: fixedEmbeddingClient([1, 0]),
          query: "   ",
          storage,
        }),
      ).rejects.toThrow(DdserveError);
      await expect(
        search({
          cacheRoot,
          config: embeddingConfig("model-a"),
          client: fixedEmbeddingClient([1, 0]),
          query: "hooks",
          limit: 0,
          storage,
        }),
      ).rejects.toThrow(DdserveError);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("fails clearly when semantic search is not configured instead of falling back to keywords", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [[0, "a0", "alpha hooks overview", [1, 0]]]);

      await expect(
        search({
          cacheRoot,
          config: parseConfig({}),
          client: fixedEmbeddingClient([1, 0]),
          query: "hooks",
          storage,
        }),
      ).rejects.toThrow("Embeddings are disabled");
      await expect(
        search({
          cacheRoot,
          config: {
            ...parseConfig({}),
            embeddings: {
              ...parseConfig({}).embeddings,
              enabled: true,
              batchSize: 1,
            },
          },
          client: fixedEmbeddingClient([1, 0]),
          query: "hooks",
          storage,
        }),
      ).rejects.toThrow("OpenAI embeddings are not configured");
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("uses query vector dimensions to avoid mismatched semantic vectors and fall back to keywords", async () => {
    const { cacheRoot, storage } = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", "model-a", [[0, "a0", "alpha hooks overview", [1, 0]]]);

      const result = await search({
        cacheRoot,
        config: embeddingConfig("model-a"),
        client: fixedEmbeddingClient([1, 0, 0]),
        query: "hooks",
        limit: 10,
        storage,
      });

      expect(result.mode).toBe("keyword");
      expect(result.dimensions).toBe(3);
      expect(result.results.map((item) => item.chunkContentHash)).toEqual(["a0"]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });
});

async function openTestStorage(): Promise<{ cacheRoot: string; storage: EmbeddingStorage }> {
  const cacheRoot = await createTempCacheRoot();
  return { cacheRoot, storage: await openEmbeddingStorage(cacheRoot) };
}

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `search-service-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function embeddingConfig(model: string) {
  return parseConfig({
    openai: { embeddingModel: model },
    embeddings: { enabled: true },
  });
}

function fixedEmbeddingClient(vector: EmbeddingVector): EmbeddingClient {
  return {
    async createEmbeddings(input) {
      const count = typeof input === "string" ? 1 : input.length;
      return Array.from({ length: count }, () => [...vector]);
    },
  };
}

function upsertFixtureDocset(
  storage: EmbeddingStorage,
  slug: string,
  name: string,
  model: string,
  chunks: Array<[ordinal: number, contentHash: string, text: string, vector: readonly number[]]>,
): void {
  const dimensions = chunks[0]?.[3].length ?? 2;
  upsertChunkEmbeddings(storage, {
    docset: { slug, name },
    model,
    dimensions,
    indexedAt: "2026-01-01T00:00:00.000Z",
    chunks: chunks.map(([ordinal, contentHash, text, vector]) => chunk(slug, ordinal, contentHash, text, vector)),
  });
}

function chunk(
  slug: string,
  ordinal: number,
  contentHash: string,
  text: string,
  vector: readonly number[],
): EmbeddingChunkInput {
  return {
    page: {
      id: `${slug}-page-${ordinal}`,
      filePath: `${slug}/page-${ordinal}.md`,
      title: `${capitalize(slug)} Page ${ordinal}`,
      name: `${capitalize(slug)} Page ${ordinal}`,
      path: `${slug}/page-${ordinal}`,
      type: "Guide",
      contentHash: `${slug}-page-hash-${ordinal}`,
    },
    ordinal: 0,
    contentHash,
    text,
    vector,
    sourceHash: `${slug}-page-hash-${ordinal}`,
  };
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
