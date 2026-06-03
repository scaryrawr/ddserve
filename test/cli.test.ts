import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson, cachePaths, pathExists, writeCacheManifest } from "../src/cache";
import { runCli } from "../src/cli";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  REDACTED_SECRET,
  defaultConfig,
  parseConfig,
} from "../src/config";
import { DEFAULT_CHUNK_MAX_CHARS, DEFAULT_CHUNK_OVERLAP_CHARS } from "../src/embeddings/chunks";
import type { EmbeddingClient } from "../src/embeddings/openai";
import {
  closeEmbeddingStorage,
  openEmbeddingStorage,
  upsertChunkEmbeddings,
  type EmbeddingChunkInput,
  type EmbeddingStorage,
} from "../src/embeddings/storage";
import type { HttpClient } from "../src/http";
import {
  CACHE_SCHEMA_VERSION,
  DEV_DOCS_SOURCE,
  EXTRACTED_CONTENT_FORMAT,
  type CacheManifestDocset,
  type DevDocsRawDocset,
} from "../src/types";

const testRoot = join(process.cwd(), ".test-work", "cli");

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("runCli", () => {
  test("prints subcommand entries in root help", async () => {
    const output = await captureConsoleHelp(["--help"]);

    expect(output).toContain("sources list");
    expect(output).toContain("docs available");
    expect(output).toContain("docs install <slug>");
    expect(output).toContain("docs remove <slug>");
    expect(output).toContain("cache path");
    expect(output).toContain("embeddings status [slug]");
    expect(output).toContain("config show");
  });

  test("prints entries for grouped subcommand help", async () => {
    const output = await captureConsoleHelp(["docs", "--help"]);

    expect(output).toContain("Subcommands:");
    expect(output).toContain("available");
    expect(output).toContain("installed");
    expect(output).toContain("install <slug>");
    expect(output).toContain("remove <slug>");
    expect(output).toContain("update [slug]");
  });

  test("prints the resolved cache path", async () => {
    const cacheRoot = join(testRoot, "cache-path");
    let output = "";
    await runCli(["--config", join(testRoot, "accepted-config.json"), "cache", "path"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toBe(`${cacheRoot}\n`);
  });

  test("lists installed docsets from cache manifest", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(
      join(cacheRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        docs: {
          http: {
            source: "devdocs",
            slug: "http",
            name: "HTTP",
            type: "http",
            release: "1",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            pageCount: 2,
          },
        },
      }),
    );

    let output = "";
    await runCli(["docs", "installed"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toContain("http");
    expect(output).toContain("HTTP");
  });

  test("prints the resolved config path with CLI paths taking precedence", async () => {
    const envPath = join(testRoot, "env-config.json");
    const cliPath = join(testRoot, "cli-config.json");
    let output = "";

    await runCli(["config", "path", "--config", cliPath], {
      env: { DDSERVE_CONFIG: envPath },
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toBe(`${cliPath}\n`);
  });

  test("prints config JSON metadata with secrets redacted", async () => {
    const configPath = join(testRoot, randomUUID(), "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        openai: {
          apiKeyEnv: "OPENAI_CLI_TEST_KEY",
          apiKey: "literal-secret",
          baseURL: "https://api.example.test/v1",
        },
      }),
      "utf8",
    );

    let output = "";
    await runCli(["config", "show", "--json", "--config", configPath], {
      env: { OPENAI_CLI_TEST_KEY: "env-secret" },
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).not.toContain("literal-secret");
    expect(output).not.toContain("env-secret");
    expect(JSON.parse(output)).toEqual({
      path: configPath,
      found: true,
      config: {
        openai: {
          apiKeyEnv: "OPENAI_CLI_TEST_KEY",
          apiKey: REDACTED_SECRET,
          baseURL: "https://api.example.test/v1",
          embeddingModel: DEFAULT_EMBEDDING_MODEL,
        },
        embeddings: {
          enabled: true,
          batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
          maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
          overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
        },
      },
    });
  });

  test("prints default redacted config when config file is absent", async () => {
    let output = "";
    await runCli(["config", "show", "--config", join(testRoot, randomUUID(), "missing.json")], {
      env: {},
      stdout: (message) => {
        output += message;
      },
    });

    expect(JSON.parse(output)).toEqual({
      embeddings: {
        enabled: false,
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
        overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
      },
    });
  });

  test("uses a config file for docs install embedding refresh without real OpenAI calls", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const configPath = join(testRoot, randomUUID(), "config.json");
    const embeddingCalls: string[][] = [];
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        openai: {
          apiKeyEnv: "DDSERVE_TEST_MISSING_OPENAI_KEY",
          baseURL: "http://localhost:11434/v1",
          embeddingModel: "config-file-model",
        },
        embeddings: {
          enabled: true,
          batchSize: 2,
        },
      }),
      "utf8",
    );

    let installOutput = "";
    await runCli(["--config", configPath, "docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http: createFixtureHttpClient({
        index: "<h1>HTTP</h1><p>Protocol docs.</p>",
        methods: "<h1>Methods</h1><p>GET and POST.</p>",
        headers: "<h1>Headers</h1><p>Content-Type and Accept.</p>",
      }),
      embeddingClient: recordingEmbeddingClient(embeddingCalls),
      stdout: (message) => {
        installOutput += message;
      },
    });

    expect(installOutput).toContain("installed http (3 pages, 0 skipped)");
    expect(embeddingCalls.map((call) => call.length)).toEqual([2, 1]);

    let statusOutput = "";
    await runCli(["--config", configPath, "embeddings", "status", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      stdout: (message) => {
        statusOutput += message;
      },
    });

    const status = JSON.parse(statusOutput);
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.model).toBe("config-file-model");
    expect(status.indexed).toEqual({ docsets: 1, pages: 3, chunks: 3 });
    expect(status.currentChunks).toBe(3);
    expect(status.missingChunks).toBe(0);
  });

  test("removes an installed docset from the CLI", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const http = createFixtureHttpClient();

    await runCli(["docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: defaultConfig(),
      stdout: () => {},
    });

    let output = "";
    await runCli(["docs", "remove", "http", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      now: new Date("2026-01-02T00:00:00Z"),
      stdout: (message) => {
        output += message;
      },
    });

    expect(JSON.parse(output)).toMatchObject({
      slug: "http",
      name: "HTTP",
      pages: 1,
    });
    expect(await pathExists(join(cacheRoot, "docs", "http"))).toBe(false);

    let installedOutput = "";
    await runCli(["docs", "installed"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      stdout: (message) => {
        installedOutput += message;
      },
    });
    expect(installedOutput).toBe("No docsets installed.\n");
  });

  test("prints embedding refresh warnings during docs update", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const http = createFixtureHttpClient();

    await runCli(["docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: defaultConfig(),
      stdout: () => {},
    });

    let stderr = "";
    await runCli(["docs", "update", "http", "--force"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: parseConfig({
        openai: { baseURL: "http://localhost:11434/v1", embeddingModel: "fake-model" },
        embeddings: { enabled: true },
      }),
      embeddingClient: failingEmbeddingClient("embedding down"),
      stdout: () => {},
      stderr: (message) => {
        stderr += message;
      },
    });

    expect(stderr).toContain("Failed to refresh embeddings for http; docs remain installed. embedding down");
  });

  test("prints embeddings status as JSON with missing chunk counts", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const http = createFixtureHttpClient();
    const config = parseConfig({
      openai: { embeddingModel: "fake-model" },
      embeddings: { enabled: true },
    });

    await runCli(["docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: defaultConfig(),
      stdout: () => {},
    });

    let output = "";
    await runCli(["embeddings", "status", "http", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config,
      stdout: (message) => {
        output += message;
      },
    });

    const status = JSON.parse(output);
    expect(status.databasePath).toBe(cachePaths(cacheRoot).embeddingsDb);
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.model).toBe("fake-model");
    expect(status.installed).toEqual({ docsets: 1, pages: 1 });
    expect(status.indexed).toEqual({ docsets: 0, pages: 0, chunks: 0 });
    expect(status.currentChunks).toBe(0);
    expect(status.staleChunks).toBe(0);
    expect(status.missingChunks).toBeGreaterThan(0);
    expect(status.docsets[0]).toMatchObject({
      slug: "http",
      pages: 1,
      indexedPages: 0,
      indexedChunks: 0,
      currentChunks: 0,
      staleChunks: 0,
    });
  });

  test("rebuilds embeddings for installed docsets with an injected client", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const http = createFixtureHttpClient();
    const embeddingCalls: string[][] = [];
    const embeddingClient = recordingEmbeddingClient(embeddingCalls);
    const config = parseConfig({
      openai: { embeddingModel: "fake-model" },
      embeddings: { enabled: true, batchSize: 2 },
    });

    await runCli(["docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: defaultConfig(),
      stdout: () => {},
    });

    let output = "";
    await runCli(["embeddings", "rebuild"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config,
      embeddingClient,
      stdout: (message) => {
        output += message;
      },
      stderr: () => {},
    });

    expect(output).toContain("http");
    expect(output).toContain("refreshed");
    expect(embeddingCalls.length).toBeGreaterThan(0);

    let statusOutput = "";
    await runCli(["embeddings", "status", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config,
      stdout: (message) => {
        statusOutput += message;
      },
    });

    const status = JSON.parse(statusOutput);
    expect(status.indexed.docsets).toBe(1);
    expect(status.indexed.pages).toBe(1);
    expect(status.indexed.chunks).toBeGreaterThan(0);
    expect(status.currentChunks).toBe(status.indexed.chunks);
    expect(status.staleChunks).toBe(0);
    expect(status.missingChunks).toBe(0);
  });

  test("refreshes only missing embeddings without forcing current chunks", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const http = createFixtureHttpClient();
    const firstCalls: string[][] = [];
    const secondCalls: string[][] = [];
    const config = parseConfig({
      openai: { embeddingModel: "fake-model" },
      embeddings: { enabled: true, batchSize: 2 },
    });

    await runCli(["docs", "install", "http"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      http,
      config: defaultConfig(),
      stdout: () => {},
    });

    let firstOutput = "";
    await runCli(["embeddings", "refresh", "http", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config,
      embeddingClient: recordingEmbeddingClient(firstCalls),
      stdout: (message) => {
        firstOutput += message;
      },
    });

    const first = JSON.parse(firstOutput);
    expect(first[0]).toMatchObject({
      slug: "http",
      status: "refreshed",
    });
    expect(first[0].embeddedChunks).toBeGreaterThan(0);
    expect(firstCalls.length).toBeGreaterThan(0);

    let secondOutput = "";
    await runCli(["embeddings", "refresh", "http", "--json"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config,
      embeddingClient: recordingEmbeddingClient(secondCalls),
      stdout: (message) => {
        secondOutput += message;
      },
    });

    const second = JSON.parse(secondOutput);
    expect(second[0]).toMatchObject({
      slug: "http",
      status: "skipped",
      embeddedChunks: 0,
    });
    expect(second[0].skippedChunks).toBe(first[0].chunks);
    expect(secondCalls).toHaveLength(0);
  });

  test("prints semantic search results as JSON with resolved filters and installed file paths", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const fullAlphaText = `hooks state overview ${"full text metadata ".repeat(20)}tail`;
    await seedSearchFixture(cacheRoot, [
      searchDocset("alpha", "Alpha", "library", [
        [0, "alpha-hooks", fullAlphaText, [1, 0]],
        [1, "alpha-routing", "routing details", [0, 1]],
      ]),
      searchDocset("beta", "Beta", "library", [[0, "beta-hooks", "component hooks", [0.8, 0.6]]]),
    ]);

    let output = "";
    await runCli(["search", "--json", "--slug", "alpha", "hooks", "state"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    const json = JSON.parse(output);
    expect(json).toMatchObject({
      query: "hooks state",
      mode: "semantic",
      model: "model-a",
      dimensions: 2,
      resolvedSlugs: ["alpha"],
    });
    expect(json.results).toHaveLength(2);
    expect(json.results[0]).toMatchObject({
      mode: "semantic",
      docsetSlug: "alpha",
      pageId: "alpha-page-0",
      pageName: "Alpha Page 0",
      pagePath: "alpha/page-0",
      pageType: "library",
      pageFilePath: "pages/alpha-page-0.md",
      installedFilePath: join(cachePaths(cacheRoot).docsRoot, "alpha", "pages/alpha-page-0.md"),
      chunkOrdinal: 0,
      chunkContentHash: "alpha-hooks",
      text: fullAlphaText,
    });
    expect(json.results[0].snippet).toContain("hooks state overview");
    expect(json.results[0].snippet.length).toBeLessThan(fullAlphaText.length);
  });

  test("prints semantic search results as XML with escaped text and installed file paths", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const xmlText = "hooks <state> & \"components\" with 'quotes'";
    await seedSearchFixture(cacheRoot, [
      searchDocset("alpha", "Alpha & Friends", "library", [[0, "alpha-hooks", xmlText, [1, 0]]]),
    ]);

    let output = "";
    await runCli(["search", "--format", "xml", "--slug", "alpha", "hooks"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<search>')).toBe(true);
    expect(output).toContain("<query>hooks</query>");
    expect(output).toContain("<mode>semantic</mode>");
    expect(output).toContain("<resolvedSlugs>");
    expect(output).toContain("<slug>alpha</slug>");
    expect(output).toContain('<result rank="1">');
    expect(output).toContain("<docsetName>Alpha &amp; Friends</docsetName>");
    expect(output).toContain("<text>hooks &lt;state&gt; &amp; &quot;components&quot; with &apos;quotes&apos;</text>");
    expect(output).toContain(
      `<installedFilePath>${join(cachePaths(cacheRoot).docsRoot, "alpha", "pages/alpha-page-0.md")}</installedFilePath>`,
    );
    expect(output).not.toContain("<state>");
  });

  test("prints semantic search results as text with snippets and installed file paths", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    await seedSearchFixture(cacheRoot, [
      searchDocset("alpha", "Alpha", "library", [[0, "alpha-hooks", "hooks state overview", [1, 0]]]),
    ]);

    let output = "";
    await runCli(["search", "--limit", "1", "hooks"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toContain('Search results for "hooks" (semantic, model-a)');
    expect(output).toContain("alpha/alpha/page-0");
    expect(output).toContain("[semantic, score 1.000]");
    expect(output).toContain(`File: ${join(cachePaths(cacheRoot).docsRoot, "alpha", "pages/alpha-page-0.md")}`);
    expect(output).toContain("hooks state overview");
  });

  test("search combines repeatable and comma-separated slug/language filters as a union", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    await seedSearchFixture(
      cacheRoot,
      [
        searchDocset("alpha", "Alpha", "library", [[0, "alpha-hooks", "alpha hooks", [1, 0]]]),
        searchDocset("beta", "Beta", "language", [[0, "beta-hooks", "beta hooks", [0.9, 0.1]]]),
        searchDocset("gamma", "Gamma", "library", [[0, "gamma-hooks", "gamma hooks", [1, 0]]]),
      ],
      [
        { slug: "alpha", name: "Alpha", type: "library" },
        { slug: "beta", name: "Beta", type: "language", alias: "ts" },
        { slug: "gamma", name: "Gamma", type: "library" },
      ],
    );

    let output = "";
    await runCli(["search", "--json", "--slug", "alpha,beta", "--language", "ts", "hooks"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    const json = JSON.parse(output);
    expect(json.resolvedSlugs).toEqual(["alpha", "beta"]);
    expect(json.results.map((result: { docsetSlug: string }) => result.docsetSlug)).toEqual(["alpha", "beta"]);
  });

  test("prints keyword fallback search output when semantic vectors are unavailable for the model", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    await seedSearchFixture(cacheRoot, [
      searchDocset("alpha", "Alpha", "library", [[0, "alpha-keyword", "keyword fallback hooks", [1, 0]]]),
    ]);

    let output = "";
    await runCli(["search", "keyword"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-b"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toContain('Search results for "keyword" (keyword, model-b)');
    expect(output).toContain("[keyword, score 1.000]");
    expect(output).toContain("keyword fallback hooks");
  });

  test("prints an empty-results message when search has no matches", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");

    let output = "";
    await runCli(["search", "missing"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toBe('No search results found for "missing" (keyword).\n');
  });

  test("search reports scoped empty results for an installed docset with no indexed vectors", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    await seedSearchFixture(cacheRoot, [searchDocset("beta", "Beta", "library", [])]);

    let output = "";
    await runCli(["search", "--language", "beta", "hooks"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: searchConfig("model-a"),
      embeddingClient: vectorEmbeddingClient([1, 0]),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toBe('No search results found for "hooks" in beta (keyword).\n');
  });

  test("rejects invalid search limits and missing search queries", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");

    await expect(
      runCli(["search", "--limit", "0", "hooks"], {
        env: { DDSERVE_CACHE_DIR: cacheRoot },
        stdout: () => {},
      }),
    ).rejects.toThrow("Invalid --limit: expected a positive integer");

    await expect(
      runCli(["search", "--format", "yaml", "hooks"], {
        env: { DDSERVE_CACHE_DIR: cacheRoot },
        stdout: () => {},
      }),
    ).rejects.toThrow('Invalid --format: expected "text", "json", or "xml"');

    await expect(
      runCli(["search", "--json", "--format", "xml", "hooks"], {
        env: { DDSERVE_CACHE_DIR: cacheRoot },
        stdout: () => {},
      }),
    ).rejects.toThrow('Cannot combine --json with --format other than "json".');

    await expect(
      runCli(["search"], {
        env: { DDSERVE_CACHE_DIR: cacheRoot },
        stdout: () => {},
      }),
    ).rejects.toThrow('Missing search query. Try "ddserve search <query>".');
  });

  test("rejects embeddings rebuild when embeddings are disabled", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");

    await expect(
      runCli(["embeddings", "rebuild"], {
        env: { DDSERVE_CACHE_DIR: cacheRoot },
        config: defaultConfig(),
        stdout: () => {},
      }),
    ).rejects.toThrow("Embeddings are disabled");
  });

  test("prints no installed docsets for enabled embeddings rebuild with an empty cache", async () => {
    const cacheRoot = join(testRoot, randomUUID(), "cache");
    const embeddingCalls: string[][] = [];
    let output = "";

    await runCli(["embeddings", "rebuild"], {
      env: { DDSERVE_CACHE_DIR: cacheRoot },
      config: parseConfig({ openai: { embeddingModel: "fake-model" }, embeddings: { enabled: true } }),
      embeddingClient: recordingEmbeddingClient(embeddingCalls),
      stdout: (message) => {
        output += message;
      },
    });

    expect(output).toBe("No docsets installed.\n");
    expect(embeddingCalls).toHaveLength(0);
  });
});

function failingEmbeddingClient(message: string): EmbeddingClient {
  return {
    async createEmbeddings() {
      throw new Error(message);
    },
  };
}

function recordingEmbeddingClient(calls: string[][]): EmbeddingClient {
  return {
    async createEmbeddings(input) {
      const batch = typeof input === "string" ? [input] : [...input];
      calls.push(batch);
      return batch.map((_, index) => [index + 1, index + 2, index + 3]);
    },
  };
}

function vectorEmbeddingClient(vector: number[]): EmbeddingClient {
  return {
    async createEmbeddings(input) {
      const count = typeof input === "string" ? 1 : input.length;
      return Array.from({ length: count }, () => [...vector]);
    },
  };
}

async function captureConsoleHelp(argv: string[]): Promise<string> {
  const originalInfo = console.info;
  const messages: string[] = [];

  console.info = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await runCli(argv, { env: {} });
  } finally {
    console.info = originalInfo;
  }

  return messages.join("\n");
}

function searchConfig(model: string) {
  return parseConfig({
    openai: { embeddingModel: model },
    embeddings: { enabled: true },
  });
}

interface SearchFixtureDocset {
  slug: string;
  name: string;
  type: string;
  chunks: Array<[ordinal: number, contentHash: string, text: string, vector: readonly number[]]>;
}

function searchDocset(
  slug: string,
  name: string,
  type: string,
  chunks: SearchFixtureDocset["chunks"],
): SearchFixtureDocset {
  return { slug, name, type, chunks };
}

async function seedSearchFixture(
  cacheRoot: string,
  docsets: SearchFixtureDocset[],
  sourceDocsets: DevDocsRawDocset[] = docsets.map(({ slug, name, type }) => ({ slug, name, type })),
): Promise<void> {
  await writeCacheManifest(cacheRoot, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: Object.fromEntries(docsets.map((docset) => [docset.slug, installedSearchDocset(docset)])),
  });
  await atomicWriteJson(cachePaths(cacheRoot).devdocsSourceIndex, {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    url: "https://devdocs.io/docs.json",
    docsets: sourceDocsets,
  });

  const storage = await openEmbeddingStorage(cacheRoot);
  try {
    for (const docset of docsets) {
      upsertSearchDocset(storage, docset);
    }
  } finally {
    closeEmbeddingStorage(storage);
  }
}

function installedSearchDocset(docset: SearchFixtureDocset): CacheManifestDocset {
  return {
    source: DEV_DOCS_SOURCE,
    slug: docset.slug,
    name: docset.name,
    type: docset.type,
    contentFormat: EXTRACTED_CONTENT_FORMAT,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: docset.chunks.length,
  };
}

function upsertSearchDocset(storage: EmbeddingStorage, docset: SearchFixtureDocset): void {
  if (docset.chunks.length === 0) {
    return;
  }

  upsertChunkEmbeddings(storage, {
    docset: { slug: docset.slug, name: docset.name },
    model: "model-a",
    dimensions: docset.chunks[0]?.[3].length ?? 2,
    indexedAt: "2026-01-01T00:00:00.000Z",
    chunks: docset.chunks.map(([ordinal, contentHash, text, vector]) => searchChunk(docset, ordinal, contentHash, text, vector)),
  });
}

function searchChunk(
  docset: SearchFixtureDocset,
  ordinal: number,
  contentHash: string,
  text: string,
  vector: readonly number[],
): EmbeddingChunkInput {
  return {
    page: {
      id: `${docset.slug}-page-${ordinal}`,
      filePath: `pages/${docset.slug}-page-${ordinal}.md`,
      title: `${docset.name} Page ${ordinal}`,
      name: `${docset.name} Page ${ordinal}`,
      path: `${docset.slug}/page-${ordinal}`,
      type: docset.type,
      contentHash: `${docset.slug}-page-hash-${ordinal}`,
    },
    ordinal: 0,
    contentHash,
    text,
    vector,
    sourceHash: `${docset.slug}-page-hash-${ordinal}`,
  };
}

function createFixtureHttpClient(pages: Record<string, string> = { index: "<h1>HTTP</h1><p>Protocol docs.</p>" }): HttpClient {
  const fixtures: Record<string, unknown> = {
    "https://devdocs.io/docs.json": [{ name: "HTTP", slug: "http", type: "http", release: "1", mtime: 10 }],
    "https://documents.devdocs.io/http/index.json": {
      entries: Object.keys(pages).map((path) => ({ name: pageName(path), path, type: "HTTP" })),
    },
    "https://documents.devdocs.io/http/db.json": pages,
  };

  return {
    async fetchJson<T>(url: string): Promise<T> {
      if (!(url in fixtures)) {
        throw new Error(`Missing fixture for ${url}`);
      }
      return fixtures[url] as T;
    },
    async downloadFile(url: string, destination: string) {
      if (!(url in fixtures)) {
        throw new Error(`Missing fixture for ${url}`);
      }
      const body = `${JSON.stringify(fixtures[url])}\n`;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body, "utf8");
      return {
        path: destination,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    },
  };
}

function pageName(path: string): string {
  if (path === "index") {
    return "HTTP Overview";
  }
  return path
    .split("/")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
