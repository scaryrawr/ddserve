import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  acquireDocsetLock,
  assertSafePathSegment,
  atomicWriteJson,
  cachePaths,
  ensureCacheRoot,
  readCacheManifest,
  readDocsetManifest,
  replaceDirectory,
  writeCacheManifest,
} from "./cache";
import { loadConfig, type DdserveConfig } from "./config";
import { docsetDbUrl, docsetIndexUrl, DEV_DOCS_INDEX_URL, findDocset, getAvailableDocsets } from "./devdocs";
import { refreshDocsetEmbeddings } from "./embeddings";
import type { EmbeddingClient } from "./embeddings/openai";
import { DdserveError, getErrorMessage } from "./errors";
import { FetchHttpClient, type HttpClient } from "./http";
import { extractMarkdownPages } from "./text";
import {
  CACHE_SCHEMA_VERSION,
  DEV_DOCS_SOURCE,
  EXTRACTED_CONTENT_FORMAT,
  EXTRACTOR_VERSION,
  type DocsetManifest,
  type DevDocsIndex,
  type DocsetSummary,
  type RawFileManifestEntry,
} from "./types";

export interface InstallOptions {
  cacheRoot: string;
  http?: HttpClient;
  force?: boolean;
  offline?: boolean;
  now?: Date;
  configPath?: string;
  config?: DdserveConfig;
  env?: NodeJS.ProcessEnv;
  embeddingClient?: EmbeddingClient;
}

export interface InstallResult {
  slug: string;
  name: string;
  status: "installed" | "updated" | "skipped";
  pages: number;
  skippedEntries: number;
  warnings: string[];
}

export async function installDocset(slug: string, options: InstallOptions): Promise<InstallResult> {
  assertSafePathSegment(slug, "docset slug");
  const paths = await ensureCacheRoot(options.cacheRoot);
  const available = await getAvailableDocsets({
    cacheRoot: options.cacheRoot,
    http: options.http,
    offline: options.offline,
    now: options.now,
  });
  const summary = findDocset(available.docsets, slug);
  if (!summary) {
    throw new DdserveError(`Unknown DevDocs docset "${slug}". Run "ddserve docs available" to list valid slugs.`);
  }
  const config = await resolveInstallConfig(options);

  const existing = await readDocsetManifest(options.cacheRoot, slug);
  if (!options.force && isCurrent(existing, summary)) {
    const warnings = [...available.warnings];
    await refreshEmbeddingsForInstalledDocset(existing, options, config, warnings);
    return {
      slug,
      name: summary.name,
      status: "skipped",
      pages: existing.pages.length,
      skippedEntries: existing.skippedEntries,
      warnings,
    };
  }

  const lock = await acquireDocsetLock(options.cacheRoot, slug);
  try {
    const stageDir = join(paths.docsRoot, `${slug}.partial-${process.pid}-${Date.now()}`);
    const rawDir = join(stageDir, "raw");
    const pagesDir = join(stageDir, "pages");
    await Promise.all([mkdir(rawDir, { recursive: true }), mkdir(pagesDir, { recursive: true })]);

    const http = options.http ?? new FetchHttpClient();
    const indexUrl = docsetIndexUrl(slug);
    const dbUrl = docsetDbUrl(slug);
    const rawFiles: RawFileManifestEntry[] = [];

    await atomicWriteJson(join(rawDir, "docset.json"), summary);
    rawFiles.push(await fileManifestEntry(join(rawDir, "docset.json")));

    const downloadedIndex = await http.downloadFile(indexUrl, join(rawDir, "index.json"));
    rawFiles.push({ file: "raw/index.json", url: indexUrl, bytes: downloadedIndex.bytes, sha256: downloadedIndex.sha256 });

    const downloadedDb = await http.downloadFile(dbUrl, join(rawDir, "db.json"));
    rawFiles.push({ file: "raw/db.json", url: dbUrl, bytes: downloadedDb.bytes, sha256: downloadedDb.sha256 });

    const index = JSON.parse(await readFile(join(rawDir, "index.json"), "utf8")) as DevDocsIndex;
    const db = JSON.parse(await readFile(join(rawDir, "db.json"), "utf8")) as Record<string, string>;
    const extracted = await extractMarkdownPages(index, db, pagesDir);

    if (extracted.pages.length === 0) {
      throw new DdserveError(`Downloaded "${slug}", but no pages could be extracted`);
    }

    const now = (options.now ?? new Date()).toISOString();
    const installedAt = existing?.installedAt ?? now;
    const manifest: DocsetManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      contentFormat: EXTRACTED_CONTENT_FORMAT,
      source: DEV_DOCS_SOURCE,
      status: "installed",
      slug: summary.slug,
      name: summary.name,
      type: summary.type,
      version: summary.version,
      release: summary.release,
      mtime: summary.mtime,
      dbSize: summary.dbSize,
      installedAt,
      updatedAt: now,
      upstream: {
        docsIndexUrl: DEV_DOCS_INDEX_URL,
        indexUrl,
        dbUrl,
      },
      rawFiles,
      pages: extracted.pages,
      skippedEntries: extracted.skippedEntries,
    };

    await atomicWriteJson(join(stageDir, "manifest.json"), manifest);
    await replaceDirectory(stageDir, join(paths.docsRoot, slug));
    await updateTopLevelManifest(options.cacheRoot, manifest);
    const warnings = [...available.warnings];
    await refreshEmbeddingsForInstalledDocset(manifest, options, config, warnings);

    return {
      slug,
      name: summary.name,
      status: existing ? "updated" : "installed",
      pages: extracted.pages.length,
      skippedEntries: extracted.skippedEntries,
      warnings,
    };
  } finally {
    await lock.release();
  }
}

export interface UpdateProgressEvent {
  slug: string;
  index: number;
  total: number;
  phase: "start" | "done";
  result?: InstallResult;
}

export interface UpdateOptions extends InstallOptions {
  onProgress?: (event: UpdateProgressEvent) => void;
}

export async function updateDocsets(slug: string | undefined, options: UpdateOptions): Promise<InstallResult[]> {
  if (slug) {
    options.onProgress?.({ slug, index: 1, total: 1, phase: "start" });
    const result = await installDocset(slug, options);
    options.onProgress?.({ slug, index: 1, total: 1, phase: "done", result });
    return [result];
  }

  const manifest = await readCacheManifest(options.cacheRoot);
  const slugs = Object.keys(manifest.docs).sort();
  if (slugs.length === 0) {
    return [];
  }

  const results: InstallResult[] = [];
  for (const [index, installedSlug] of slugs.entries()) {
    const progress = { slug: installedSlug, index: index + 1, total: slugs.length };
    options.onProgress?.({ ...progress, phase: "start" });
    const result = await installDocset(installedSlug, options);
    options.onProgress?.({ ...progress, phase: "done", result });
    results.push(result);
  }
  return results;
}

function isCurrent(existing: DocsetManifest | undefined, summary: DocsetSummary): existing is DocsetManifest {
  if (!existing) {
    return false;
  }

  if (existing.extractorVersion < EXTRACTOR_VERSION) {
    return false;
  }

  if (existing.contentFormat !== EXTRACTED_CONTENT_FORMAT) {
    return false;
  }

  if (typeof summary.mtime === "number" && typeof existing.mtime === "number") {
    return existing.mtime >= summary.mtime;
  }

  return existing.release === summary.release && existing.version === summary.version;
}

async function resolveInstallConfig(options: InstallOptions): Promise<DdserveConfig> {
  if (options.config) {
    return options.config;
  }
  return (await loadConfig({ configPath: options.configPath, env: options.env })).config;
}

async function refreshEmbeddingsForInstalledDocset(
  manifest: DocsetManifest,
  options: InstallOptions,
  config: DdserveConfig,
  warnings: string[],
): Promise<void> {
  try {
    await refreshDocsetEmbeddings({
      cacheRoot: options.cacheRoot,
      manifest,
      config,
      env: options.env,
      client: options.embeddingClient,
      now: options.now,
    });
  } catch (error) {
    warnings.push(
      `Failed to refresh embeddings for ${manifest.slug}; docs remain installed. ${getErrorMessage(error)}`,
    );
  }
}

async function fileManifestEntry(filePath: string): Promise<RawFileManifestEntry> {
  const file = Bun.file(filePath);
  const bytes = (await stat(filePath)).size;
  const sha256 = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  return {
    file: "raw/docset.json",
    bytes,
    sha256,
  };
}

async function updateTopLevelManifest(cacheRoot: string, docset: DocsetManifest): Promise<void> {
  const manifest = await readCacheManifest(cacheRoot);
  manifest.updatedAt = docset.updatedAt;
  manifest.docs[docset.slug] = {
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
    pageCount: docset.pages.length,
  };
  await writeCacheManifest(cacheRoot, manifest);
}

export async function cleanupPartialDocsetDirs(cacheRoot: string): Promise<void> {
  const docsRoot = cachePaths(cacheRoot).docsRoot;
  try {
    const glob = new Bun.Glob("*.partial-*");
    for await (const partial of glob.scan({ cwd: docsRoot, onlyFiles: false })) {
      await rm(join(docsRoot, partial), { recursive: true, force: true });
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
}
