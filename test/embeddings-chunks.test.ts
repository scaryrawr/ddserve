import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  chunkMarkdownPages,
  hashChunkContent,
  hashPageContent,
  normalizeMarkdownText,
  splitMarkdownIntoChunks,
} from "../src/embeddings/chunks";
import { DdserveError } from "../src/errors";
import type { DocsetManifest, PageManifestEntry } from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("chunkMarkdownPages", () => {
  test("creates deterministic chunk records with page identities and stable hashes", async () => {
    const markdown = "# HTTP Overview\r\n\r\nProtocol docs.\r\n\r\n## Methods\r\n\r\nGET and POST.";
    const { cacheRoot, manifest } = await createFixtureDocset({
      pages: [{ page: pageEntry(), markdown }],
    });

    const first = await chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 1_000, overlapChars: 0 });
    const second = await chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 1_000, overlapChars: 0 });

    expect(first).toEqual(second);
    expect(first.docset).toMatchObject({
      slug: "http",
      name: "HTTP",
      contentFormat: "markdown",
      manifestUpdatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(first.chunks).toHaveLength(1);

    const chunk = first.chunks[0]!;
    expect(chunk.page).toEqual({
      id: "overview",
      filePath: "pages/overview.md",
      title: "HTTP Overview",
      name: "HTTP Overview",
      path: "index",
      type: "Guide",
      contentHash: hashPageContent(markdown),
    });
    expect(chunk.ordinal).toBe(0);
    expect(chunk.sourceHash).toBe(hashPageContent(markdown));
    expect(chunk.contentHash).toBe(hashChunkContent(chunk.text));
    expect(chunk.text).toContain("Docset: HTTP (http)");
    expect(chunk.text).toContain("Page: HTTP Overview");
    expect(chunk.text).toContain("Path: index");
    expect(JSON.parse(chunk.metadataJson ?? "{}")).toEqual({
      docsetSlug: "http",
      docsetName: "HTTP",
      pageId: "overview",
      pageName: "HTTP Overview",
      pagePath: "index",
      pageType: "Guide",
      pageFile: "pages/overview.md",
      chunkOrdinal: 0,
    });
  });

  test("splits long Markdown into stable multi-chunk page ordinals", async () => {
    const markdown = Array.from({ length: 12 }, (_, index) =>
      `## Section ${index}\n\nThis section contains enough text to require deterministic chunk splitting for embeddings.`,
    ).join("\n\n");
    const { cacheRoot, manifest } = await createFixtureDocset({
      pages: [{ page: pageEntry(), markdown }],
    });

    const result = await chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 180, overlapChars: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.ordinal)).toEqual(result.chunks.map((_, index) => index));
    expect(result.chunks.every((chunk) => chunk.text.includes("Docset: HTTP (http)"))).toBe(true);
    expect(result.chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
  });

  test("omits empty and whitespace-only page chunks", async () => {
    const { cacheRoot, manifest } = await createFixtureDocset({
      pages: [{ page: pageEntry(), markdown: " \n\t \r\n" }],
    });

    expect(splitMarkdownIntoChunks(" \n\t \r\n", { maxChunkChars: 50, overlapChars: 0 })).toEqual([]);
    await expect(chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 50, overlapChars: 0 })).resolves.toEqual({
      docset: expect.objectContaining({ slug: "http" }),
      chunks: [],
    });
  });

  test("throws a DdserveError for missing Markdown page files", async () => {
    const cacheRoot = await createTempCacheRoot();
    const manifest = manifestWithPages([pageEntry({ file: "pages/missing.md" })]);

    await expect(chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 50, overlapChars: 0 })).rejects.toThrow(
      DdserveError,
    );
    await expect(chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 50, overlapChars: 0 })).rejects.toThrow(
      'Missing Markdown page file for docset "http" page "overview": pages/missing.md',
    );
  });

  test("embeds each DevDocs source document once when anchor entries duplicate full pages", async () => {
    const { cacheRoot, manifest } = await createFixtureDocset({
      pages: [
        {
          page: pageEntry({
            id: "overview",
            name: "HTTP Overview",
            path: "index",
            file: "pages/overview.md",
            sourceKey: "index",
          }),
          markdown: "# HTTP Overview\n\n> DevDocs path: index\n\nProtocol docs.",
        },
        {
          page: pageEntry({
            id: "overview-method-get",
            name: "HTTP Overview::GET",
            path: "index#method.get",
            file: "pages/overview-method-get.md",
            sourceKey: "index",
          }),
          markdown: "# HTTP Overview::GET\n\n> DevDocs path: index#method.get\n\nProtocol docs.",
        },
      ],
    });

    const result = await chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 1_000, overlapChars: 0 });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.page.id).toBe("overview");
  });

  test("embeds distinct anchor sections from the same DevDocs source document", async () => {
    const { cacheRoot, manifest } = await createFixtureDocset({
      pages: [
        {
          page: pageEntry({
            id: "overview",
            name: "HTTP Overview",
            path: "index",
            file: "pages/overview.md",
            sourceKey: "index",
          }),
          markdown: "# HTTP Overview\n\n> DevDocs path: index\n\nProtocol docs.",
        },
        {
          page: pageEntry({
            id: "overview-method-get",
            name: "HTTP Overview::GET",
            path: "index#method.get",
            file: "pages/overview-method-get.md",
            sourceKey: "index",
          }),
          markdown: "# HTTP Overview::GET\n\n> DevDocs path: index#method.get\n\nGET-specific protocol docs.",
        },
      ],
    });

    const result = await chunkMarkdownPages(manifest, { cacheRoot, maxChunkChars: 1_000, overlapChars: 0 });

    expect(result.chunks.map((chunk) => chunk.page.id)).toEqual(["overview", "overview-method-get"]);
  });
});

describe("splitMarkdownIntoChunks", () => {
  test("honors max size and overlap deterministically", () => {
    const markdown = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const chunks = splitMarkdownIntoChunks(markdown, { maxChunkChars: 25, overlapChars: 5 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 25)).toBe(true);
    expect(chunks).toEqual(splitMarkdownIntoChunks(markdown, { maxChunkChars: 25, overlapChars: 5 }));
  });

  test("does not emit unpaired surrogates when chunk boundaries split emoji", () => {
    const chunks = splitMarkdownIntoChunks(`${"a".repeat(49)}🔬 docs`, { maxChunkChars: 50, overlapChars: 0 });

    expect(chunks.join("")).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe("normalizeMarkdownText", () => {
  test("removes unpaired surrogate code units while preserving valid emoji pairs", () => {
    expect(normalizeMarkdownText("\uDD2CThis is malformed, but 🔬 is valid.\uD83D")).toBe(
      "This is malformed, but 🔬 is valid.",
    );
  });
});

async function createFixtureDocset(input: {
  pages: Array<{ page: PageManifestEntry; markdown: string }>;
}): Promise<{ cacheRoot: string; manifest: DocsetManifest }> {
  const cacheRoot = await createTempCacheRoot();
  const docsetRoot = join(cacheRoot, "docs", "http");
  await mkdir(docsetRoot, { recursive: true });

  for (const { page, markdown } of input.pages) {
    await Bun.write(join(docsetRoot, page.file), markdown);
  }

  return {
    cacheRoot,
    manifest: manifestWithPages(input.pages.map(({ page }) => page)),
  };
}

async function createTempCacheRoot(): Promise<string> {
  const root = join(import.meta.dir, ".tmp", `embeddings-chunks-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function pageEntry(overrides: Partial<PageManifestEntry> = {}): PageManifestEntry {
  return {
    id: "overview",
    name: "HTTP Overview",
    path: "index",
    type: "Guide",
    file: "pages/overview.md",
    format: "markdown",
    sourceKey: "index",
    ...overrides,
  };
}

function manifestWithPages(pages: PageManifestEntry[]): DocsetManifest {
  return {
    schemaVersion: 1,
    extractorVersion: 4,
    contentFormat: "markdown",
    source: "devdocs",
    status: "installed",
    slug: "http",
    name: "HTTP",
    type: "http",
    version: "1",
    release: "2026-01-01",
    mtime: 1,
    dbSize: 10,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    upstream: {
      docsIndexUrl: "https://devdocs.io/docs.json",
      indexUrl: "https://documents.devdocs.io/http/index.json",
      dbUrl: "https://documents.devdocs.io/http/db.json",
    },
    rawFiles: [],
    pages,
    skippedEntries: 0,
  };
}
