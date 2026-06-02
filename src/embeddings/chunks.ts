import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { assertSafePathSegment, cachePaths } from "../cache";
import { DdserveError, getErrorMessage, isNodeError } from "../errors";
import type { DocsetManifest, PageManifestEntry } from "../types";
import { removeUnpairedSurrogates } from "../unicode";
import type { EmbeddingChunkInput, EmbeddingDocsetInput, EmbeddingPageInput } from "./storage";

export const DEFAULT_CHUNK_MAX_CHARS = 2_400;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 200;

export type PreparedEmbeddingChunk = Omit<EmbeddingChunkInput, "vector">;

export interface ChunkMarkdownPagesOptions {
  cacheRoot: string;
  slug?: string;
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface ChunkedMarkdownPages {
  docset: EmbeddingDocsetInput;
  chunks: PreparedEmbeddingChunk[];
}

interface NormalizedChunkOptions {
  maxChunkChars: number;
  overlapChars: number;
}

export async function chunkMarkdownPages(
  manifest: DocsetManifest,
  options: ChunkMarkdownPagesOptions,
): Promise<ChunkedMarkdownPages> {
  const slug = options.slug ?? manifest.slug;
  assertSafePathSegment(slug, "docset slug");
  if (slug !== manifest.slug) {
    throw new DdserveError(`Manifest slug "${manifest.slug}" does not match docset slug "${slug}"`);
  }

  const chunkOptions = normalizeChunkOptions(options);
  const chunks: PreparedEmbeddingChunk[] = [];
  const seenPageBodyHashes = new Set<string>();

  for (const page of manifest.pages) {
    const markdown = await readInstalledPageMarkdown(options.cacheRoot, slug, page);
    const sourceText = normalizeMarkdownText(markdown);
    const bodyHash = hashPageContent(stripGeneratedPageHeader(sourceText));
    if (seenPageBodyHashes.has(bodyHash)) {
      continue;
    }
    seenPageBodyHashes.add(bodyHash);

    const sourceHash = hashPageContent(sourceText);
    const bodyChunks = splitMarkdownIntoChunks(sourceText, chunkOptions);
    const pageInput = sourcePageIdentity(page, sourceHash);

    bodyChunks.forEach((body, ordinal) => {
      const text = normalizeMarkdownText(formatChunkText(manifest, page, body));
      chunks.push({
        page: pageInput,
        ordinal,
        contentHash: hashChunkContent(text),
        sourceHash,
        text,
        tokenCount: estimateTokenCount(text),
        metadataJson: chunkMetadataJson(manifest, page, ordinal),
      });
    });
  }

  return {
    docset: docsetEmbeddingInput(manifest),
    chunks,
  };
}

export async function readInstalledPageMarkdown(
  cacheRoot: string,
  slug: string,
  page: PageManifestEntry,
): Promise<string> {
  const pagePath = resolveInstalledPagePath(cacheRoot, slug, page.file);
  const file = Bun.file(pagePath);

  if (!(await file.exists())) {
    throw new DdserveError(`Missing Markdown page file for docset "${slug}" page "${page.id}": ${page.file}`);
  }

  try {
    return await file.text();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new DdserveError(`Missing Markdown page file for docset "${slug}" page "${page.id}": ${page.file}`, {
        cause: error,
      });
    }
    throw new DdserveError(`Failed to read Markdown page file ${page.file}: ${getErrorMessage(error)}`, { cause: error });
  }
}

export function splitMarkdownIntoChunks(
  markdown: string,
  options: Partial<NormalizedChunkOptions> = {},
): string[] {
  const { maxChunkChars, overlapChars } = normalizeChunkOptions(options);
  const text = normalizeMarkdownText(markdown);
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= text.length) {
      break;
    }

    const end = text.length - cursor <= maxChunkChars ? text.length : findChunkEnd(text, cursor, maxChunkChars);
    const chunk = normalizeMarkdownText(text.slice(cursor, end));
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    const nextCursor = overlapChars > 0 ? Math.max(cursor + 1, end - overlapChars) : end;
    cursor = nextCursor <= cursor ? end : nextCursor;
  }

  return chunks;
}

export function sourcePageIdentity(page: PageManifestEntry, contentHash?: string): EmbeddingPageInput {
  return {
    id: page.id,
    filePath: page.file,
    title: page.name,
    name: page.name,
    path: page.path,
    type: page.type,
    contentHash,
  };
}

export function docsetEmbeddingInput(manifest: DocsetManifest): EmbeddingDocsetInput {
  return {
    slug: manifest.slug,
    name: manifest.name,
    source: manifest.source,
    version: manifest.version,
    release: manifest.release,
    mtime: manifest.mtime,
    dbSize: manifest.dbSize,
    contentFormat: manifest.contentFormat,
    installedAt: manifest.installedAt,
    manifestUpdatedAt: manifest.updatedAt,
  };
}

export function hashPageContent(text: string): string {
  return hashTextContent(normalizeMarkdownText(text));
}

export function hashChunkContent(text: string): string {
  return hashTextContent(normalizeMarkdownText(text));
}

export function hashTextContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizeMarkdownText(text: string): string {
  return removeUnpairedSurrogates(normalizeLineEndings(text)).trim();
}

export function estimateTokenCount(text: string): number {
  const normalized = normalizeMarkdownText(text);
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function resolveInstalledPagePath(cacheRoot: string, slug: string, pageFile: string): string {
  assertSafePathSegment(slug, "docset slug");
  const docsetRoot = resolve(cachePaths(cacheRoot).docsRoot, slug);
  const pagePath = resolve(docsetRoot, pageFile);
  const pagePathRelative = relative(docsetRoot, pagePath);

  if (pagePathRelative.startsWith("..") || isAbsolute(pagePathRelative)) {
    throw new DdserveError(`Invalid Markdown page file path for docset "${slug}": ${pageFile}`);
  }

  return pagePath;
}

function formatChunkText(manifest: DocsetManifest, page: PageManifestEntry, body: string): string {
  const metadata = [`Docset: ${manifest.name} (${manifest.slug})`, `Page: ${page.name}`, `Path: ${page.path}`];
  if (page.type) {
    metadata.push(`Type: ${page.type}`);
  }

  return `${metadata.join("\n")}\n\n${body.trim()}`.trim();
}

function chunkMetadataJson(manifest: DocsetManifest, page: PageManifestEntry, ordinal: number): string {
  return JSON.stringify({
    docsetSlug: manifest.slug,
    docsetName: manifest.name,
    pageId: page.id,
    pageName: page.name,
    pagePath: page.path,
    pageType: page.type ?? null,
    pageFile: page.file,
    chunkOrdinal: ordinal,
  });
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function stripGeneratedPageHeader(text: string): string {
  return normalizeMarkdownText(text).replace(/^# .+\n\n> DevDocs path: .+\n\n/s, "");
}

function normalizeChunkOptions(options: Partial<NormalizedChunkOptions>): NormalizedChunkOptions {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_CHUNK_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;

  if (!Number.isInteger(maxChunkChars) || maxChunkChars <= 0) {
    throw new DdserveError("Invalid max chunk size: expected a positive integer");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new DdserveError("Invalid chunk overlap: expected a non-negative integer");
  }
  if (overlapChars >= maxChunkChars) {
    throw new DdserveError("Invalid chunk overlap: must be smaller than max chunk size");
  }

  return { maxChunkChars, overlapChars };
}

function findChunkEnd(text: string, cursor: number, maxChunkChars: number): number {
  const desiredEnd = Math.min(text.length, cursor + maxChunkChars);
  const minEnd = cursor + Math.floor(maxChunkChars * 0.5);

  const paragraphBreak = text.lastIndexOf("\n\n", desiredEnd);
  if (paragraphBreak >= minEnd) {
    return paragraphBreak + 2;
  }

  const headingBreak = text.slice(cursor, desiredEnd).lastIndexOf("\n#");
  if (headingBreak >= 0) {
    const absoluteHeadingBreak = cursor + headingBreak;
    if (absoluteHeadingBreak >= minEnd) {
      return absoluteHeadingBreak;
    }
  }

  const sentenceBreak = findLastSentenceBreak(text, cursor, desiredEnd);
  if (sentenceBreak >= minEnd) {
    return sentenceBreak;
  }

  const lineBreak = text.lastIndexOf("\n", desiredEnd);
  if (lineBreak >= minEnd) {
    return lineBreak + 1;
  }

  const spaceBreak = text.lastIndexOf(" ", desiredEnd);
  if (spaceBreak >= minEnd) {
    return spaceBreak + 1;
  }

  return desiredEnd;
}

function findLastSentenceBreak(text: string, cursor: number, desiredEnd: number): number {
  let lastBreak = -1;
  const sentenceBreaks = /[.!?][)\]"'`]*\s+/g;
  sentenceBreaks.lastIndex = cursor;

  for (;;) {
    const match = sentenceBreaks.exec(text);
    if (!match || match.index >= desiredEnd) {
      break;
    }
    lastBreak = match.index + match[0].length;
  }

  return lastBreak;
}
