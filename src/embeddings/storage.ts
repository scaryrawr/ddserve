import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";

import { ensureEmbeddingDbPath, resolveCacheRoot } from "../cache";
import { DdserveError } from "../errors";

export const EMBEDDING_DB_SCHEMA_VERSION = 1;
export const DEFAULT_VECTOR_ENCODING = "f32le" as const;

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;
type SqlBindings = Record<string, SqlBinding>;

export interface EmbeddingStorage {
  readonly path: string;
  readonly db: Database;
  close(): void;
}

export interface EmbeddingDocsetInput {
  slug: string;
  name: string;
  source?: string;
  version?: string;
  release?: string;
  mtime?: number;
  dbSize?: number;
  contentFormat?: string;
  installedAt?: string;
  manifestUpdatedAt?: string;
}

export interface EmbeddingPageInput {
  id: string;
  filePath: string;
  path: string;
  title?: string;
  name?: string;
  type?: string;
  contentHash?: string;
}

export interface EmbeddingChunkInput {
  page: EmbeddingPageInput;
  ordinal: number;
  contentHash: string;
  text: string;
  vector: Uint8Array | readonly number[];
  sourceHash?: string;
  tokenCount?: number;
  metadataJson?: string;
}

export interface UpsertChunkEmbeddingsInput {
  docset: EmbeddingDocsetInput;
  model: string;
  dimensions: number;
  chunks: readonly EmbeddingChunkInput[];
  indexedAt?: Date | string;
  vectorEncoding?: string;
}

export interface EmbeddingStatusOptions {
  docsetSlug?: string;
}

export interface EmbeddingDocsetStatus {
  docsetSlug: string;
  docsetName: string;
  model?: string;
  dimensions?: number;
  chunkCount: number;
  embeddedChunkCount: number;
  indexedChunkCount: number;
  indexedAt?: string;
  lastEmbeddedAt?: string;
  docsetUpdatedAt: string;
}

export interface ChunkEmbeddingIdentity {
  docsetSlug: string;
  pageId: string;
  ordinal: number;
  contentHash: string;
  model: string;
  dimensions: number;
}

export interface ChunkEmbeddingModelIdentity {
  docsetSlug: string;
  pageId: string;
  ordinal: number;
  contentHash: string;
  model: string;
}

export type ChunkEmbeddingState = "current" | "stale" | "missing";

export interface CurrentChunkRef {
  pageId: string;
  ordinal: number;
  contentHash: string;
}

export interface DeleteStaleChunksInput {
  docsetSlug: string;
  model: string;
  dimensions?: number;
  currentChunks: readonly CurrentChunkRef[];
  deletedAt?: Date | string;
}

export interface CurrentChunkRefsForModelInput {
  docsetSlug: string;
  model: string;
}

export interface DeleteStaleChunksResult {
  deletedEmbeddings: number;
  deletedChunks: number;
  deletedPages: number;
}

export async function openEmbeddingStorage(cacheRoot = resolveCacheRoot()): Promise<EmbeddingStorage> {
  const path = await ensureEmbeddingDbPath(cacheRoot);
  const db = new Database(path, { create: true, readwrite: true, strict: true });
  initializeEmbeddingStorageSchema(db);

  return {
    path,
    db,
    close() {
      db.close();
    },
  };
}

export function closeEmbeddingStorage(storage: EmbeddingStorage): void {
  storage.close();
}

export function initializeEmbeddingStorageSchema(db: Database, now: Date | string = new Date()): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS docsets (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT,
      version TEXT,
      release TEXT,
      mtime INTEGER,
      db_size INTEGER,
      content_format TEXT,
      installed_at TEXT,
      manifest_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pages (
      docset_slug TEXT NOT NULL,
      page_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      page_title TEXT NOT NULL,
      page_name TEXT NOT NULL,
      page_path TEXT NOT NULL,
      page_type TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (docset_slug, page_id),
      UNIQUE (docset_slug, file_path),
      FOREIGN KEY (docset_slug) REFERENCES docsets(slug) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      docset_slug TEXT NOT NULL,
      page_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      content_hash TEXT NOT NULL,
      source_hash TEXT,
      text TEXT NOT NULL,
      token_count INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (docset_slug, page_id, ordinal, content_hash),
      FOREIGN KEY (docset_slug, page_id) REFERENCES pages(docset_slug, page_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS embedding_models (
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      vector_encoding TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, dimensions)
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_encoding TEXT NOT NULL,
      vector BLOB NOT NULL,
      vector_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chunk_id, model, dimensions),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
      FOREIGN KEY (model, dimensions) REFERENCES embedding_models(model, dimensions) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS embedding_indexes (
      docset_slug TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (docset_slug, model, dimensions),
      FOREIGN KEY (docset_slug) REFERENCES docsets(slug) ON DELETE CASCADE,
      FOREIGN KEY (model, dimensions) REFERENCES embedding_models(model, dimensions) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS chunks_docset_page_ordinal_idx
      ON chunks(docset_slug, page_id, ordinal);
    CREATE INDEX IF NOT EXISTS embeddings_model_idx
      ON embeddings(model, dimensions);
    CREATE INDEX IF NOT EXISTS embedding_indexes_docset_idx
      ON embedding_indexes(docset_slug);
  `);

  const timestamp = isoTimestamp(now);
  const current = db
    .prepare<{ value: string }, [string]>("SELECT value FROM embedding_schema_metadata WHERE key = ?")
    .get("schema_version");

  if (current && Number(current.value) !== EMBEDDING_DB_SCHEMA_VERSION) {
    throw new DdserveError(`Unsupported embedding database schema version: ${current.value}`);
  }

  db.prepare<unknown, SqlBindings>(`
    INSERT INTO embedding_schema_metadata (key, value, updated_at)
    VALUES ($key, $value, $updatedAt)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run({
    key: "schema_version",
    value: String(EMBEDDING_DB_SCHEMA_VERSION),
    updatedAt: timestamp,
  });
}

export function upsertChunkEmbeddings(storage: EmbeddingStorage, input: UpsertChunkEmbeddingsInput): void {
  assertNonEmpty(input.docset.slug, "docset slug");
  assertNonEmpty(input.docset.name, "docset name");
  assertNonEmpty(input.model, "embedding model");
  assertPositiveInteger(input.dimensions, "embedding dimensions");

  const db = storage.db;
  const timestamp = isoTimestamp(input.indexedAt ?? new Date());
  const vectorEncoding = input.vectorEncoding ?? DEFAULT_VECTOR_ENCODING;

  const upsertDocset = db.prepare<unknown, SqlBindings>(`
    INSERT INTO docsets (
      slug, name, source, version, release, mtime, db_size, content_format,
      installed_at, manifest_updated_at, created_at, updated_at
    )
    VALUES (
      $slug, $name, $source, $version, $release, $mtime, $dbSize, $contentFormat,
      $installedAt, $manifestUpdatedAt, $createdAt, $updatedAt
    )
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      source = excluded.source,
      version = excluded.version,
      release = excluded.release,
      mtime = excluded.mtime,
      db_size = excluded.db_size,
      content_format = excluded.content_format,
      installed_at = excluded.installed_at,
      manifest_updated_at = excluded.manifest_updated_at,
      updated_at = excluded.updated_at
  `);
  const upsertPage = db.prepare<unknown, SqlBindings>(`
    INSERT INTO pages (
      docset_slug, page_id, file_path, page_title, page_name, page_path,
      page_type, content_hash, created_at, updated_at
    )
    VALUES (
      $docsetSlug, $pageId, $filePath, $pageTitle, $pageName, $pagePath,
      $pageType, $contentHash, $createdAt, $updatedAt
    )
    ON CONFLICT(docset_slug, page_id) DO UPDATE SET
      file_path = excluded.file_path,
      page_title = excluded.page_title,
      page_name = excluded.page_name,
      page_path = excluded.page_path,
      page_type = excluded.page_type,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);
  const upsertChunk = db.prepare<unknown, SqlBindings>(`
    INSERT INTO chunks (
      docset_slug, page_id, ordinal, content_hash, source_hash, text,
      token_count, metadata_json, created_at, updated_at
    )
    VALUES (
      $docsetSlug, $pageId, $ordinal, $contentHash, $sourceHash, $text,
      $tokenCount, $metadataJson, $createdAt, $updatedAt
    )
    ON CONFLICT(docset_slug, page_id, ordinal, content_hash) DO UPDATE SET
      source_hash = excluded.source_hash,
      text = excluded.text,
      token_count = excluded.token_count,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
  const selectChunkId = db.prepare<{ id: number }, SqlBindings>(`
    SELECT id
    FROM chunks
    WHERE docset_slug = $docsetSlug
      AND page_id = $pageId
      AND ordinal = $ordinal
      AND content_hash = $contentHash
  `);
  const upsertModel = db.prepare<unknown, SqlBindings>(`
    INSERT INTO embedding_models (model, dimensions, vector_encoding, created_at, updated_at)
    VALUES ($model, $dimensions, $vectorEncoding, $createdAt, $updatedAt)
    ON CONFLICT(model, dimensions) DO UPDATE SET
      vector_encoding = excluded.vector_encoding,
      updated_at = excluded.updated_at
  `);
  const upsertEmbedding = db.prepare<unknown, SqlBindings>(`
    INSERT INTO embeddings (
      chunk_id, model, dimensions, vector_encoding, vector, vector_hash, created_at, updated_at
    )
    VALUES (
      $chunkId, $model, $dimensions, $vectorEncoding, $vector, $vectorHash, $createdAt, $updatedAt
    )
    ON CONFLICT(chunk_id, model, dimensions) DO UPDATE SET
      vector_encoding = excluded.vector_encoding,
      vector = excluded.vector,
      vector_hash = excluded.vector_hash,
      updated_at = excluded.updated_at
  `);

  const writeBatch = db.transaction((chunks: readonly EmbeddingChunkInput[]) => {
    upsertDocset.run({
      slug: input.docset.slug,
      name: input.docset.name,
      source: input.docset.source ?? null,
      version: input.docset.version ?? null,
      release: input.docset.release ?? null,
      mtime: input.docset.mtime ?? null,
      dbSize: input.docset.dbSize ?? null,
      contentFormat: input.docset.contentFormat ?? null,
      installedAt: input.docset.installedAt ?? null,
      manifestUpdatedAt: input.docset.manifestUpdatedAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    upsertModel.run({
      model: input.model,
      dimensions: input.dimensions,
      vectorEncoding,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    for (const chunk of chunks) {
      validateChunkInput(chunk, input.dimensions);
      const pageTitle = chunk.page.title ?? chunk.page.name ?? chunk.page.id;
      const pageName = chunk.page.name ?? chunk.page.title ?? chunk.page.id;
      const vector = normalizeVector(chunk.vector, input.dimensions);
      upsertPage.run({
        docsetSlug: input.docset.slug,
        pageId: chunk.page.id,
        filePath: chunk.page.filePath,
        pageTitle,
        pageName,
        pagePath: chunk.page.path,
        pageType: chunk.page.type ?? null,
        contentHash: chunk.page.contentHash ?? chunk.sourceHash ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      upsertChunk.run({
        docsetSlug: input.docset.slug,
        pageId: chunk.page.id,
        ordinal: chunk.ordinal,
        contentHash: chunk.contentHash,
        sourceHash: chunk.sourceHash ?? chunk.page.contentHash ?? null,
        text: chunk.text,
        tokenCount: chunk.tokenCount ?? null,
        metadataJson: chunk.metadataJson ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const row = selectChunkId.get({
        docsetSlug: input.docset.slug,
        pageId: chunk.page.id,
        ordinal: chunk.ordinal,
        contentHash: chunk.contentHash,
      });
      if (!row) {
        throw new DdserveError(`Failed to resolve embedding chunk ${chunk.page.id}#${chunk.ordinal}`);
      }

      upsertEmbedding.run({
        chunkId: row.id,
        model: input.model,
        dimensions: input.dimensions,
        vectorEncoding,
        vector,
        vectorHash: sha256Hex(vector),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    refreshEmbeddingIndex(db, input.docset.slug, input.model, input.dimensions, timestamp);
  });

  writeBatch.immediate(input.chunks);
}

export function queryEmbeddingStatus(
  storage: EmbeddingStorage,
  options: EmbeddingStatusOptions = {},
): EmbeddingDocsetStatus[] {
  const rows = storage.db
    .prepare<
      {
        docsetSlug: string;
        docsetName: string;
        model: string | null;
        dimensions: number | null;
        chunkCount: number;
        embeddedChunkCount: number;
        indexedChunkCount: number | null;
        indexedAt: string | null;
        lastEmbeddedAt: string | null;
        docsetUpdatedAt: string;
      },
      SqlBindings
    >(`
      SELECT
        d.slug AS docsetSlug,
        d.name AS docsetName,
        i.model AS model,
        i.dimensions AS dimensions,
        COUNT(DISTINCT c.id) AS chunkCount,
        COUNT(DISTINCT e.chunk_id) AS embeddedChunkCount,
        i.chunk_count AS indexedChunkCount,
        i.indexed_at AS indexedAt,
        MAX(e.updated_at) AS lastEmbeddedAt,
        d.updated_at AS docsetUpdatedAt
      FROM docsets d
      LEFT JOIN chunks c ON c.docset_slug = d.slug
      LEFT JOIN embedding_indexes i ON i.docset_slug = d.slug
      LEFT JOIN embeddings e
        ON e.chunk_id = c.id
       AND e.model = i.model
       AND e.dimensions = i.dimensions
      WHERE ($docsetSlug IS NULL OR d.slug = $docsetSlug)
      GROUP BY d.slug, d.name, d.updated_at, i.model, i.dimensions, i.chunk_count, i.indexed_at
      ORDER BY d.slug, i.model, i.dimensions
    `)
    .all({ docsetSlug: options.docsetSlug ?? null });

  return rows.map((row) => ({
    docsetSlug: row.docsetSlug,
    docsetName: row.docsetName,
    model: row.model ?? undefined,
    dimensions: row.dimensions ?? undefined,
    chunkCount: row.chunkCount,
    embeddedChunkCount: row.embeddedChunkCount,
    indexedChunkCount: row.indexedChunkCount ?? 0,
    indexedAt: row.indexedAt ?? undefined,
    lastEmbeddedAt: row.lastEmbeddedAt ?? undefined,
    docsetUpdatedAt: row.docsetUpdatedAt,
  }));
}

export function getChunkEmbeddingState(storage: EmbeddingStorage, identity: ChunkEmbeddingIdentity): ChunkEmbeddingState {
  const rows = storage.db
    .prepare<{ contentHash: string }, SqlBindings>(`
      SELECT c.content_hash AS contentHash
      FROM chunks c
      JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.docset_slug = $docsetSlug
        AND c.page_id = $pageId
        AND c.ordinal = $ordinal
        AND e.model = $model
        AND e.dimensions = $dimensions
      ORDER BY e.updated_at DESC
    `)
    .all({
      docsetSlug: identity.docsetSlug,
      pageId: identity.pageId,
      ordinal: identity.ordinal,
      model: identity.model,
      dimensions: identity.dimensions,
    });

  if (rows.some((row) => row.contentHash === identity.contentHash)) {
    return "current";
  }
  return rows.length > 0 ? "stale" : "missing";
}

export function isChunkEmbeddingCurrent(storage: EmbeddingStorage, identity: ChunkEmbeddingIdentity): boolean {
  return getChunkEmbeddingState(storage, identity) === "current";
}

export function getChunkEmbeddingStateForModel(
  storage: EmbeddingStorage,
  identity: ChunkEmbeddingModelIdentity,
): ChunkEmbeddingState {
  const rows = storage.db
    .prepare<{ contentHash: string }, SqlBindings>(`
      SELECT c.content_hash AS contentHash
      FROM chunks c
      JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.docset_slug = $docsetSlug
        AND c.page_id = $pageId
        AND c.ordinal = $ordinal
        AND e.model = $model
      ORDER BY e.updated_at DESC
    `)
    .all({
      docsetSlug: identity.docsetSlug,
      pageId: identity.pageId,
      ordinal: identity.ordinal,
      model: identity.model,
    });

  if (rows.some((row) => row.contentHash === identity.contentHash)) {
    return "current";
  }
  return rows.length > 0 ? "stale" : "missing";
}

export function isChunkEmbeddingCurrentForModel(storage: EmbeddingStorage, identity: ChunkEmbeddingModelIdentity): boolean {
  return getChunkEmbeddingStateForModel(storage, identity) === "current";
}

export function queryCurrentChunkRefsForDocsetModel(
  storage: EmbeddingStorage,
  input: CurrentChunkRefsForModelInput,
): CurrentChunkRef[] {
  assertNonEmpty(input.docsetSlug, "docset slug");
  assertNonEmpty(input.model, "embedding model");

  const rows = storage.db
    .prepare<{ pageId: string; ordinal: number; contentHash: string }, SqlBindings>(`
      SELECT DISTINCT
        c.page_id AS pageId,
        c.ordinal AS ordinal,
        c.content_hash AS contentHash
      FROM chunks c
      JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.docset_slug = $docsetSlug
        AND e.model = $model
    `)
    .all({
      docsetSlug: input.docsetSlug,
      model: input.model,
    });

  return rows;
}

export function deleteStaleChunksForDocsetModel(
  storage: EmbeddingStorage,
  input: DeleteStaleChunksInput,
): DeleteStaleChunksResult {
  assertNonEmpty(input.docsetSlug, "docset slug");
  assertNonEmpty(input.model, "embedding model");
  const timestamp = isoTimestamp(input.deletedAt ?? new Date());
  const current = new Set(input.currentChunks.map(chunkRefKey));
  const db = storage.db;

  const selectEmbeddedChunks = db.prepare<
    { chunkId: number; pageId: string; ordinal: number; contentHash: string; dimensions: number },
    SqlBindings
  >(`
    SELECT
      c.id AS chunkId,
      c.page_id AS pageId,
      c.ordinal AS ordinal,
      c.content_hash AS contentHash,
      e.dimensions AS dimensions
    FROM chunks c
    JOIN embeddings e ON e.chunk_id = c.id
    WHERE c.docset_slug = $docsetSlug
      AND e.model = $model
      AND ($dimensions IS NULL OR e.dimensions = $dimensions)
  `);
  const deleteEmbedding = db.prepare<unknown, SqlBindings>(`
    DELETE FROM embeddings
    WHERE chunk_id = $chunkId
      AND model = $model
      AND ($dimensions IS NULL OR dimensions = $dimensions)
  `);
  const deleteOrphanChunks = db.prepare<unknown, SqlBindings>(`
    DELETE FROM chunks
    WHERE docset_slug = $docsetSlug
      AND NOT EXISTS (
        SELECT 1
        FROM embeddings e
        WHERE e.chunk_id = chunks.id
      )
  `);
  const deleteOrphanPages = db.prepare<unknown, SqlBindings>(`
    DELETE FROM pages
    WHERE docset_slug = $docsetSlug
      AND NOT EXISTS (
        SELECT 1
        FROM chunks c
        WHERE c.docset_slug = pages.docset_slug
          AND c.page_id = pages.page_id
      )
  `);
  const selectIndexDimensions = db.prepare<{ dimensions: number }, SqlBindings>(`
    SELECT dimensions
    FROM embedding_indexes
    WHERE docset_slug = $docsetSlug
      AND model = $model
      AND ($dimensions IS NULL OR dimensions = $dimensions)
  `);

  const removeStale = db.transaction(() => {
    let deletedEmbeddings = 0;
    for (const row of selectEmbeddedChunks.all({
      docsetSlug: input.docsetSlug,
      model: input.model,
      dimensions: input.dimensions ?? null,
    })) {
      if (current.has(chunkRefKey(row))) {
        continue;
      }
      deletedEmbeddings += deleteEmbedding.run({
        chunkId: row.chunkId,
        model: input.model,
        dimensions: input.dimensions ?? row.dimensions,
      }).changes;
    }

    const deletedChunks = deleteOrphanChunks.run({ docsetSlug: input.docsetSlug }).changes;
    const deletedPages = deleteOrphanPages.run({ docsetSlug: input.docsetSlug }).changes;
    for (const row of selectIndexDimensions.all({
      docsetSlug: input.docsetSlug,
      model: input.model,
      dimensions: input.dimensions ?? null,
    })) {
      refreshEmbeddingIndex(db, input.docsetSlug, input.model, row.dimensions, timestamp);
    }

    return { deletedEmbeddings, deletedChunks, deletedPages };
  });

  return removeStale.immediate();
}

export function encodeFloat32Vector(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function normalizeVector(vector: Uint8Array | readonly number[], dimensions: number): Uint8Array {
  if (vector instanceof Uint8Array) {
    if (vector.byteLength !== dimensions * 4) {
      throw new DdserveError(`Embedding vector byte length ${vector.byteLength} does not match ${dimensions} dimensions`);
    }
    return vector;
  }
  if (vector.length !== dimensions) {
    throw new DdserveError(`Embedding vector length ${vector.length} does not match ${dimensions} dimensions`);
  }
  return encodeFloat32Vector(vector);
}

function refreshEmbeddingIndex(
  db: Database,
  docsetSlug: string,
  model: string,
  dimensions: number,
  timestamp: string,
): void {
  const row = db
    .prepare<{ count: number }, SqlBindings>(`
      SELECT COUNT(*) AS count
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      WHERE c.docset_slug = $docsetSlug
        AND e.model = $model
        AND e.dimensions = $dimensions
    `)
    .get({ docsetSlug, model, dimensions });
  const chunkCount = row?.count ?? 0;

  db.prepare<unknown, SqlBindings>(`
    INSERT INTO embedding_indexes (docset_slug, model, dimensions, chunk_count, indexed_at, updated_at)
    VALUES ($docsetSlug, $model, $dimensions, $chunkCount, $indexedAt, $updatedAt)
    ON CONFLICT(docset_slug, model, dimensions) DO UPDATE SET
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at,
      updated_at = excluded.updated_at
  `).run({
    docsetSlug,
    model,
    dimensions,
    chunkCount,
    indexedAt: timestamp,
    updatedAt: timestamp,
  });
}

function validateChunkInput(chunk: EmbeddingChunkInput, dimensions: number): void {
  assertNonEmpty(chunk.page.id, "page id");
  assertNonEmpty(chunk.page.filePath, "page file path");
  assertNonEmpty(chunk.page.path, "page path");
  assertNonEmpty(chunk.contentHash, "chunk content hash");
  assertPositiveInteger(chunk.ordinal + 1, "chunk ordinal");
  normalizeVector(chunk.vector, dimensions);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DdserveError(`Invalid ${label}: value must not be empty`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DdserveError(`Invalid ${label}: expected a positive integer`);
  }
}

function chunkRefKey(chunk: CurrentChunkRef): string {
  return `${chunk.pageId}\u0000${chunk.ordinal}\u0000${chunk.contentHash}`;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
