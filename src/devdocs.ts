import { atomicWriteJson, cachePaths, ensureCacheRoot, readJsonFile } from "./cache";
import { DdserveError, getErrorMessage } from "./errors";
import { FetchHttpClient, type HttpClient } from "./http";
import { DEV_DOCS_SOURCE, type AvailableDocsetsResult, type DevDocsRawDocset, type DocsetSummary } from "./types";

export const DEV_DOCS_INDEX_URL = "https://devdocs.io/docs.json";
export const DEV_DOCS_DOCUMENTS_BASE_URL = "https://documents.devdocs.io";

export interface AvailableDocsetsOptions {
  cacheRoot: string;
  http?: HttpClient;
  offline?: boolean;
  now?: Date;
}

export async function getAvailableDocsets(options: AvailableDocsetsOptions): Promise<AvailableDocsetsResult> {
  const paths = await ensureCacheRoot(options.cacheRoot);
  const warnings: string[] = [];
  const now = options.now ?? new Date();

  if (!options.offline) {
    try {
      const rawDocsets = await getHttp(options).fetchJson<DevDocsRawDocset[]>(DEV_DOCS_INDEX_URL);
      const docsets = normalizeDocsets(rawDocsets);
      await atomicWriteJson(paths.devdocsSourceIndex, {
        fetchedAt: now.toISOString(),
        url: DEV_DOCS_INDEX_URL,
        docsets: rawDocsets,
      });
      return {
        docsets,
        fetchedAt: now.toISOString(),
        fromCache: false,
        warnings,
      };
    } catch (error) {
      warnings.push(`Failed to refresh DevDocs index; using cached index if available. ${getErrorMessage(error)}`);
    }
  }

  const cached = await readJsonFile<{ fetchedAt?: string; docsets?: DevDocsRawDocset[] }>(paths.devdocsSourceIndex);
  if (!cached?.docsets) {
    const mode = options.offline ? "Offline mode requested" : "DevDocs index refresh failed";
    throw new DdserveError(`${mode}, and no cached DevDocs index exists at ${paths.devdocsSourceIndex}`);
  }

  return {
    docsets: normalizeDocsets(cached.docsets),
    fetchedAt: cached.fetchedAt ?? now.toISOString(),
    fromCache: true,
    warnings,
  };
}

export function findDocset(docsets: DocsetSummary[], slug: string): DocsetSummary | undefined {
  return docsets.find((docset) => docset.slug === slug);
}

export function docsetIndexUrl(slug: string): string {
  return `${DEV_DOCS_DOCUMENTS_BASE_URL}/${encodeURIComponent(slug)}/index.json`;
}

export function docsetDbUrl(slug: string): string {
  return `${DEV_DOCS_DOCUMENTS_BASE_URL}/${encodeURIComponent(slug)}/db.json`;
}

export function normalizeDocsets(rawDocsets: DevDocsRawDocset[]): DocsetSummary[] {
  if (!Array.isArray(rawDocsets)) {
    throw new DdserveError("DevDocs index did not contain a docset array");
  }

  return rawDocsets
    .filter(isUsableRawDocset)
    .map((raw) => ({
      source: DEV_DOCS_SOURCE,
      name: raw.name,
      slug: raw.slug,
      type: raw.type ?? raw.slug,
      version: raw.version || undefined,
      release: raw.release || undefined,
      mtime: typeof raw.mtime === "number" ? raw.mtime : undefined,
      dbSize: typeof raw.db_size === "number" ? raw.db_size : undefined,
      aliases: normalizeAliases(raw.alias),
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function isUsableRawDocset(value: DevDocsRawDocset): boolean {
  return typeof value?.name === "string" && value.name.length > 0 && typeof value.slug === "string" && value.slug.length > 0;
}

function normalizeAliases(alias: string | string[] | undefined): string[] {
  if (!alias) {
    return [];
  }

  return Array.isArray(alias) ? alias : [alias];
}

function getHttp(options: AvailableDocsetsOptions): HttpClient {
  return options.http ?? new FetchHttpClient();
}

export function getSourceIndexPath(cacheRoot: string): string {
  return cachePaths(cacheRoot).devdocsSourceIndex;
}
