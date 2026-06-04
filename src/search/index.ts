import type { DdserveConfig } from "../config";
import { DdserveError } from "../errors";
import { assertPositiveInteger } from "../validation";
import { createOpenAiEmbeddingClient, type EmbeddingClient, type EmbeddingVector } from "../embeddings/openai";
import { closeEmbeddingStorage, openEmbeddingStorage, type EmbeddingStorage } from "../embeddings/storage";
import {
  hydrateSemanticSearchCandidates,
  iterateSemanticVectorCandidates,
  queryKeywordFallbackCandidates,
  type KeywordSearchCandidate,
  type SearchCandidateBase,
  viewFloat32VectorBlob,
} from "./storage";
import { parseKeywordTerms } from "./terms";

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_PAGE_SIZE = 32768;
const SNIPPET_CONTEXT_CHARS = 48;
const SNIPPET_MAX_CHARS = 240;
const DATA_URI_MARKDOWN_LINK_PATTERN = /!?\[([^\]\r\n]*)\]\(\s*data:[^\s)]*;base64,[^)]+?\)/gi;
const LONG_BASE64_RUN_PATTERN = /(^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{80,}={0,2})(?=$|[^A-Za-z0-9+/=])/g;

export type SearchResultMode = "semantic" | "keyword";

export interface SearchOptions {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  client?: EmbeddingClient;
  query: string;
  resolvedSlugs?: readonly string[];
  limit?: number;
  storage?: EmbeddingStorage;
  pageSize?: number;
}

export interface SearchResponse {
  query: string;
  mode: SearchResultMode;
  model: string;
  dimensions: number;
  results: SearchResult[];
}

export interface SearchResult {
  score: number;
  mode: SearchResultMode;
  docsetSlug: string;
  docsetName: string;
  pageId: string;
  pageName: string;
  pagePath: string;
  pageType?: string;
  pageFilePath: string;
  chunkId: number;
  chunkOrdinal: number;
  chunkContentHash: string;
  snippet: string;
  text: string;
}

interface ScoredSemanticChunk {
  chunkId: number;
  score: number;
}

export async function search(options: SearchOptions): Promise<SearchResponse> {
  const query = normalizeQuery(options.query);
  const limit = normalizeLimit(options.limit);
  const openai = validateSemanticSearchConfig(options.config);
  const client = options.client ?? createOpenAiEmbeddingClient(options.config, { env: options.env });
  const queryVector = validateQueryEmbedding(await client.createEmbeddings(query));
  const dimensions = queryVector.length;
  const queryMagnitude = vectorMagnitude(queryVector);
  const model = openai.embeddingModel;
  const resolvedSlugs = normalizeResolvedSlugs(options.resolvedSlugs);
  const storage = options.storage ?? (await openEmbeddingStorage(options.cacheRoot));
  const shouldCloseStorage = !options.storage;

  try {
    const semantic = rankSemanticCandidates(storage, {
      model,
      dimensions,
      queryVector,
      queryMagnitude,
      resolvedSlugs,
      limit,
      pageSize: options.pageSize,
    });

    if (semantic.candidateCount > 0) {
      const candidatesByChunkId = new Map(
        hydrateSemanticSearchCandidates(storage, semantic.results.map((result) => result.chunkId))
          .map((candidate) => [candidate.chunkId, candidate]),
      );

      return {
        query,
        mode: "semantic",
        model,
        dimensions,
        results: semantic.results.map(({ chunkId, score }) => {
          const candidate = candidatesByChunkId.get(chunkId);
          if (!candidate) {
            throw new DdserveError(`Semantic search candidate ${chunkId} could not be hydrated`);
          }
          return toSearchResult(candidate, "semantic", score, query);
        }),
      };
    }

    const keywordCandidates = queryKeywordFallbackCandidates(storage, {
      query,
      docsetSlugs: resolvedSlugs,
      limit,
    });

    return {
      query,
      mode: "keyword",
      model,
      dimensions,
      results: keywordCandidates
        .map((candidate) => toSearchResult(candidate, "keyword", keywordScore(candidate, query), query))
        .sort(compareSearchResults),
    };
  } finally {
    if (shouldCloseStorage) {
      closeEmbeddingStorage(storage);
    }
  }
}

function rankSemanticCandidates(
  storage: EmbeddingStorage,
  options: {
    model: string;
    dimensions: number;
    queryVector: EmbeddingVector;
    queryMagnitude: number;
    resolvedSlugs: readonly string[] | undefined;
    limit: number;
    pageSize?: number;
  },
): { candidateCount: number; results: ScoredSemanticChunk[] } {
  const top: ScoredSemanticChunk[] = [];
  let candidateCount = 0;
  const pageSize = normalizePageSize(options.pageSize);

  for (const candidate of iterateSemanticVectorCandidates(storage, {
    model: options.model,
    dimensions: options.dimensions,
    docsetSlugs: options.resolvedSlugs,
    pageSize,
  })) {
    candidateCount += 1;
    const vector = viewFloat32VectorBlob(candidate.vector, options.dimensions, candidate.vectorEncoding);
    const scored = {
      chunkId: candidate.chunkId,
      score: cosineSimilarity(options.queryVector, options.queryMagnitude, vector),
    };

    if (top.length < options.limit) {
      top.push(scored);
      top.sort(compareSemanticChunks);
      continue;
    }

    const worst = top[top.length - 1];
    if (worst && compareSemanticChunks(scored, worst) < 0) {
      top[top.length - 1] = scored;
      top.sort(compareSemanticChunks);
    }
  }

  return { candidateCount, results: top };
}

function toSearchResult(candidate: SearchCandidateBase, mode: SearchResultMode, score: number, query: string): SearchResult {
  return {
    score,
    mode,
    docsetSlug: candidate.docsetSlug,
    docsetName: candidate.docsetName,
    pageId: candidate.pageId,
    pageName: candidate.pageName,
    pagePath: candidate.pagePath,
    ...(candidate.pageType ? { pageType: candidate.pageType } : {}),
    pageFilePath: candidate.pageFilePath,
    chunkId: candidate.chunkId,
    chunkOrdinal: candidate.chunkOrdinal,
    chunkContentHash: candidate.chunkContentHash,
    snippet: snippetFor(candidate.chunkText, query),
    text: candidate.chunkText,
  };
}

function validateSemanticSearchConfig(config: DdserveConfig): NonNullable<DdserveConfig["openai"]> {
  if (!config.embeddings.enabled) {
    throw new DdserveError("Embeddings are disabled. Enable embeddings in config before semantic search.");
  }
  if (!config.openai) {
    throw new DdserveError("OpenAI embeddings are not configured");
  }
  return config.openai;
}

function validateQueryEmbedding(vectors: readonly EmbeddingVector[]): EmbeddingVector {
  if (vectors.length !== 1) {
    throw new DdserveError(`Embedding client returned ${vectors.length} vectors for query; expected 1`);
  }

  const vector = vectors[0];
  if (!vector || vector.length === 0) {
    throw new DdserveError("Embedding client returned an empty query vector");
  }

  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DdserveError("Embedding client returned a query vector with non-numeric values");
    }
  }

  if (vectorMagnitude(vector) === 0) {
    throw new DdserveError("Embedding client returned a zero-magnitude query vector");
  }

  return [...vector];
}

function cosineSimilarity(queryVector: readonly number[], queryMagnitude: number, candidateVector: Float32Array): number {
  let dot = 0;
  let candidateMagnitudeSquared = 0;

  for (let index = 0; index < queryVector.length; index += 1) {
    const candidateValue = candidateVector[index] ?? 0;
    dot += queryVector[index]! * candidateValue;
    candidateMagnitudeSquared += candidateValue * candidateValue;
  }

  if (candidateMagnitudeSquared === 0) {
    return 0;
  }

  const similarity = dot / (queryMagnitude * Math.sqrt(candidateMagnitudeSquared));
  if (!Number.isFinite(similarity)) {
    throw new DdserveError("Embedding vector contained non-finite values");
  }
  return similarity;
}

function keywordScore(candidate: KeywordSearchCandidate, query: string): number {
  const terms = parseKeywordTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  const searchText = [
    candidate.chunkText,
    candidate.pageName,
    candidate.pagePath,
    candidate.pageType,
    candidate.pageFilePath,
    candidate.docsetSlug,
    candidate.docsetName,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLocaleLowerCase();
  const matches = terms.filter((term) => searchText.includes(term)).length;
  return matches / terms.length;
}

function snippetFor(text: string, query: string): string {
  const normalized = sanitizeSnippetSource(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= SNIPPET_MAX_CHARS) {
    return normalized;
  }

  const lower = normalized.toLocaleLowerCase();
  const firstMatch = parseKeywordTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const center = firstMatch ?? 0;
  const start = Math.max(0, center - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(normalized.length, start + SNIPPET_MAX_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";

  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function sanitizeSnippetSource(text: string): string {
  return text
    .replace(DATA_URI_MARKDOWN_LINK_PATTERN, (_match, label: string) => label)
    .replace(LONG_BASE64_RUN_PATTERN, "$1");
}

function compareSemanticChunks(left: ScoredSemanticChunk, right: ScoredSemanticChunk): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return left.chunkId - right.chunkId;
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareCandidateLikeIdentity(left, right);
}

function compareCandidateIdentity(left: SearchCandidateBase, right: SearchCandidateBase): number {
  return compareCandidateLikeIdentity(left, right);
}

function compareCandidateLikeIdentity(
  left: Pick<SearchCandidateBase, "docsetSlug" | "pagePath" | "chunkOrdinal" | "chunkId">,
  right: Pick<SearchCandidateBase, "docsetSlug" | "pagePath" | "chunkOrdinal" | "chunkId">,
): number {
  return (
    left.docsetSlug.localeCompare(right.docsetSlug) ||
    left.pagePath.localeCompare(right.pagePath) ||
    left.chunkOrdinal - right.chunkOrdinal ||
    left.chunkId - right.chunkId
  );
}

function vectorMagnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (normalized.length === 0) {
    throw new DdserveError("Invalid search query: value must not be empty");
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  const normalized = limit ?? DEFAULT_SEARCH_LIMIT;
  assertPositiveInteger(normalized, "search result limit");
  return normalized;
}

function normalizePageSize(pageSize: number | undefined): number {
  const normalized = pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  assertPositiveInteger(normalized, "search candidate page size");
  return normalized;
}

function normalizeResolvedSlugs(slugs: readonly string[] | undefined): readonly string[] | undefined {
  if (!slugs || slugs.length === 0) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of slugs) {
    const slug = value.trim();
    if (slug.length === 0) {
      throw new DdserveError("Invalid resolved docset slug: value must not be empty");
    }
    if (!seen.has(slug)) {
      normalized.push(slug);
      seen.add(slug);
    }
  }
  return normalized;
}
