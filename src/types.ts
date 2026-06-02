export const CACHE_SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = 5;
export const EXTRACTED_CONTENT_FORMAT = "markdown" as const;
export const DEV_DOCS_SOURCE = "devdocs" as const;

export type CacheDocsetStatus = "installed";
export type ExtractedContentFormat = typeof EXTRACTED_CONTENT_FORMAT;

export interface DevDocsRawDocset {
  name: string;
  slug: string;
  type?: string;
  version?: string;
  release?: string;
  mtime?: number;
  db_size?: number;
  alias?: string | string[];
  links?: Record<string, string>;
  attribution?: string;
}

export interface DocsetSummary {
  source: typeof DEV_DOCS_SOURCE;
  name: string;
  slug: string;
  type: string;
  version?: string;
  release?: string;
  mtime?: number;
  dbSize?: number;
  aliases: string[];
}

export interface DevDocsIndex {
  entries: DevDocsIndexEntry[];
}

export interface DevDocsIndexEntry {
  name: string;
  path: string;
  type?: string;
}

export interface PageManifestEntry {
  id: string;
  name: string;
  path: string;
  type?: string;
  file: string;
  format: ExtractedContentFormat;
  sourceKey: string;
}

export interface RawFileManifestEntry {
  file: string;
  url?: string;
  bytes: number;
  sha256: string;
}

export interface DocsetManifest {
  schemaVersion: number;
  extractorVersion: number;
  contentFormat: ExtractedContentFormat;
  source: typeof DEV_DOCS_SOURCE;
  status: CacheDocsetStatus;
  slug: string;
  name: string;
  type: string;
  version?: string;
  release?: string;
  mtime?: number;
  dbSize?: number;
  installedAt: string;
  updatedAt: string;
  upstream: {
    docsIndexUrl: string;
    indexUrl: string;
    dbUrl: string;
  };
  rawFiles: RawFileManifestEntry[];
  pages: PageManifestEntry[];
  skippedEntries: number;
}

export interface CacheManifestDocset {
  source: typeof DEV_DOCS_SOURCE;
  slug: string;
  name: string;
  type: string;
  contentFormat: ExtractedContentFormat;
  version?: string;
  release?: string;
  mtime?: number;
  dbSize?: number;
  installedAt: string;
  updatedAt: string;
  pageCount: number;
}

export interface CacheManifest {
  schemaVersion: number;
  updatedAt: string;
  docs: Record<string, CacheManifestDocset>;
}

export interface AvailableDocsetsResult {
  docsets: DocsetSummary[];
  fetchedAt: string;
  fromCache: boolean;
  warnings: string[];
}

export interface DownloadedFile {
  path: string;
  bytes: number;
  sha256: string;
}
