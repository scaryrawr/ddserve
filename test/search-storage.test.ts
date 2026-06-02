import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  closeEmbeddingStorage,
  encodeFloat32Vector,
  openEmbeddingStorage,
  upsertChunkEmbeddings,
  type EmbeddingChunkInput,
  type EmbeddingStorage,
} from "../src/embeddings/storage";
import { DdserveError } from "../src/errors";
import {
  decodeFloat32VectorBlob,
  iterateSemanticSearchCandidates,
  queryKeywordFallbackCandidates,
  querySemanticSearchCandidatePage,
} from "../src/search/storage";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("search storage", () => {
  test("decodes f32le vector blobs", () => {
    const vector = decodeFloat32VectorBlob(encodeFloat32Vector([0.25, -1.5, 3]), 3);

    expect(Array.from(vector)).toEqual([0.25, -1.5, 3]);
  });

  test("reads semantic candidates with decoded vectors for multiple docset slugs", async () => {
    const storage = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", [[0, "a0", "alpha hooks", [0.1, 0.2]]]);
      upsertFixtureDocset(storage, "beta", "Beta", [[0, "b0", "beta streams", [0.3, 0.4]]]);
      upsertFixtureDocset(storage, "gamma", "Gamma", [[0, "g0", "gamma workers", [0.5, 0.6]]]);

      const page = querySemanticSearchCandidatePage(storage, {
        model: "model-a",
        dimensions: 2,
        docsetSlugs: ["gamma", "alpha"],
        limit: 10,
      });

      expect(page.hasMore).toBe(false);
      expect(page.candidates.map((candidate) => candidate.docsetSlug)).toEqual(["alpha", "gamma"]);
      expect(page.candidates.map((candidate) => Array.from(candidate.vector))).toEqual([
        expectFloatVector([0.1, 0.2]),
        expectFloatVector([0.5, 0.6]),
      ]);
      expect(page.candidates[0]).toMatchObject({
        docsetName: "Alpha",
        pageId: "alpha-page-0",
        pageName: "Alpha Page 0",
        pagePath: "alpha/page-0",
        pageType: "Guide",
        pageFilePath: "alpha/page-0.md",
        chunkOrdinal: 0,
        chunkText: "alpha hooks",
        chunkContentHash: "a0",
        model: "model-a",
        dimensions: 2,
      });
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("filters semantic candidates by model, dimensions, and selected docset union", async () => {
    const storage = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", [[0, "a0", "alpha model-a", [1, 0]]]);
      upsertFixtureDocsetForModel(storage, "beta", "Beta", "model-b", [
        [0, "b0", "beta model-b", [0, 1]],
      ]);
      upsertFixtureDocsetForModel(storage, "gamma", "Gamma", "model-a", [
        [0, "g0", "gamma dimensions-three", [0, 0, 1]],
      ]);

      const broad = querySemanticSearchCandidatePage(storage, { model: "model-a", dimensions: 2, limit: 10 });
      const scoped = querySemanticSearchCandidatePage(storage, {
        model: "model-a",
        dimensions: 2,
        docsetSlugs: ["gamma", "alpha", "beta"],
        limit: 10,
      });
      const mismatchedScope = querySemanticSearchCandidatePage(storage, {
        model: "model-a",
        dimensions: 2,
        docsetSlugs: ["gamma", "beta"],
        limit: 10,
      });

      expect(broad.candidates.map((candidate) => candidate.docsetSlug)).toEqual(["alpha"]);
      expect(scoped.candidates.map((candidate) => candidate.docsetSlug)).toEqual(["alpha"]);
      expect(mismatchedScope.candidates).toEqual([]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("pages broad semantic scans without loading all candidates at once", async () => {
    const storage = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", [
        [0, "a0", "alpha 0", [0, 0.1]],
        [1, "a1", "alpha 1", [1, 1.1]],
        [2, "a2", "alpha 2", [2, 2.1]],
        [3, "a3", "alpha 3", [3, 3.1]],
        [4, "a4", "alpha 4", [4, 4.1]],
      ]);

      const firstPage = querySemanticSearchCandidatePage(storage, { model: "model-a", dimensions: 2, limit: 2 });
      const secondPage = querySemanticSearchCandidatePage(storage, {
        model: "model-a",
        dimensions: 2,
        afterChunkId: firstPage.nextAfterChunkId,
        limit: 2,
      });
      const iterated = Array.from(iterateSemanticSearchCandidates(storage, { model: "model-a", dimensions: 2, pageSize: 2 }));

      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.candidates.map((candidate) => candidate.chunkContentHash)).toEqual(["a0", "a1"]);
      expect(secondPage.candidates.map((candidate) => candidate.chunkContentHash)).toEqual(["a2", "a3"]);
      expect(iterated.map((candidate) => candidate.chunkContentHash)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("returns deterministic keyword fallback candidates over chunk text and page metadata", async () => {
    const storage = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", [
        [0, "a0", "alpha hooks overview", [0.1, 0.2]],
        [1, "a1", "component state", [0.3, 0.4]],
      ]);
      upsertFixtureDocset(storage, "beta", "Beta", [[0, "b0", "beta hooks appendix", [0.5, 0.6]]]);

      const alphaOnly = queryKeywordFallbackCandidates(storage, {
        query: "hooks",
        docsetSlugs: ["alpha"],
        limit: 10,
      });
      const metadataMatch = queryKeywordFallbackCandidates(storage, {
        query: "page-1",
        docsetSlugs: [],
        limit: 10,
      });

      expect(alphaOnly.map((candidate) => candidate.docsetSlug)).toEqual(["alpha"]);
      expect(alphaOnly[0]).toMatchObject({
        pagePath: "alpha/page-0",
        chunkText: "alpha hooks overview",
      });
      expect(metadataMatch.map((candidate) => `${candidate.docsetSlug}:${candidate.pagePath}`)).toEqual([
        "alpha:alpha/page-1",
      ]);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });

  test("surfaces DdserveError for corrupt semantic vector rows", async () => {
    const storage = await openTestStorage();

    try {
      upsertFixtureDocset(storage, "alpha", "Alpha", [[0, "a0", "alpha hooks", [0.1, 0.2]]]);

      storage.db
        .prepare("UPDATE embeddings SET vector = $vector WHERE model = $model AND dimensions = $dimensions")
        .run({ vector: new Uint8Array([1, 2, 3]), model: "model-a", dimensions: 2 });

      expect(() =>
        querySemanticSearchCandidatePage(storage, { model: "model-a", dimensions: 2, limit: 1 }),
      ).toThrow(DdserveError);

      storage.db
        .prepare("UPDATE embeddings SET vector = $vector, vector_encoding = $encoding WHERE model = $model")
        .run({ vector: encodeFloat32Vector([0.1, 0.2]), encoding: "json", model: "model-a" });

      expect(() =>
        querySemanticSearchCandidatePage(storage, { model: "model-a", dimensions: 2, limit: 1 }),
      ).toThrow(DdserveError);
    } finally {
      closeEmbeddingStorage(storage);
    }
  });
});

async function openTestStorage(): Promise<EmbeddingStorage> {
  return openEmbeddingStorage(await createTempCacheRoot());
}

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `search-storage-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function upsertFixtureDocset(
  storage: EmbeddingStorage,
  slug: string,
  name: string,
  chunks: Array<[ordinal: number, contentHash: string, text: string, vector: readonly number[]]>,
): void {
  upsertFixtureDocsetForModel(storage, slug, name, "model-a", chunks);
}

function upsertFixtureDocsetForModel(
  storage: EmbeddingStorage,
  slug: string,
  name: string,
  model: string,
  chunks: Array<[ordinal: number, contentHash: string, text: string, vector: readonly number[]]>,
): void {
  upsertChunkEmbeddings(storage, {
    docset: { slug, name },
    model,
    dimensions: chunks[0]?.[3].length ?? 2,
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

function expectFloatVector(values: readonly number[]): number[] {
  return values.map((value) => expect.closeTo(value, 6)) as unknown as number[];
}
