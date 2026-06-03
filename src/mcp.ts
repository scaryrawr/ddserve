import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ReadResourceResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { DdserveError } from "./errors";
import {
  ApiError,
  DEFAULT_API_SEARCH_LIMIT,
  MAX_API_SEARCH_LIMIT,
  docsetSummaryDto,
  getPageContentDto,
  listInstalledDocsets,
  publicDdserveMessage,
  searchDto,
  type PageContentResponse,
  type SearchApiResponse,
  type ServerOperationRuntime,
} from "./server-shared";

export const MCP_ENDPOINT_PATH = "/mcp";
const MCP_PAGE_RESOURCE_TEMPLATE = "ddserve://docsets/{slug}/pages/{pageId}";
const MARKDOWN_MIME_TYPE = "text/markdown";

const listDocsetsInputSchema = z.object({});

const searchDocsInputSchema = z.object({
  query: z.string().min(1).describe("Search query text."),
  slugs: z.array(z.string().min(1)).optional().describe("Optional installed docset slugs to search."),
  languages: z.array(z.string().min(1)).optional().describe("Optional language/name/type aliases to resolve to docsets."),
  limit: z.number().int().positive().max(MAX_API_SEARCH_LIMIT).optional().describe("Maximum result count."),
});

const getPageContentInputSchema = z.object({
  slug: z.string().min(1).describe("Installed docset slug."),
  pageId: z.string().min(1).describe("Stable page ID from search results or page metadata."),
  startLine: z.number().int().positive().optional().describe("Optional 1-based inclusive start line."),
  endLine: z.number().int().positive().optional().describe("Optional 1-based inclusive end line."),
});

export async function handleMcpEndpointRequest(
  runtime: ServerOperationRuntime,
  request: Request,
  parsedBody?: unknown,
): Promise<Response> {
  const server = createDdserveMcpServer(runtime);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let connected = false;

  try {
    await server.connect(transport);
    connected = true;
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    if (connected) {
      await server.close();
    }
  }
}

function createDdserveMcpServer(runtime: ServerOperationRuntime): McpServer {
  const server = new McpServer(
    {
      name: "ddserve",
      title: "ddserve",
      version: "0.1.0",
      description: "Read-only access to locally cached DevDocs documentation.",
    },
    {
      instructions:
        "Use list_docsets to discover available documentation slugs, search_docs to find relevant installed DevDocs pages, then get_page_content or returned resource links to read full Markdown content. All operations are read-only.",
    },
  );

  server.registerTool(
    "list_docsets",
    {
      title: "List documentation docsets",
      description: "List available DevDocs docsets and their slugs for use with documentation search.",
      inputSchema: listDocsetsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      try {
        const docsets = (await listInstalledDocsets(runtime.cacheRoot)).map(docsetSummaryDto);
        return {
          content: [{ type: "text", text: formatDocsetsSummary(docsets) }],
          structuredContent: { docsets },
        };
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search documentation",
      description:
        "Search available DevDocs documentation for pages relevant to a query.",
      inputSchema: searchDocsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await searchDto(runtime, {
          query: args.query,
          slugs: args.slugs,
          languages: args.languages,
          limit: args.limit ?? DEFAULT_API_SEARCH_LIMIT,
        });

        return {
          content: [{ type: "text", text: formatSearchSummary(result) }, ...searchResourceLinks(result)],
          structuredContent: { ...result },
        };
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  server.registerTool(
    "get_page_content",
    {
      title: "Get page content",
      description: "Read Markdown content for an installed documentation page, optionally limited to a line range.",
      inputSchema: getPageContentInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await getPageContentDto(runtime.cacheRoot, args.slug, args.pageId, {
          ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
          ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
        });

        return {
          content: [{ type: "text", text: result.content }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  server.registerResource(
    "ddserve-page",
    new ResourceTemplate(MCP_PAGE_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "ddserve documentation page",
      description: "Markdown content for an installed ddserve documentation page.",
      mimeType: MARKDOWN_MIME_TYPE,
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const slug = decodeResourceVariable(variables.slug, "slug");
        const pageId = decodeResourceVariable(variables.pageId, "pageId");
        const result = await getPageContentDto(runtime.cacheRoot, slug, pageId, {});
        return pageContentResource(uri.href, result);
      } catch (error) {
        throw new DdserveError(publicMcpErrorMessage(error));
      }
    },
  );

  return server;
}

function formatDocsetsSummary(docsets: Record<string, unknown>[]): string {
  if (docsets.length === 0) {
    return "No DevDocs docsets are currently available.";
  }

  const lines = docsets.map((docset, index) => {
    const slug = String(docset.slug);
    const name = String(docset.name);
    const pageCount = Number(docset.pageCount);
    return `${index + 1}. ${name} (${slug}) - ${pageCount} page(s)`;
  });
  return `Found ${docsets.length} available DevDocs docset(s):\n${lines.join("\n")}`;
}

function searchResourceLinks(response: SearchApiResponse): ResourceLink[] {
  const links: ResourceLink[] = [];
  const seen = new Set<string>();

  for (const result of response.results) {
    const uri = pageResourceUri(result.docsetSlug, result.pageId);
    if (seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    links.push({
      type: "resource_link",
      uri,
      name: `${result.docsetSlug}:${result.pageId}`,
      title: result.pageName,
      description: `${result.docsetName} page ${result.pagePath}`,
      mimeType: MARKDOWN_MIME_TYPE,
    });
  }

  return links;
}

function pageContentResource(uri: string, result: PageContentResponse): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: MARKDOWN_MIME_TYPE,
        text: result.content,
        _meta: {
          docsetSlug: result.docsetSlug,
          page: result.page,
          startLine: result.startLine,
          endLine: result.endLine,
          totalLines: result.totalLines,
        },
      },
    ],
  };
}

function formatSearchSummary(response: SearchApiResponse): string {
  if (response.results.length === 0) {
    return `No documentation results found for "${response.query}".`;
  }

  const lines = response.results.map((result, index) => {
    const location = `${result.docsetSlug}/${result.pageId}`;
    return `${index + 1}. ${result.pageName} (${location}) - ${result.snippet}`;
  });
  return `Found ${response.results.length} documentation result(s) for "${response.query}" using ${response.mode} search.\n${lines.join("\n")}`;
}

function pageResourceUri(slug: string, pageId: string): string {
  return `ddserve://docsets/${encodeURIComponent(slug)}/pages/${encodeURIComponent(pageId)}`;
}

function decodeResourceVariable(value: string | string[] | undefined, label: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    throw new DdserveError(`Invalid MCP page resource URI: missing ${label}`);
  }

  try {
    return decodeURIComponent(raw);
  } catch (error) {
    throw new DdserveError(`Invalid MCP page resource URI: ${label} is not URI encoded`, { cause: error });
  }
}

function mcpToolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: publicMcpErrorMessage(error) }],
  };
}

function publicMcpErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof DdserveError) {
    return publicDdserveMessage(error);
  }
  return "Internal server error";
}
