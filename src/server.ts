import { timingSafeEqual } from "node:crypto";

import { Elysia, type AnyElysia } from "elysia";

import { assertSafePathSegment } from "./cache";
import {
  DEFAULT_SERVE_BIND_ADDRESS,
  DEFAULT_SERVE_PORT,
  type DdserveConfig,
} from "./config";
import { getEmbeddingsStatus } from "./embeddings";
import type { EmbeddingClient } from "./embeddings/openai";
import { DdserveError } from "./errors";
import { MCP_ENDPOINT_PATH, handleMcpEndpointRequest } from "./mcp";
import { search as searchDocs } from "./search";
import {
  ApiError,
  DEFAULT_API_SEARCH_LIMIT,
  DEFAULT_PAGE_LIMIT,
  MAX_API_SEARCH_LIMIT,
  MAX_PAGE_LIMIT,
  docsetDto,
  docsetSummaryDto,
  embeddingsStatusDto,
  filterPages,
  findPage,
  getPageContentDto,
  getInstalledDocset,
  listInstalledDocsets,
  optionalQueryString,
  pageDto,
  pageSummaryDto,
  parseLineRange,
  parsePagination,
  publicDdserveMessage,
  searchGetDto,
  searchPostDto,
  shouldIncludeCurrentCounts,
  type ApiErrorBody,
  type ServerOperationRuntime,
} from "./server-shared";

export const DEFAULT_SERVER_BIND_ADDRESS = DEFAULT_SERVE_BIND_ADDRESS;
export const DEFAULT_SERVER_PORT = DEFAULT_SERVE_PORT;
export { DEFAULT_API_SEARCH_LIMIT, DEFAULT_PAGE_LIMIT, MAX_API_SEARCH_LIMIT, MAX_PAGE_LIMIT };

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

interface ServerRuntime extends ServerOperationRuntime {
  cacheRoot: string;
  config: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  embeddingClient?: EmbeddingClient;
  search: typeof searchDocs;
  bindAddress: string;
  authToken?: string;
  corsOrigins?: readonly string[];
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
          mcp: MCP_ENDPOINT_PATH,
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
        return getPageContentDto(runtime.cacheRoot, params.slug, params.pageId, parseLineRange(url.searchParams));
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
    )
    .options(MCP_ENDPOINT_PATH, ({ request }) => corsPreflightResponse(runtime, request))
    .all(MCP_ENDPOINT_PATH, ({ request, body }) =>
      handleMcpRequest(runtime, request, body),
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

async function handleMcpRequest(runtime: ServerRuntime, request: Request, parsedBody: unknown): Promise<Response> {
  const hostError = validateHost(runtime, request);
  if (hostError) {
    return errorResponse(hostError, runtime, request);
  }

  const authError = validateAuth(runtime, request);
  if (authError) {
    return errorResponse(authError, runtime, request);
  }

  try {
    return responseWithCorsHeaders(await handleMcpEndpointRequest(runtime, request, parsedBody), runtime, request);
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

function responseHeaders(runtime: ServerRuntime, request: Request): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applyCorsHeaders(headers, runtime, request);
  return headers;
}

function responseWithCorsHeaders(response: Response, runtime: ServerRuntime, request: Request): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, runtime, request);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflightResponse(runtime: ServerRuntime, request: Request): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, runtime, request);
  if (headers.has("access-control-allow-origin")) {
    headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    headers.set(
      "access-control-allow-headers",
      "authorization, accept, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
    );
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
    headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
    return;
  }

  if (origins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
    headers.append("vary", "Origin");
  }
}
