import { cachePaths, pathExists, readCacheManifest, readDocsetManifest } from "../cache";
import type { DdserveConfig } from "../config";
import { DdserveError } from "../errors";
import type { CacheManifestDocset, DocsetManifest } from "../types";
import { chunkMarkdownPages, type PreparedEmbeddingChunk } from "./chunks";
import { createOpenAiEmbeddingClient, type EmbeddingClient, type EmbeddingVector } from "./openai";
import {
  closeEmbeddingStorage,
  deleteStaleChunksForDocsetModel,
  getChunkEmbeddingStateForModel,
  chunkRefKey,
  openEmbeddingStorage,
  queryCurrentChunkRefsForDocsetModel,
  queryEmbeddingStatus,
  upsertChunkEmbeddings,
  type EmbeddingChunkInput,
  type EmbeddingStorage,
} from "./storage";

export interface RefreshDocsetEmbeddingsOptions {
  cacheRoot: string;
  manifest: DocsetManifest;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  client?: EmbeddingClient;
  storage?: EmbeddingStorage;
  now?: Date;
  force?: boolean;
}

export interface RefreshDocsetEmbeddingsResult {
  slug: string;
  model: string;
  status: "refreshed" | "skipped";
  chunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  dimensions?: number;
}

export async function refreshDocsetEmbeddings(
  options: RefreshDocsetEmbeddingsOptions,
): Promise<RefreshDocsetEmbeddingsResult | undefined> {
  const openai = options.config.openai;
  if (!options.config.embeddings.enabled || !openai) {
    return undefined;
  }

  const prepared = await chunkMarkdownPages(options.manifest, {
    cacheRoot: options.cacheRoot,
    slug: options.manifest.slug,
    ...chunkOptionsFromConfig(options.config),
  });
  const storage = options.storage ?? (await openEmbeddingStorage(options.cacheRoot));
  const shouldCloseStorage = !options.storage;

  try {
    const model = openai.embeddingModel;
    const chunksToEmbed = options.force
      ? prepared.chunks
      : chunksMissingCurrentEmbeddings(storage, {
          chunks: prepared.chunks,
          docsetSlug: options.manifest.slug,
          model,
        });

    if (chunksToEmbed.length === 0) {
      deleteStaleChunksForDocsetModel(storage, {
        docsetSlug: options.manifest.slug,
        model,
        currentChunks: prepared.chunks.map(currentChunkRef),
        deletedAt: options.now,
      });
      return {
        slug: options.manifest.slug,
        model,
        status: "skipped",
        chunks: prepared.chunks.length,
        embeddedChunks: 0,
        skippedChunks: prepared.chunks.length,
      };
    }

    const client = options.client ?? createOpenAiEmbeddingClient(options.config, { env: options.env });
    const batchSize = options.config.embeddings.batchSize;
    let dimensions: number | undefined;
    let embeddedChunks = 0;

    for (let offset = 0; offset < chunksToEmbed.length; offset += batchSize) {
      const batch = chunksToEmbed.slice(offset, offset + batchSize);
      const vectors = await client.createEmbeddings(batch.map((chunk) => chunk.text));
      dimensions = dimensionsForBatch(vectors, batch.length, dimensions);
      upsertChunkEmbeddings(storage, {
        docset: prepared.docset,
        model,
        dimensions,
        chunks: batch.map((chunk, index) => chunkWithVector(chunk, vectors[index]!)),
        indexedAt: options.now,
      });
      embeddedChunks += batch.length;
    }

    deleteStaleChunksForDocsetModel(storage, {
      docsetSlug: options.manifest.slug,
      model,
      currentChunks: prepared.chunks.map(currentChunkRef),
      deletedAt: options.now,
    });

    return {
      slug: options.manifest.slug,
      model,
      status: "refreshed",
      chunks: prepared.chunks.length,
      embeddedChunks,
      skippedChunks: prepared.chunks.length - embeddedChunks,
      dimensions,
    };
  } finally {
    if (shouldCloseStorage) {
      closeEmbeddingStorage(storage);
    }
  }
}

export interface EmbeddingsStatusOptions {
  cacheRoot: string;
  config: DdserveConfig;
  slug?: string;
  includeCurrent?: boolean;
  createDatabase?: boolean;
}

export interface EmbeddingsIndexedCounts {
  docsets: number;
  pages: number;
  chunks: number;
}

export interface EmbeddingsInstalledCounts {
  docsets: number;
  pages: number;
}

export interface EmbeddingsCurrentCounts {
  currentChunks: number;
  staleChunks: number;
  missingChunks: number;
  chunks: number;
}

export interface EmbeddingsDocsetStatus {
  slug: string;
  name: string;
  pages: number;
  indexedPages: number;
  indexedChunks: number;
  model?: string;
  dimensions?: number;
  indexedAt?: string;
  lastEmbeddedAt?: string;
  currentChunks?: number;
  staleChunks?: number;
  missingChunks?: number;
  chunks?: number;
}

export interface EmbeddingsStatusResult {
  databasePath: string;
  enabled: boolean;
  configured: boolean;
  model?: string;
  installed: EmbeddingsInstalledCounts;
  indexed: EmbeddingsIndexedCounts;
  currentChunks?: number;
  staleChunks?: number;
  missingChunks?: number;
  docsets: EmbeddingsDocsetStatus[];
}

export interface RebuildEmbeddingsOptions {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  client?: EmbeddingClient;
  slug?: string;
  now?: Date;
  onProgress?: (event: RebuildEmbeddingsProgressEvent) => void;
}

export interface RefreshEmbeddingsOptions extends RebuildEmbeddingsOptions {}

type InstalledEmbeddingsAction = "rebuilding" | "refreshing";

export interface RebuildEmbeddingsProgressEvent {
  slug: string;
  index: number;
  total: number;
  phase: "start" | "done";
  result?: RefreshDocsetEmbeddingsResult;
}

export async function getEmbeddingsStatus(options: EmbeddingsStatusOptions): Promise<EmbeddingsStatusResult> {
  const paths = cachePaths(options.cacheRoot);
  const cacheManifest = await readCacheManifest(options.cacheRoot);
  const installed = selectInstalledDocsets(cacheManifest.docs, options.slug);
  const model = options.config.openai?.embeddingModel;
  const includeCurrent = options.includeCurrent ?? true;
  if (options.createDatabase === false && !(await pathExists(paths.embeddingsDb))) {
    return unindexedEmbeddingsStatus({
      databasePath: paths.embeddingsDb,
      cacheRoot: options.cacheRoot,
      installed,
      config: options.config,
      model,
      includeCurrent,
    });
  }
  const storage = await openEmbeddingStorage(options.cacheRoot);

  try {
    const indexed = queryIndexedCounts(storage, options.slug, model);
    const dbStatuses = queryEmbeddingStatus(storage, options.slug ? { docsetSlug: options.slug } : {});
    const dbStatusBySlug = new Map(
      dbStatuses
        .filter((status) => (model ? status.model === model : true))
        .map((status) => [status.docsetSlug, status]),
    );
    const indexedBySlug = queryIndexedCountsByDocset(storage, options.slug, model);
    const docsets: EmbeddingsDocsetStatus[] = [];
    let currentTotals: EmbeddingsCurrentCounts | undefined;

    for (const docset of installed) {
      const dbStatus = dbStatusBySlug.get(docset.slug);
      const indexedCounts = indexedBySlug.get(docset.slug) ?? { pages: 0, chunks: 0 };
      const currentCounts = includeCurrent && model
        ? await countCurrentChunkStates(options.cacheRoot, docset.slug, model, storage, options.config)
        : undefined;
      currentTotals = addCurrentCounts(currentTotals, currentCounts);
      docsets.push({
        slug: docset.slug,
        name: docset.name,
        pages: docset.pageCount,
        indexedPages: indexedCounts.pages,
        indexedChunks: indexedCounts.chunks,
        model: dbStatus?.model ?? model,
        dimensions: dbStatus?.dimensions,
        indexedAt: dbStatus?.indexedAt,
        lastEmbeddedAt: dbStatus?.lastEmbeddedAt,
        currentChunks: currentCounts?.currentChunks,
        staleChunks: currentCounts?.staleChunks,
        missingChunks: currentCounts?.missingChunks,
        chunks: currentCounts?.chunks,
      });
    }

    return {
      databasePath: paths.embeddingsDb,
      enabled: options.config.embeddings.enabled,
      configured: options.config.openai !== undefined,
      model,
      installed: {
        docsets: installed.length,
        pages: installed.reduce((total, docset) => total + docset.pageCount, 0),
      },
      indexed,
      currentChunks: currentTotals?.currentChunks,
      staleChunks: currentTotals?.staleChunks,
      missingChunks: currentTotals?.missingChunks,
      docsets,
    };
  } finally {
    closeEmbeddingStorage(storage);
  }
}

async function unindexedEmbeddingsStatus(options: {
  databasePath: string;
  cacheRoot: string;
  installed: CacheManifestDocset[];
  config: DdserveConfig;
  model?: string;
  includeCurrent: boolean;
}): Promise<EmbeddingsStatusResult> {
  const docsets: EmbeddingsDocsetStatus[] = [];
  let currentTotals: EmbeddingsCurrentCounts | undefined;

  for (const docset of options.installed) {
    const currentCounts = options.includeCurrent && options.model
      ? await countMissingChunksWithoutStorage(options.cacheRoot, docset.slug, options.config)
      : undefined;
    currentTotals = addCurrentCounts(currentTotals, currentCounts);
    docsets.push({
      slug: docset.slug,
      name: docset.name,
      pages: docset.pageCount,
      indexedPages: 0,
      indexedChunks: 0,
      model: options.model,
      currentChunks: currentCounts?.currentChunks,
      staleChunks: currentCounts?.staleChunks,
      missingChunks: currentCounts?.missingChunks,
      chunks: currentCounts?.chunks,
    });
  }

  return {
    databasePath: options.databasePath,
    enabled: options.config.embeddings.enabled,
    configured: options.config.openai !== undefined,
    model: options.model,
    installed: {
      docsets: options.installed.length,
      pages: options.installed.reduce((total, docset) => total + docset.pageCount, 0),
    },
    indexed: {
      docsets: 0,
      pages: 0,
      chunks: 0,
    },
    currentChunks: currentTotals?.currentChunks,
    staleChunks: currentTotals?.staleChunks,
    missingChunks: currentTotals?.missingChunks,
    docsets,
  };
}

async function countMissingChunksWithoutStorage(
  cacheRoot: string,
  slug: string,
  config: DdserveConfig,
): Promise<EmbeddingsCurrentCounts> {
  const manifest = await readDocsetManifest(cacheRoot, slug);
  if (!manifest) {
    return {
      currentChunks: 0,
      staleChunks: 0,
      missingChunks: 0,
      chunks: 0,
    };
  }

  const prepared = await chunkMarkdownPages(manifest, { cacheRoot, slug, ...chunkOptionsFromConfig(config) });
  return {
    currentChunks: 0,
    staleChunks: 0,
    missingChunks: prepared.chunks.length,
    chunks: prepared.chunks.length,
  };
}

export async function rebuildEmbeddings(options: RebuildEmbeddingsOptions): Promise<RefreshDocsetEmbeddingsResult[]> {
  return processConfiguredInstalledEmbeddings(options, true, "rebuilding");
}

export async function refreshEmbeddings(options: RefreshEmbeddingsOptions): Promise<RefreshDocsetEmbeddingsResult[]> {
  return processConfiguredInstalledEmbeddings(options, false, "refreshing");
}

async function processConfiguredInstalledEmbeddings(
  options: RebuildEmbeddingsOptions,
  force: boolean,
  action: InstalledEmbeddingsAction,
): Promise<RefreshDocsetEmbeddingsResult[]> {
  if (!options.config.embeddings.enabled) {
    throw new DdserveError(`Embeddings are disabled. Enable embeddings in config before ${action}.`);
  }
  if (!options.config.openai) {
    throw new DdserveError("OpenAI embeddings are not configured");
  }

  return processInstalledEmbeddings(options, force, action);
}

async function processInstalledEmbeddings(
  options: RebuildEmbeddingsOptions,
  force: boolean,
  action: InstalledEmbeddingsAction,
): Promise<RefreshDocsetEmbeddingsResult[]> {
  const cacheManifest = await readCacheManifest(options.cacheRoot);
  const installed = selectInstalledDocsets(cacheManifest.docs, options.slug);
  if (installed.length === 0) {
    return [];
  }

  const client = options.client ?? createOpenAiEmbeddingClient(options.config, { env: options.env });
  const storage = await openEmbeddingStorage(options.cacheRoot);

  try {
    const results: RefreshDocsetEmbeddingsResult[] = [];
    for (const [index, docset] of installed.entries()) {
      const progress = { slug: docset.slug, index: index + 1, total: installed.length };
      options.onProgress?.({ ...progress, phase: "start" });
      const manifest = await readDocsetManifest(options.cacheRoot, docset.slug);
      if (!manifest) {
        throw new DdserveError(`Docset "${docset.slug}" is missing its manifest. Reinstall it before ${action} embeddings.`);
      }
      const result = await refreshDocsetEmbeddings({
        cacheRoot: options.cacheRoot,
        manifest,
        config: options.config,
        env: options.env,
        client,
        storage,
        now: options.now,
        force,
      });
      if (!result) {
        throw new DdserveError(`Embeddings are not configured for docset "${docset.slug}"`);
      }
      options.onProgress?.({ ...progress, phase: "done", result });
      results.push(result);
    }
    return results;
  } finally {
    closeEmbeddingStorage(storage);
  }
}

function chunksMissingCurrentEmbeddings(
  storage: EmbeddingStorage,
  input: {
    chunks: readonly PreparedEmbeddingChunk[];
    docsetSlug: string;
    model: string;
  },
): PreparedEmbeddingChunk[] {
  const current = new Set(
    queryCurrentChunkRefsForDocsetModel(storage, {
      docsetSlug: input.docsetSlug,
      model: input.model,
    }).map(chunkRefKey),
  );

  return input.chunks.filter((chunk) => !current.has(chunkRefKey(currentChunkRef(chunk))));
}

function dimensionsForBatch(
  vectors: readonly EmbeddingVector[],
  expectedCount: number,
  previousDimensions: number | undefined,
): number {
  if (vectors.length !== expectedCount) {
    throw new DdserveError(`Embedding client returned ${vectors.length} vectors for ${expectedCount} chunks`);
  }

  let dimensions = previousDimensions;
  for (const vector of vectors) {
    if (vector.length === 0) {
      throw new DdserveError("Embedding client returned an empty vector");
    }
    dimensions = dimensions ?? vector.length;
    if (vector.length !== dimensions) {
      throw new DdserveError(`Embedding vector dimensions mismatch: expected ${dimensions}, received ${vector.length}`);
    }
  }

  if (dimensions === undefined) {
    throw new DdserveError("Embedding client returned no vectors");
  }
  return dimensions;
}

function chunkWithVector(chunk: PreparedEmbeddingChunk, vector: EmbeddingVector): EmbeddingChunkInput {
  return {
    ...chunk,
    vector,
  };
}

function currentChunkRef(chunk: PreparedEmbeddingChunk) {
  return {
    pageId: chunk.page.id,
    ordinal: chunk.ordinal,
    contentHash: chunk.contentHash,
  };
}

function selectInstalledDocsets(
  docsets: Record<string, CacheManifestDocset>,
  slug: string | undefined,
): CacheManifestDocset[] {
  if (slug) {
    const docset = docsets[slug];
    if (!docset) {
      throw new DdserveError(`Docset "${slug}" is not installed.`);
    }
    return [docset];
  }
  return Object.values(docsets).sort((left, right) => left.slug.localeCompare(right.slug));
}

function queryIndexedCounts(storage: EmbeddingStorage, docsetSlug: string | undefined, model: string | undefined) {
  const row = storage.db
    .prepare<{ docsets: number; pages: number; chunks: number }, Record<string, string | null>>(`
      SELECT
        COUNT(DISTINCT c.docset_slug) AS docsets,
        COUNT(DISTINCT c.docset_slug || char(0) || c.page_id) AS pages,
        COUNT(DISTINCT e.chunk_id) AS chunks
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      WHERE ($docsetSlug IS NULL OR c.docset_slug = $docsetSlug)
        AND ($model IS NULL OR e.model = $model)
    `)
    .get({ docsetSlug: docsetSlug ?? null, model: model ?? null });

  return {
    docsets: row?.docsets ?? 0,
    pages: row?.pages ?? 0,
    chunks: row?.chunks ?? 0,
  };
}

function queryIndexedCountsByDocset(
  storage: EmbeddingStorage,
  docsetSlug: string | undefined,
  model: string | undefined,
): Map<string, { pages: number; chunks: number }> {
  const rows = storage.db
    .prepare<{ slug: string; pages: number; chunks: number }, Record<string, string | null>>(`
      SELECT
        c.docset_slug AS slug,
        COUNT(DISTINCT c.page_id) AS pages,
        COUNT(DISTINCT e.chunk_id) AS chunks
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      WHERE ($docsetSlug IS NULL OR c.docset_slug = $docsetSlug)
        AND ($model IS NULL OR e.model = $model)
      GROUP BY c.docset_slug
    `)
    .all({ docsetSlug: docsetSlug ?? null, model: model ?? null });

  return new Map(rows.map((row) => [row.slug, { pages: row.pages, chunks: row.chunks }]));
}

async function countCurrentChunkStates(
  cacheRoot: string,
  slug: string,
  model: string,
  storage: EmbeddingStorage,
  config: DdserveConfig,
): Promise<EmbeddingsCurrentCounts> {
  const manifest = await readDocsetManifest(cacheRoot, slug);
  if (!manifest) {
    throw new DdserveError(`Docset "${slug}" is missing its manifest. Reinstall it before inspecting embeddings.`);
  }

  const prepared = await chunkMarkdownPages(manifest, { cacheRoot, slug, ...chunkOptionsFromConfig(config) });
  const counts: EmbeddingsCurrentCounts = {
    currentChunks: 0,
    staleChunks: 0,
    missingChunks: 0,
    chunks: prepared.chunks.length,
  };

  for (const chunk of prepared.chunks) {
    const state = getChunkEmbeddingStateForModel(storage, {
      docsetSlug: slug,
      pageId: chunk.page.id,
      ordinal: chunk.ordinal,
      contentHash: chunk.contentHash,
      model,
    });
    if (state === "current") {
      counts.currentChunks += 1;
    } else if (state === "stale") {
      counts.staleChunks += 1;
    } else {
      counts.missingChunks += 1;
    }
  }

  return counts;
}

function chunkOptionsFromConfig(config: DdserveConfig) {
  return {
    maxChunkChars: config.embeddings.maxChunkChars,
    overlapChars: config.embeddings.overlapChars,
  };
}

function addCurrentCounts(
  total: EmbeddingsCurrentCounts | undefined,
  current: EmbeddingsCurrentCounts | undefined,
): EmbeddingsCurrentCounts | undefined {
  if (!current) {
    return total;
  }
  if (!total) {
    return { ...current };
  }
  return {
    currentChunks: total.currentChunks + current.currentChunks,
    staleChunks: total.staleChunks + current.staleChunks,
    missingChunks: total.missingChunks + current.missingChunks,
    chunks: total.chunks + current.chunks,
  };
}
