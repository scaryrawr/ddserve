import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson, cachePaths, writeCacheManifest } from "../src/cache";
import { DdserveError } from "../src/errors";
import { parseSearchFilterValues, resolveSearchFilterSlugs } from "../src/search/filters";
import {
  CACHE_SCHEMA_VERSION,
  DEV_DOCS_SOURCE,
  EXTRACTED_CONTENT_FORMAT,
  type CacheManifestDocset,
  type DevDocsRawDocset,
} from "../src/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseSearchFilterValues", () => {
  test("parses repeated and comma-separated values", () => {
    expect(parseSearchFilterValues([" react, typescript ", " bun,,node "], "--slug")).toEqual([
      "react",
      "typescript",
      "bun",
      "node",
    ]);
  });

  test("rejects provided filters with no usable values", () => {
    expect(() => parseSearchFilterValues(" , , ", "--language")).toThrow(DdserveError);
  });
});

describe("resolveSearchFilterSlugs", () => {
  test("returns undefined for broad search when no filters are provided", async () => {
    const cacheRoot = await createTempCacheRoot("broad");
    await writeInstalledDocsets(cacheRoot, [installedDocset("react", "React", "library")]);

    await expect(resolveSearchFilterSlugs({ cacheRoot })).resolves.toBeUndefined();
  });

  test("resolves --slug only by exact installed docset slug", async () => {
    const cacheRoot = await createTempCacheRoot("slug");
    await writeInstalledDocsets(cacheRoot, [installedDocset("react", "React", "library")]);

    await expect(resolveSearchFilterSlugs({ cacheRoot, slug: "react" })).resolves.toEqual(["react"]);
    await expect(resolveSearchFilterSlugs({ cacheRoot, slug: "React" })).rejects.toThrow(
      /Unknown --slug filter "React"/,
    );
  });

  test("resolves --language by installed slug, name, type, and cached aliases", async () => {
    const cacheRoot = await createTempCacheRoot("language");
    await writeInstalledDocsets(cacheRoot, [
      installedDocset("react", "React", "library"),
      installedDocset("typescript", "TypeScript", "language"),
      installedDocset("bun", "Bun", "runtime"),
    ]);
    await writeSourceIndex(cacheRoot, [
      { slug: "react", name: "React", type: "library", alias: ["reactjs"] },
      { slug: "typescript", name: "TypeScript", type: "language", alias: "ts" },
      { slug: "bun", name: "Bun", type: "runtime", alias: ["bun.sh"] },
    ]);

    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "REACT" })).resolves.toEqual(["react"]);
    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "typescript" })).resolves.toEqual(["typescript"]);
    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "library" })).resolves.toEqual(["react"]);
    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "TS" })).resolves.toEqual(["typescript"]);
  });

  test("combines repeated slug and language filters as a stable de-duplicated union", async () => {
    const cacheRoot = await createTempCacheRoot("union");
    await writeInstalledDocsets(cacheRoot, [
      installedDocset("react", "React", "library"),
      installedDocset("typescript", "TypeScript", "language"),
      installedDocset("bun", "Bun", "runtime"),
    ]);
    await writeSourceIndex(cacheRoot, [
      { slug: "react", name: "React", alias: "reactjs" },
      { slug: "typescript", name: "TypeScript", alias: "ts" },
      { slug: "bun", name: "Bun", alias: "bun.sh" },
    ]);

    await expect(
      resolveSearchFilterSlugs({
        cacheRoot,
        slug: ["react, typescript", "react"],
        language: ["ts", "bun.sh,reactjs"],
      }),
    ).resolves.toEqual(["react", "typescript", "bun"]);
  });

  test("reports ambiguous language filters with candidates", async () => {
    const cacheRoot = await createTempCacheRoot("ambiguous");
    await writeInstalledDocsets(cacheRoot, [
      installedDocset("bun", "Bun", "runtime"),
      installedDocset("node", "Node.js", "runtime"),
    ]);

    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "runtime" })).rejects.toThrow(
      /Ambiguous --language filter "runtime"; matches multiple installed docsets: bun \(Bun\), node \(Node\.js\)/,
    );
  });

  test("reports unknown language filters with installed slug suggestions", async () => {
    const cacheRoot = await createTempCacheRoot("unknown");
    await writeInstalledDocsets(cacheRoot, [
      installedDocset("react", "React", "library"),
      installedDocset("typescript", "TypeScript", "language"),
    ]);

    await expect(resolveSearchFilterSlugs({ cacheRoot, language: "python" })).rejects.toThrow(
      /Unknown --language filter "python".*Installed slugs: react, typescript/s,
    );
  });
});

async function createTempCacheRoot(prefix: string): Promise<string> {
  const root = join(process.cwd(), ".test-work", "search-filters", `${prefix}-${process.pid}-${Date.now()}-${tempRoots.length}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

async function writeInstalledDocsets(cacheRoot: string, docsets: CacheManifestDocset[]): Promise<void> {
  await writeCacheManifest(cacheRoot, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: Object.fromEntries(docsets.map((docset) => [docset.slug, docset])),
  });
}

async function writeSourceIndex(cacheRoot: string, docsets: DevDocsRawDocset[]): Promise<void> {
  await atomicWriteJson(cachePaths(cacheRoot).devdocsSourceIndex, {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    url: "https://devdocs.io/docs.json",
    docsets,
  });
}

function installedDocset(slug: string, name: string, type: string): CacheManifestDocset {
  return {
    source: DEV_DOCS_SOURCE,
    slug,
    name,
    type,
    contentFormat: EXTRACTED_CONTENT_FORMAT,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: 1,
  };
}
