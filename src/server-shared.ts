import { assertSafePathSegment, readCacheManifest, readDocsetManifest } from "./cache";
import type { DdserveConfig } from "./config";
import type { EmbeddingsStatusResult } from "./embeddings";
import { readInstalledPageMarkdown } from "./embeddings/chunks";
import type { EmbeddingClient } from "./embeddings/openai";
import { DdserveError, getErrorMessage } from "./errors";
import { search as searchDocs, type SearchResponse, type SearchResult } from "./search";
import { resolveSearchFilterSlugs } from "./search/filters";
import type { CacheManifestDocset, DocsetManifest, PageManifestEntry } from "./types";
import { isPlainObject } from "./utils";

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_API_SEARCH_LIMIT = 10;
export const MAX_API_SEARCH_LIMIT = 50;

export interface ServerOperationRuntime {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  embeddingClient?: EmbeddingClient;
  search: typeof searchDocs;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export class ApiError extends DdserveError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export async function listInstalledDocsets(cacheRoot: string): Promise<CacheManifestDocset[]> {
  const manifest = await readCacheManifest(cacheRoot);
  return Object.values(manifest.docs).sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function getInstalledDocset(cacheRoot: string, slug: string): Promise<DocsetManifest> {
  assertSafePathSegment(slug, "docset slug");
  const topLevel = await readCacheManifest(cacheRoot);
  if (!topLevel.docs[slug]) {
    throw new ApiError(404, "not_found", `Docset "${slug}" is not installed`);
  }

  const manifest = await readDocsetManifest(cacheRoot, slug);
  if (!manifest) {
    throw new ApiError(404, "not_found", `Docset "${slug}" manifest is missing`);
  }
  return manifest;
}

export function findPage(manifest: DocsetManifest, pageId: string): PageManifestEntry {
  const page = manifest.pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new ApiError(404, "not_found", `Page "${pageId}" is not installed for docset "${manifest.slug}"`);
  }
  return page;
}

export function docsetSummaryDto(docset: CacheManifestDocset): Record<string, unknown> {
  return {
    source: docset.source,
    slug: docset.slug,
    name: docset.name,
    type: docset.type,
    contentFormat: docset.contentFormat,
    version: docset.version,
    release: docset.release,
    mtime: docset.mtime,
    dbSize: docset.dbSize,
    installedAt: docset.installedAt,
    updatedAt: docset.updatedAt,
    pageCount: docset.pageCount,
    links: docsetLinks(docset.slug),
  };
}

export function docsetDto(manifest: DocsetManifest): Record<string, unknown> {
  return {
    source: manifest.source,
    slug: manifest.slug,
    name: manifest.name,
    type: manifest.type,
    contentFormat: manifest.contentFormat,
    version: manifest.version,
    release: manifest.release,
    mtime: manifest.mtime,
    dbSize: manifest.dbSize,
    installedAt: manifest.installedAt,
    updatedAt: manifest.updatedAt,
    pageCount: manifest.pages.length,
    skippedEntries: manifest.skippedEntries,
    links: docsetLinks(manifest.slug),
  };
}

export function docsetLinks(slug: string): Record<string, string> {
  const docset = `/api/docsets/${encodeURIComponent(slug)}`;
  return {
    self: docset,
    pages: `${docset}/pages`,
    embeddingsStatus: `/api/embeddings/status/${encodeURIComponent(slug)}`,
  };
}

export function pageSummaryDto(slug: string, page: PageManifestEntry): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    path: page.path,
    type: page.type,
    format: page.format,
    sourceKey: page.sourceKey,
    links: pageLinks(slug, page.id),
  };
}

export function pageDto(slug: string, page: PageManifestEntry): Record<string, unknown> {
  return pageSummaryDto(slug, page);
}

export function pageLinks(slug: string, pageId: string): Record<string, string> {
  const page = `/api/docsets/${encodeURIComponent(slug)}/pages/${encodeURIComponent(pageId)}`;
  return {
    self: page,
    content: `${page}/content`,
  };
}

export interface PageContentResponse {
  docsetSlug: string;
  page: Record<string, unknown>;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface LineRangeRequest {
  startLine?: number;
  endLine?: number;
}

export function pageContentDto(
  slug: string,
  page: PageManifestEntry,
  markdown: string,
  range: LineRangeRequest,
): PageContentResponse {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const totalLines = lines.length;
  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? totalLines;

  if (startLine > endLine) {
    throw new ApiError(400, "invalid_line_range", "startLine must be less than or equal to endLine");
  }
  if (startLine > totalLines) {
    throw new ApiError(400, "invalid_line_range", `startLine must be between 1 and ${totalLines}`);
  }
  if (endLine > totalLines) {
    throw new ApiError(400, "invalid_line_range", `endLine must be between 1 and ${totalLines}`);
  }

  return {
    docsetSlug: slug,
    page: pageSummaryDto(slug, page),
    startLine,
    endLine,
    totalLines,
    content: lines.slice(startLine - 1, endLine).join("\n"),
  };
}

export async function getPageContentDto(
  cacheRoot: string,
  slug: string,
  pageId: string,
  range: LineRangeRequest,
): Promise<PageContentResponse> {
  const manifest = await getInstalledDocset(cacheRoot, slug);
  const page = findPage(manifest, pageId);
  const markdown = await readInstalledPageMarkdown(cacheRoot, manifest.slug, page);
  return pageContentDto(manifest.slug, page, markdown, range);
}

export function filterPages(
  pages: readonly PageManifestEntry[],
  filters: {
    q?: string;
    type?: string;
  },
): PageManifestEntry[] {
  const q = filters.q?.toLocaleLowerCase();
  const type = filters.type?.toLocaleLowerCase();
  return pages.filter((page) => {
    if (
      q &&
      ![page.id, page.name, page.path, page.type]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(q))
    ) {
      return false;
    }

    if (type && page.type?.toLocaleLowerCase() !== type) {
      return false;
    }

    return true;
  });
}

export async function searchGetDto(runtime: ServerOperationRuntime, params: URLSearchParams): Promise<SearchApiResponse> {
  const query = requiredQueryString(params, "q");
  const slugs = parseQueryList(params, "slug");
  const languages = parseQueryList(params, "language");
  const limit = parseBoundedInteger(params.get("limit"), DEFAULT_API_SEARCH_LIMIT, MAX_API_SEARCH_LIMIT, "limit");
  return searchDto(runtime, { query, slugs, languages, limit });
}

export async function searchPostDto(runtime: ServerOperationRuntime, body: unknown): Promise<SearchApiResponse> {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "invalid_request", "Search request body must be a JSON object");
  }

  const query = requiredBodyString(body, "query");
  const slugs = optionalBodyStringList(body, "slugs");
  const languages = optionalBodyStringList(body, "languages");
  const limit = parseBoundedInteger(body.limit, DEFAULT_API_SEARCH_LIMIT, MAX_API_SEARCH_LIMIT, "limit");
  return searchDto(runtime, { query, slugs, languages, limit });
}

export async function searchDto(
  runtime: ServerOperationRuntime,
  request: {
    query: string;
    slugs?: readonly string[];
    languages?: readonly string[];
    limit: number;
  },
): Promise<SearchApiResponse> {
  const resolvedSlugs = await resolveSearchFilterSlugs({
    cacheRoot: runtime.cacheRoot,
    slug: request.slugs,
    language: request.languages,
  });
  const response = await runtime.search({
    cacheRoot: runtime.cacheRoot,
    config: runtime.config,
    env: runtime.env,
    client: runtime.embeddingClient,
    query: request.query,
    resolvedSlugs,
    limit: request.limit,
  });

  return searchResponseDto(response, resolvedSlugs);
}

export interface SearchApiResponse {
  query: string;
  mode: string;
  model: string;
  dimensions: number;
  resolvedSlugs: string[];
  results: SearchApiResult[];
}

export interface SearchApiResult {
  score: number;
  mode: string;
  docsetSlug: string;
  docsetName: string;
  pageId: string;
  pageName: string;
  pagePath: string;
  pageType?: string;
  chunkId: number;
  chunkOrdinal: number;
  chunkContentHash: string;
  snippet: string;
  text: string;
  links: Record<string, string>;
}

export function searchResponseDto(response: SearchResponse, resolvedSlugs: readonly string[] | undefined): SearchApiResponse {
  return {
    query: response.query,
    mode: response.mode,
    model: response.model,
    dimensions: response.dimensions,
    resolvedSlugs: [...(resolvedSlugs ?? [])],
    results: response.results.map(searchResultDto),
  };
}

export function searchResultDto(result: SearchResult): SearchApiResult {
  return {
    score: result.score,
    mode: result.mode,
    docsetSlug: result.docsetSlug,
    docsetName: result.docsetName,
    pageId: result.pageId,
    pageName: result.pageName,
    pagePath: result.pagePath,
    pageType: result.pageType,
    chunkId: result.chunkId,
    chunkOrdinal: result.chunkOrdinal,
    chunkContentHash: result.chunkContentHash,
    snippet: result.snippet,
    text: result.text,
    links: pageLinks(result.docsetSlug, result.pageId),
  };
}

export function embeddingsStatusDto(status: EmbeddingsStatusResult): Record<string, unknown> {
  return {
    enabled: status.enabled,
    configured: status.configured,
    model: status.model,
    installed: status.installed,
    indexed: status.indexed,
    currentChunks: status.currentChunks,
    staleChunks: status.staleChunks,
    missingChunks: status.missingChunks,
    docsets: status.docsets.map((docset) => ({
      slug: docset.slug,
      name: docset.name,
      pages: docset.pages,
      indexedPages: docset.indexedPages,
      indexedChunks: docset.indexedChunks,
      model: docset.model,
      dimensions: docset.dimensions,
      indexedAt: docset.indexedAt,
      lastEmbeddedAt: docset.lastEmbeddedAt,
      currentChunks: docset.currentChunks,
      staleChunks: docset.staleChunks,
      missingChunks: docset.missingChunks,
      chunks: docset.chunks,
      links: docsetLinks(docset.slug),
    })),
  };
}

export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(params: URLSearchParams, defaultLimit: number, maxLimit: number): Pagination {
  return {
    limit: parseBoundedInteger(params.get("limit"), defaultLimit, maxLimit, "limit"),
    offset: parseNonNegativeInteger(params.get("offset"), 0, "offset"),
  };
}

export function parseLineRange(params: URLSearchParams): LineRangeRequest {
  const startLine = parseOptionalPositiveInteger(params.get("startLine"), "startLine");
  const endLine = parseOptionalPositiveInteger(params.get("endLine"), "endLine");
  return {
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

export function shouldIncludeCurrentCounts(params: URLSearchParams): boolean {
  return params.get("detail") === "full";
}

export function optionalQueryString(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requiredQueryString(params: URLSearchParams, key: string): string {
  const value = optionalQueryString(params, key);
  if (!value) {
    throw new ApiError(400, "invalid_request", `Missing required query parameter "${key}"`);
  }
  return value;
}

export function parseQueryList(params: URLSearchParams, key: string): string[] | undefined {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

export function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "invalid_request", `Request body field "${key}" must be a non-empty string`);
  }
  return value.trim();
}

export function optionalBodyStringList(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `Request body field "${key}" must be an array of strings`);
  }

  const values = value.map((item, index) => {
    if (typeof item !== "string") {
      throw new ApiError(400, "invalid_request", `Request body field "${key}[${index}]" must be a string`);
    }
    return item.trim();
  }).filter((item) => item.length > 0);

  return values.length > 0 ? values : undefined;
}

export function parseBoundedInteger(
  value: string | number | unknown,
  defaultValue: number,
  maxValue: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_request", `${label} must be a positive integer`);
  }
  if (parsed > maxValue) {
    throw new ApiError(400, "invalid_request", `${label} must be less than or equal to ${maxValue}`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string | null, defaultValue: number, label: string): number {
  if (value === null || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_request", `${label} must be a non-negative integer`);
  }
  return parsed;
}

export function parseOptionalPositiveInteger(value: string | null, label: string): number | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_line_range", `${label} must be a positive integer`);
  }
  return parsed;
}

export function publicDdserveMessage(error: DdserveError): string {
  const message = getErrorMessage(error);
  if (containsFilesystemPath(message)) {
    return "Request could not be completed";
  }
  if (/^(Invalid|Missing|Unknown|Ambiguous|No docsets|Embeddings|OpenAI|Search)/.test(message)) {
    return message;
  }
  return "Request could not be completed";
}

export function containsFilesystemPath(message: string): boolean {
  return /(?:^|\s)(?:\.{1,2}[\\/]|[^\s:]+[\\/][^\s]+|\/|~\/|[A-Za-z]:[\\/])/.test(message);
}
