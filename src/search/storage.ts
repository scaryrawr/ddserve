import { DEFAULT_VECTOR_ENCODING, type EmbeddingStorage } from "../embeddings/storage";
import { DdserveError } from "../errors";

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;
type SqlBindings = Record<string, SqlBinding>;

const DEFAULT_SEMANTIC_PAGE_SIZE = 500;
const DEFAULT_KEYWORD_LIMIT = 10;

export interface SearchCandidateScope {
  model: string;
  dimensions: number;
  docsetSlugs?: readonly string[];
}

export interface SemanticSearchCandidatePageOptions extends SearchCandidateScope {
  afterChunkId?: number;
  limit?: number;
}

export interface SemanticSearchCandidateIterationOptions extends SearchCandidateScope {
  afterChunkId?: number;
  pageSize?: number;
}

export interface SemanticSearchCandidatePage {
  candidates: SemanticSearchCandidate[];
  nextAfterChunkId?: number;
  hasMore: boolean;
}

export interface SearchCandidateBase {
  docsetSlug: string;
  docsetName: string;
  pageId: string;
  pageName: string;
  pagePath: string;
  pageType?: string;
  pageFilePath: string;
  chunkId: number;
  chunkOrdinal: number;
  chunkText: string;
  chunkContentHash: string;
}

export interface SemanticSearchCandidate extends SearchCandidateBase {
  model: string;
  dimensions: number;
  vector: Float32Array;
}

export interface KeywordSearchCandidate extends SearchCandidateBase {}

export interface KeywordFallbackCandidateOptions {
  query: string;
  docsetSlugs?: readonly string[];
  limit?: number;
}

interface SemanticCandidateRow extends Omit<SearchCandidateBase, "pageType"> {
  pageType: string | null;
  model: string;
  dimensions: number;
  vectorEncoding: string;
  vector: Uint8Array;
}

interface KeywordCandidateRow extends Omit<SearchCandidateBase, "pageType"> {
  pageType: string | null;
}

export function querySemanticSearchCandidatePage(
  storage: EmbeddingStorage,
  options: SemanticSearchCandidatePageOptions,
): SemanticSearchCandidatePage {
  assertNonEmpty(options.model, "embedding model");
  assertPositiveInteger(options.dimensions, "embedding dimensions");
  const afterChunkId = options.afterChunkId ?? 0;
  assertNonNegativeInteger(afterChunkId, "after chunk id");
  const limit = normalizeLimit(options.limit, DEFAULT_SEMANTIC_PAGE_SIZE, "candidate page limit");
  const scope = buildDocsetScope(options.docsetSlugs, "c");
  const sqlLimit = limit + 1;

  const rows = storage.db
    .prepare<SemanticCandidateRow, SqlBindings>(`
      SELECT
        d.slug AS docsetSlug,
        d.name AS docsetName,
        p.page_id AS pageId,
        p.page_name AS pageName,
        p.page_path AS pagePath,
        p.page_type AS pageType,
        p.file_path AS pageFilePath,
        c.id AS chunkId,
        c.ordinal AS chunkOrdinal,
        c.text AS chunkText,
        c.content_hash AS chunkContentHash,
        e.model AS model,
        e.dimensions AS dimensions,
        e.vector_encoding AS vectorEncoding,
        e.vector AS vector
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN pages p ON p.docset_slug = c.docset_slug AND p.page_id = c.page_id
      JOIN docsets d ON d.slug = c.docset_slug
      WHERE e.model = $model
        AND e.dimensions = $dimensions
        AND c.id > $afterChunkId
        ${scope.sql}
      ORDER BY c.id ASC
      LIMIT $limit
    `)
    .all({
      model: options.model,
      dimensions: options.dimensions,
      afterChunkId,
      limit: sqlLimit,
      ...scope.bindings,
    });

  const pageRows = rows.slice(0, limit);
  const candidates = pageRows.map(mapSemanticCandidateRow);
  const nextAfterChunkId =
    rows.length > limit && candidates.length > 0 ? candidates[candidates.length - 1]?.chunkId : undefined;

  return {
    candidates,
    nextAfterChunkId,
    hasMore: nextAfterChunkId !== undefined,
  };
}

export function* iterateSemanticSearchCandidates(
  storage: EmbeddingStorage,
  options: SemanticSearchCandidateIterationOptions,
): IterableIterator<SemanticSearchCandidate> {
  const { pageSize, ...scope } = options;
  let afterChunkId = options.afterChunkId ?? 0;
  const limit = normalizeLimit(pageSize, DEFAULT_SEMANTIC_PAGE_SIZE, "candidate page size");

  while (true) {
    const page = querySemanticSearchCandidatePage(storage, { ...scope, afterChunkId, limit });
    for (const candidate of page.candidates) {
      yield candidate;
    }
    if (!page.nextAfterChunkId) {
      return;
    }
    afterChunkId = page.nextAfterChunkId;
  }
}

export function queryKeywordFallbackCandidates(
  storage: EmbeddingStorage,
  options: KeywordFallbackCandidateOptions,
): KeywordSearchCandidate[] {
  const terms = parseKeywordTerms(options.query);
  if (terms.length === 0) {
    return [];
  }

  const limit = normalizeLimit(options.limit, DEFAULT_KEYWORD_LIMIT, "keyword candidate limit");
  const scope = buildDocsetScope(options.docsetSlugs, "c");
  const searchText = `
    lower(
      c.text || ' ' ||
      p.page_title || ' ' ||
      p.page_name || ' ' ||
      p.page_path || ' ' ||
      p.file_path || ' ' ||
      COALESCE(p.page_type, '') || ' ' ||
      d.slug || ' ' ||
      d.name
    )
  `;
  const termConditions = terms.map((_, index) => `${searchText} LIKE $term${index} ESCAPE '\\'`).join(" OR ");
  const termBindings = Object.fromEntries(terms.map((term, index) => [`term${index}`, `%${escapeLikeTerm(term)}%`]));

  const rows = storage.db
    .prepare<KeywordCandidateRow, SqlBindings>(`
      SELECT
        d.slug AS docsetSlug,
        d.name AS docsetName,
        p.page_id AS pageId,
        p.page_name AS pageName,
        p.page_path AS pagePath,
        p.page_type AS pageType,
        p.file_path AS pageFilePath,
        c.id AS chunkId,
        c.ordinal AS chunkOrdinal,
        c.text AS chunkText,
        c.content_hash AS chunkContentHash
      FROM chunks c
      JOIN pages p ON p.docset_slug = c.docset_slug AND p.page_id = c.page_id
      JOIN docsets d ON d.slug = c.docset_slug
      WHERE (${termConditions})
        ${scope.sql}
      ORDER BY d.slug ASC, p.page_path ASC, c.ordinal ASC, c.id ASC
      LIMIT $limit
    `)
    .all({
      limit,
      ...termBindings,
      ...scope.bindings,
    });

  return rows.map(mapKeywordCandidateRow);
}

export function decodeFloat32VectorBlob(
  blob: Uint8Array,
  dimensions: number,
  vectorEncoding: string = DEFAULT_VECTOR_ENCODING,
): Float32Array {
  if (vectorEncoding !== DEFAULT_VECTOR_ENCODING) {
    throw new DdserveError(`Unsupported embedding vector encoding "${vectorEncoding}"`);
  }
  assertPositiveInteger(dimensions, "embedding dimensions");

  const bytes = toUint8Array(blob);
  const expectedByteLength = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedByteLength) {
    throw new DdserveError(
      `Embedding vector byte length ${bytes.byteLength} does not match ${dimensions} dimensions`,
    );
  }

  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const value = dataView.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) {
      throw new DdserveError(`Embedding vector contained a non-finite value at dimension ${index}`);
    }
    vector[index] = value;
  }
  return vector;
}

function mapSemanticCandidateRow(row: SemanticCandidateRow): SemanticSearchCandidate {
  return {
    ...mapKeywordCandidateRow(row),
    model: row.model,
    dimensions: row.dimensions,
    vector: decodeFloat32VectorBlob(row.vector, row.dimensions, row.vectorEncoding),
  };
}

function mapKeywordCandidateRow(row: KeywordCandidateRow): KeywordSearchCandidate {
  return {
    docsetSlug: row.docsetSlug,
    docsetName: row.docsetName,
    pageId: row.pageId,
    pageName: row.pageName,
    pagePath: row.pagePath,
    pageType: row.pageType ?? undefined,
    pageFilePath: row.pageFilePath,
    chunkId: row.chunkId,
    chunkOrdinal: row.chunkOrdinal,
    chunkText: row.chunkText,
    chunkContentHash: row.chunkContentHash,
  };
}

function buildDocsetScope(docsetSlugs: readonly string[] | undefined, tableAlias: string): {
  sql: string;
  bindings: SqlBindings;
} {
  const slugs = normalizeDocsetSlugs(docsetSlugs);
  if (slugs.length === 0) {
    return { sql: "", bindings: {} };
  }

  const bindings: SqlBindings = {};
  const placeholders = slugs.map((slug, index) => {
    const key = `docsetSlug${index}`;
    bindings[key] = slug;
    return `$${key}`;
  });
  return {
    sql: `AND ${tableAlias}.docset_slug IN (${placeholders.join(", ")})`,
    bindings,
  };
}

function normalizeDocsetSlugs(docsetSlugs: readonly string[] | undefined): string[] {
  if (!docsetSlugs || docsetSlugs.length === 0) {
    return [];
  }

  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const value of docsetSlugs) {
    const slug = value.trim();
    assertNonEmpty(slug, "docset slug");
    if (!seen.has(slug)) {
      slugs.push(slug);
      seen.add(slug);
    }
  }
  return slugs;
}

function parseKeywordTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ).slice(0, 8);
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeLimit(limit: number | undefined, defaultLimit: number, label: string): number {
  const value = limit ?? defaultLimit;
  assertPositiveInteger(value, label);
  return value;
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

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DdserveError(`Invalid ${label}: expected a non-negative integer`);
  }
}

function toUint8Array(value: Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new DdserveError("Embedding vector blob was not a byte array");
}
