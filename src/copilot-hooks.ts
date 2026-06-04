import { DdserveError } from "./errors";
import {
  ApiError,
  docsetSummaryDto,
  listInstalledDocsets,
  publicDdserveMessage,
  searchDto,
  type SearchApiResult,
  type ServerOperationRuntime,
} from "./server-shared";

export const COPILOT_HOOKS_BASE_PATH = "/copilot/hooks";
export const COPILOT_SESSION_START_HOOK_PATH = `${COPILOT_HOOKS_BASE_PATH}/sessionStart`;
export const COPILOT_SESSION_START_SEARCH_LIMIT = 4;

export interface CopilotSessionStartPayload {
  sessionId?: string;
  timestamp?: number;
  cwd?: string;
  source?: "startup" | "resume" | "new";
  initialPrompt?: string;
}

export interface CopilotHookResponse {
  additionalContext?: string;
}

export interface CopilotHookDocsetSummary {
  slug: string;
  name: string;
  pageCount: number;
}

export interface CopilotHookPromptSearch {
  status: "matched" | "skipped" | "unavailable";
  query?: string;
  message: string;
  mode?: string;
  model?: string;
  resultCount: number;
  results: CopilotHookPromptMatch[];
}

export interface CopilotHookPromptMatch {
  docsetSlug: string;
  pageId: string;
  pageName: string;
  pagePath: string;
  pageType?: string;
  snippet: string;
  mode: string;
  score: number;
  links: Record<string, string>;
}

export async function sessionStartHookDto(
  runtime: ServerOperationRuntime,
  body: unknown,
): Promise<CopilotHookResponse> {
  const payload = parseSessionStartPayload(body);
  const initialPrompt = optionalTrimmedString(payload.initialPrompt, "initialPrompt");
  const docsets = await listCopilotDocsets(runtime);
  const promptSearch = initialPrompt
    ? await promptSearchContext(runtime, initialPrompt)
    : skippedPromptSearch();
  const lines = [
    "ddserve DevDocs context:",
    formatDocsetsContext(docsets),
  ];

  lines.push(formatPromptSearchContext(promptSearch));

  return {
    additionalContext: lines.filter((line) => line.length > 0).join("\n"),
  };
}

export function parseSessionStartPayload(body: unknown): CopilotSessionStartPayload {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "invalid_request", "Session start hook request body must be a JSON object");
  }
  return body as CopilotSessionStartPayload;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", `Request body field "${key}" must be a string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function listCopilotDocsets(runtime: ServerOperationRuntime): Promise<CopilotHookDocsetSummary[]> {
  try {
    return (await listInstalledDocsets(runtime.cacheRoot)).map((docset) => {
      const summary = docsetSummaryDto(docset);
      return {
        slug: stringField(summary, "slug"),
        name: stringField(summary, "name"),
        pageCount: numberField(summary, "pageCount"),
      };
    });
  } catch (error) {
    throw sanitizedHookError(error);
  }
}

function sanitizedHookError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return new ApiError(error.status, error.code, error.message);
  }
  if (error instanceof DdserveError) {
    return new ApiError(400, "invalid_request", publicDdserveMessage(error));
  }
  return new ApiError(500, "internal_error", "Request could not be completed");
}

function formatDocsetsContext(docsets: readonly CopilotHookDocsetSummary[]): string {
  if (docsets.length === 0) {
    return "Installed docsets: none.";
  }

  return [
    `Installed docsets (${docsets.length}):`,
    ...docsets.map((docset) => `- ${docset.slug}: ${docset.name} (${docset.pageCount} page${docset.pageCount === 1 ? "" : "s"})`),
  ].join("\n");
}

async function promptSearchContext(runtime: ServerOperationRuntime, initialPrompt: string): Promise<CopilotHookPromptSearch> {
  try {
    const response = await searchDto(runtime, {
      query: initialPrompt,
      limit: COPILOT_SESSION_START_SEARCH_LIMIT,
    });
    const results = response.results.slice(0, COPILOT_SESSION_START_SEARCH_LIMIT).map(promptMatch);
    return {
      status: "matched",
      query: response.query,
      message: results.length > 0
        ? `Found ${results.length} prompt-relevant documentation match${results.length === 1 ? "" : "es"}.`
        : "No prompt-relevant documentation matches found.",
      mode: response.mode,
      model: response.model,
      resultCount: results.length,
      results,
    };
  } catch (error) {
    return {
      status: "unavailable",
      query: initialPrompt,
      message: `Prompt-specific matches unavailable: ${safeSearchUnavailableMessage(error)}.`,
      resultCount: 0,
      results: [],
    };
  }
}

function skippedPromptSearch(): CopilotHookPromptSearch {
  return {
    status: "skipped",
    message: "Prompt-specific matches skipped: no initial prompt was provided.",
    resultCount: 0,
    results: [],
  };
}

function formatPromptSearchContext(promptSearch: CopilotHookPromptSearch): string {
  if (promptSearch.status !== "matched") {
    return promptSearch.message;
  }
  if (promptSearch.results.length === 0) {
    return "Prompt-specific matches: none found.";
  }

  return [
    `Prompt-specific matches (${promptSearch.results.length}):`,
    ...promptSearch.results.map(formatPromptMatch),
  ].join("\n");
}

function formatPromptMatch(match: CopilotHookPromptMatch, index: number): string {
  const pageLink = match.links.self;
  const contentLink = match.links.content;
  const links = [
    pageLink ? `page ${pageLink}` : undefined,
    contentLink ? `content ${contentLink}` : undefined,
  ].filter((link): link is string => link !== undefined);

  return [
    `${index + 1}. ${match.docsetSlug}/${match.pageId} — ${match.pageName} (${match.mode} ${formatScore(match.score)})`,
    `   ${compactWhitespace(match.snippet)}`,
    ...(links.length > 0 ? [`   Links: ${links.join("; ")}`] : []),
  ].join("\n");
}

function promptMatch(result: SearchApiResult): CopilotHookPromptMatch {
  return {
    docsetSlug: result.docsetSlug,
    pageId: result.pageId,
    pageName: result.pageName,
    pagePath: result.pagePath,
    pageType: result.pageType,
    snippet: result.snippet,
    mode: result.mode,
    score: result.score,
    links: result.links,
  };
}

function safeSearchUnavailableMessage(error: unknown): string {
  if (error instanceof DdserveError) {
    return publicDdserveMessage(error);
  }
  return "Request could not be completed";
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) {
    return "n/a";
  }
  return score.toFixed(3).replace(/\.?0+$/, "");
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
