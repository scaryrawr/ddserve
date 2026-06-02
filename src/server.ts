import { timingSafeEqual } from "node:crypto";

import { Elysia, type AnyElysia } from "elysia";

import { assertSafePathSegment, readCacheManifest, readDocsetManifest } from "./cache";
import {
  DEFAULT_SERVE_BIND_ADDRESS,
  DEFAULT_SERVE_PORT,
  type DdserveConfig,
} from "./config";
import { getEmbeddingsStatus, type EmbeddingsStatusResult } from "./embeddings";
import { readInstalledPageMarkdown } from "./embeddings/chunks";
import type { EmbeddingClient } from "./embeddings/openai";
import { DdserveError, getErrorMessage } from "./errors";
import { search as searchDocs, type SearchResponse, type SearchResult } from "./search";
import { resolveSearchFilterSlugs } from "./search/filters";
import type { CacheManifestDocset, DocsetManifest, PageManifestEntry } from "./types";

export const DEFAULT_SERVER_BIND_ADDRESS = DEFAULT_SERVE_BIND_ADDRESS;
export const DEFAULT_SERVER_PORT = DEFAULT_SERVE_PORT;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_API_SEARCH_LIMIT = 10;
export const MAX_API_SEARCH_LIMIT = 50;

export interface CreateServerAppOptions {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  embeddingClient?: EmbeddingClient;
  bindAddress?: string;
  search?: typeof searchDocs;
}

export interface ResolvedServeOptions {
  host: string;
  port: number;
}

interface ServerRuntime {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  embeddingClient?: EmbeddingClient;
  search: typeof searchDocs;
  bindAddress: string;
  authToken?: string;
  corsOrigins?: readonly string[];
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

export function resolveServeOptions(config: DdserveConfig, overrides: Partial<ResolvedServeOptions> = {}): ResolvedServeOptions {
  return {
    host: overrides.host ?? config.serve?.bindAddress ?? DEFAULT_SERVER_BIND_ADDRESS,
    port: overrides.port ?? config.serve?.port ?? DEFAULT_SERVER_PORT,
  };
}

export function createServerApp(options: CreateServerAppOptions): AnyElysia {
  const runtime = createRuntime(options);
  const app = new Elysia()
    .onError(({ code, error, request }) => errorResponse(elysiaError(code, error), runtime, request))
    .options("*", ({ request }) => corsPreflightResponse(runtime, request))
    .get("/health", ({ request }) =>
      jsonResponse(
        {
          status: "ok",
          links: {
            api: "/api",
          },
        },
        runtime,
        request,
      ),
    )
    .get("/api", ({ request }) =>
      handleApiRequest(runtime, request, async () => ({
        name: "ddserve",
        version: "0.1.0",
        links: {
          docsets: "/api/docsets",
          search: "/api/search",
          embeddingsStatus: "/api/embeddings/status",
          health: "/health",
        },
      })),
    )
    .get("/api/docsets", ({ request }) =>
      handleApiRequest(runtime, request, async () => ({
        docsets: (await listInstalledDocsets(runtime.cacheRoot)).map(docsetSummaryDto),
      })),
    )
    .get("/api/docsets/:slug", ({ request, params }) =>
      handleApiRequest(runtime, request, async () => docsetDto(await getInstalledDocset(runtime.cacheRoot, params.slug))),
    )
    .get("/api/docsets/:slug/pages", ({ request, params }) =>
      handleApiRequest(runtime, request, async () => {
        const url = new URL(request.url);
        const pagination = parsePagination(url.searchParams, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
        const q = optionalQueryString(url.searchParams, "q");
        const type = optionalQueryString(url.searchParams, "type");
        const manifest = await getInstalledDocset(runtime.cacheRoot, params.slug);
        const filtered = filterPages(manifest.pages, { q, type });
        const pages = filtered.slice(pagination.offset, pagination.offset + pagination.limit);

        return {
          docsetSlug: manifest.slug,
          total: filtered.length,
          limit: pagination.limit,
          offset: pagination.offset,
          pages: pages.map((page) => pageSummaryDto(manifest.slug, page)),
        };
      }),
    )
    .get("/api/docsets/:slug/pages/:pageId", ({ request, params }) =>
      handleApiRequest(runtime, request, async () => {
        const manifest = await getInstalledDocset(runtime.cacheRoot, params.slug);
        return pageDto(manifest.slug, findPage(manifest, params.pageId));
      }),
    )
    .get("/api/docsets/:slug/pages/:pageId/content", ({ request, params }) =>
      handleApiRequest(runtime, request, async () => {
        const url = new URL(request.url);
        const manifest = await getInstalledDocset(runtime.cacheRoot, params.slug);
        const page = findPage(manifest, params.pageId);
        const markdown = await readInstalledPageMarkdown(runtime.cacheRoot, manifest.slug, page);
        return pageContentDto(manifest.slug, page, markdown, parseLineRange(url.searchParams));
      }),
    )
    .get("/api/search", ({ request }) =>
      handleApiRequest(runtime, request, async () => searchGetDto(runtime, new URL(request.url).searchParams)),
    )
    .post("/api/search", ({ request, body }) =>
      handleApiRequest(runtime, request, async () => searchPostDto(runtime, body)),
    )
    .get("/api/embeddings/status", ({ request }) =>
      handleApiRequest(runtime, request, async () => {
        const includeCurrent = shouldIncludeCurrentCounts(new URL(request.url).searchParams);
        return embeddingsStatusDto(
          await getEmbeddingsStatus({
            cacheRoot: runtime.cacheRoot,
            config: runtime.config,
            includeCurrent,
            createDatabase: false,
          }),
        );
      }),
    )
    .get("/api/embeddings/status/:slug", ({ request, params }) =>
      handleApiRequest(runtime, request, async () => {
        assertSafePathSegment(params.slug, "docset slug");
        const includeCurrent = shouldIncludeCurrentCounts(new URL(request.url).searchParams);
        return embeddingsStatusDto(
          await getEmbeddingsStatus({
            cacheRoot: runtime.cacheRoot,
            config: runtime.config,
            slug: params.slug,
            includeCurrent,
            createDatabase: false,
          }),
        );
      }),
    );

  return app;
}

async function handleApiRequest(runtime: ServerRuntime, request: Request, handler: () => Promise<unknown>): Promise<Response> {
  const hostError = validateHost(runtime, request);
  if (hostError) {
    return errorResponse(hostError, runtime, request);
  }

  const authError = validateAuth(runtime, request);
  if (authError) {
    return errorResponse(authError, runtime, request);
  }

  try {
    return jsonResponse(await handler(), runtime, request);
  } catch (error) {
    return errorResponse(error, runtime, request);
  }
}

function createRuntime(options: CreateServerAppOptions): ServerRuntime {
  return {
    cacheRoot: options.cacheRoot,
    config: options.config,
    env: options.env,
    embeddingClient: options.embeddingClient,
    search: options.search ?? searchDocs,
    bindAddress: options.bindAddress ?? options.config.serve?.bindAddress ?? DEFAULT_SERVER_BIND_ADDRESS,
    authToken: resolveAuthToken(options.config, options.env),
    corsOrigins: options.config.serve?.cors?.origins,
  };
}

function resolveAuthToken(config: DdserveConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const auth = config.serve?.auth;
  if (!auth) {
    return undefined;
  }

  const envToken = env[auth.tokenEnv];
  const token = envToken && envToken.trim().length > 0 ? envToken : auth.token;
  if (!token || token.trim().length === 0) {
    throw new DdserveError(
      `Serve auth is configured but ${auth.tokenEnv} is not set and no inline token was provided`,
    );
  }

  return token;
}

async function listInstalledDocsets(cacheRoot: string): Promise<CacheManifestDocset[]> {
  const manifest = await readCacheManifest(cacheRoot);
  return Object.values(manifest.docs).sort((left, right) => left.slug.localeCompare(right.slug));
}

async function getInstalledDocset(cacheRoot: string, slug: string): Promise<DocsetManifest> {
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

function findPage(manifest: DocsetManifest, pageId: string): PageManifestEntry {
  const page = manifest.pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new ApiError(404, "not_found", `Page "${pageId}" is not installed for docset "${manifest.slug}"`);
  }
  return page;
}

function docsetSummaryDto(docset: CacheManifestDocset): Record<string, unknown> {
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

function docsetDto(manifest: DocsetManifest): Record<string, unknown> {
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

function docsetLinks(slug: string): Record<string, string> {
  const docset = `/api/docsets/${encodeURIComponent(slug)}`;
  return {
    self: docset,
    pages: `${docset}/pages`,
    embeddingsStatus: `/api/embeddings/status/${encodeURIComponent(slug)}`,
  };
}

function pageSummaryDto(slug: string, page: PageManifestEntry): Record<string, unknown> {
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

function pageDto(slug: string, page: PageManifestEntry): Record<string, unknown> {
  return pageSummaryDto(slug, page);
}

function pageLinks(slug: string, pageId: string): Record<string, string> {
  const page = `/api/docsets/${encodeURIComponent(slug)}/pages/${encodeURIComponent(pageId)}`;
  return {
    self: page,
    content: `${page}/content`,
  };
}

function pageContentDto(
  slug: string,
  page: PageManifestEntry,
  markdown: string,
  range: LineRangeRequest,
): Record<string, unknown> {
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

function filterPages(
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

async function searchGetDto(runtime: ServerRuntime, params: URLSearchParams): Promise<Record<string, unknown>> {
  const query = requiredQueryString(params, "q");
  const slugs = parseQueryList(params, "slug");
  const languages = parseQueryList(params, "language");
  const limit = parseBoundedInteger(params.get("limit"), DEFAULT_API_SEARCH_LIMIT, MAX_API_SEARCH_LIMIT, "limit");
  return searchDto(runtime, { query, slugs, languages, limit });
}

async function searchPostDto(runtime: ServerRuntime, body: unknown): Promise<Record<string, unknown>> {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "invalid_request", "Search request body must be a JSON object");
  }

  const query = requiredBodyString(body, "query");
  const slugs = optionalBodyStringList(body, "slugs");
  const languages = optionalBodyStringList(body, "languages");
  const limit = parseBoundedInteger(body.limit, DEFAULT_API_SEARCH_LIMIT, MAX_API_SEARCH_LIMIT, "limit");
  return searchDto(runtime, { query, slugs, languages, limit });
}

async function searchDto(
  runtime: ServerRuntime,
  request: {
    query: string;
    slugs?: readonly string[];
    languages?: readonly string[];
    limit: number;
  },
): Promise<Record<string, unknown>> {
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

function searchResponseDto(response: SearchResponse, resolvedSlugs: readonly string[] | undefined): Record<string, unknown> {
  return {
    query: response.query,
    mode: response.mode,
    model: response.model,
    dimensions: response.dimensions,
    resolvedSlugs: resolvedSlugs ?? [],
    results: response.results.map(searchResultDto),
  };
}

function searchResultDto(result: SearchResult): Record<string, unknown> {
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

function embeddingsStatusDto(status: EmbeddingsStatusResult): Record<string, unknown> {
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

interface Pagination {
  limit: number;
  offset: number;
}

function parsePagination(params: URLSearchParams, defaultLimit: number, maxLimit: number): Pagination {
  return {
    limit: parseBoundedInteger(params.get("limit"), defaultLimit, maxLimit, "limit"),
    offset: parseNonNegativeInteger(params.get("offset"), 0, "offset"),
  };
}

interface LineRangeRequest {
  startLine?: number;
  endLine?: number;
}

function parseLineRange(params: URLSearchParams): LineRangeRequest {
  const startLine = parseOptionalPositiveInteger(params.get("startLine"), "startLine");
  const endLine = parseOptionalPositiveInteger(params.get("endLine"), "endLine");
  return {
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function shouldIncludeCurrentCounts(params: URLSearchParams): boolean {
  return params.get("detail") === "full";
}

function optionalQueryString(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredQueryString(params: URLSearchParams, key: string): string {
  const value = optionalQueryString(params, key);
  if (!value) {
    throw new ApiError(400, "invalid_request", `Missing required query parameter "${key}"`);
  }
  return value;
}

function parseQueryList(params: URLSearchParams, key: string): string[] | undefined {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "invalid_request", `Request body field "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalBodyStringList(body: Record<string, unknown>, key: string): string[] | undefined {
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

function parseBoundedInteger(
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

function parseNonNegativeInteger(value: string | null, defaultValue: number, label: string): number {
  if (value === null || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_request", `${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: string | null, label: string): number | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_line_range", `${label} must be a positive integer`);
  }
  return parsed;
}

function validateHost(runtime: ServerRuntime, request: Request): ApiError | undefined {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!host || runtime.bindAddress === "0.0.0.0" || runtime.bindAddress === "::") {
    return undefined;
  }

  const hostname = host.split(":", 1)[0]?.replace(/^\[|\]$/g, "") ?? "";
  const allowed = new Set(["localhost", "127.0.0.1", "::1", runtime.bindAddress]);
  if (!allowed.has(hostname)) {
    return new ApiError(403, "forbidden", "Host header is not allowed");
  }
  return undefined;
}

function validateAuth(runtime: ServerRuntime, request: Request): ApiError | undefined {
  if (!runtime.authToken) {
    return undefined;
  }

  const header = request.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !timingSafeEqualString(token, runtime.authToken)) {
    return new ApiError(401, "unauthorized", "Missing or invalid bearer token");
  }
  return undefined;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function jsonResponse(data: unknown, runtime: ServerRuntime, request: Request, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: responseHeaders(runtime, request),
  });
}

function errorResponse(error: unknown, runtime: ServerRuntime, request: Request): Response {
  const body = errorBody(error);
  return jsonResponse(body, runtime, request, errorStatus(error));
}

function elysiaError(code: string | number, error: unknown): unknown {
  if (code === "NOT_FOUND") {
    return new ApiError(404, "not_found", "Route not found");
  }
  if (code === "PARSE") {
    return new ApiError(400, "invalid_request", "Request body must be valid JSON");
  }
  if (code === "VALIDATION") {
    return new ApiError(400, "invalid_request", "Request failed validation");
  }
  return error;
}

function errorStatus(error: unknown): number {
  if (error instanceof ApiError) {
    return error.status;
  }
  if (error instanceof DdserveError) {
    return 400;
  }
  return 500;
}

function errorBody(error: unknown): ApiErrorBody {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof DdserveError) {
    return {
      error: {
        code: "invalid_request",
        message: publicDdserveMessage(error),
      },
    };
  }

  return {
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  };
}

function publicDdserveMessage(error: DdserveError): string {
  const message = getErrorMessage(error);
  if (containsFilesystemPath(message)) {
    return "Request could not be completed";
  }
  if (/^(Invalid|Missing|Unknown|Ambiguous|No docsets|Embeddings|OpenAI|Search)/.test(message)) {
    return message;
  }
  return "Request could not be completed";
}

function containsFilesystemPath(message: string): boolean {
  return /(?:^|\s)(?:\.{1,2}[\\/]|[^\s:]+[\\/][^\s]+|\/|~\/|[A-Za-z]:[\\/])/.test(message);
}

function responseHeaders(runtime: ServerRuntime, request: Request): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applyCorsHeaders(headers, runtime, request);
  return headers;
}

function corsPreflightResponse(runtime: ServerRuntime, request: Request): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, runtime, request);
  if (headers.has("access-control-allow-origin")) {
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-max-age", "600");
  }
  return new Response(null, { status: 204, headers });
}

function applyCorsHeaders(headers: Headers, runtime: ServerRuntime, request: Request): void {
  const origins = runtime.corsOrigins;
  if (!origins || origins.length === 0) {
    return;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }

  if (origins.includes("*")) {
    headers.set("access-control-allow-origin", "*");
    return;
  }

  if (origins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
