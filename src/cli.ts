import { cac, type CAC } from "cac";
import { isAbsolute, join } from "node:path";

import { cachePaths, ensureCacheRoot, readCacheManifest, resolveCacheRoot } from "./cache";
import { loadConfig, redactConfig, resolveConfigPath, type DdserveConfig } from "./config";
import { DdserveError } from "./errors";
import { formatBytes, formatTable } from "./format";
import { getAvailableDocsets } from "./devdocs";
import { installDocset, updateDocsets } from "./install";
import { getEmbeddingsStatus, rebuildEmbeddings, refreshEmbeddings, type EmbeddingsStatusResult } from "./embeddings";
import type { EmbeddingClient } from "./embeddings/openai";
import type { HttpClient } from "./http";
import { search as searchDocs, type SearchResponse, type SearchResult } from "./search";
import { resolveSearchFilterSlugs, type SearchFilterOptionValues } from "./search/filters";
import { createServerApp, resolveServeOptions } from "./server";

export interface CliDependencies {
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  now?: Date;
  config?: DdserveConfig;
  embeddingClient?: EmbeddingClient;
}

interface CommandOptions {
  config?: string;
  json?: boolean;
  offline?: boolean;
  force?: boolean;
}

interface SearchCommandOptions extends CommandOptions {
  slug?: SearchFilterOptionValues;
  language?: SearchFilterOptionValues;
  limit?: string | number;
  format?: string;
}

interface ServeCommandOptions extends CommandOptions {
  host?: string;
  port?: string | number;
}

type SearchOutputFormat = "text" | "json" | "xml";

interface HelpSection {
  title?: string;
  body: string;
}

interface SubcommandHelpEntry {
  name: string;
  description: string;
}

interface SubcommandHelpGroup {
  command: string;
  rawName: string;
  entries: readonly SubcommandHelpEntry[];
}

const SUBCOMMAND_HELP_GROUPS: readonly SubcommandHelpGroup[] = [
  {
    command: "sources",
    rawName: "sources [subcommand]",
    entries: [{ name: "list", description: "List documentation sources" }],
  },
  {
    command: "docs",
    rawName: "docs [subcommand] [slug]",
    entries: [
      { name: "available", description: "List available DevDocs docsets" },
      { name: "installed", description: "List installed DevDocs docsets" },
      { name: "install <slug>", description: "Install a DevDocs docset" },
      { name: "update [slug]", description: "Update installed DevDocs docsets" },
    ],
  },
  {
    command: "cache",
    rawName: "cache [subcommand]",
    entries: [{ name: "path", description: "Print the cache root path" }],
  },
  {
    command: "embeddings",
    rawName: "embeddings [subcommand] [slug]",
    entries: [
      { name: "status [slug]", description: "Show embedding index status" },
      { name: "refresh [slug]", description: "Embed missing or stale chunks" },
      { name: "rebuild [slug]", description: "Rebuild embedding index" },
    ],
  },
  {
    command: "config",
    rawName: "config [subcommand]",
    entries: [
      { name: "path", description: "Print the resolved config path" },
      { name: "show", description: "Show redacted configuration" },
    ],
  },
];

export async function runCli(argv: string[] = process.argv.slice(2), deps: CliDependencies = {}): Promise<void> {
  const stdout = deps.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = deps.stderr ?? ((message: string) => process.stderr.write(message));
  const cacheRoot = resolveCacheRoot(deps.env);
  const cli = cac("ddserve");

  cli.option("--config <path>", "Path to JSON config file");

  cli
    .command("sources [subcommand]", "Manage documentation sources")
    .option("--json", "Print JSON")
    .action(async (subcommand: string | undefined, options: CommandOptions) => {
      if (subcommand !== "list") {
        throw new DdserveError('Unknown sources command. Try "ddserve sources list".');
      }

      const paths = await ensureCacheRoot(cacheRoot);
      const source = {
        name: "devdocs",
        index: "https://devdocs.io/docs.json",
        cache: paths.devdocsSourceIndex,
      };

      writeOutput(
        stdout,
        options.json
          ? JSON.stringify([source], null, 2)
          : formatTable([source], [
              { header: "name", value: (row) => row.name },
              { header: "index", value: (row) => row.index },
              { header: "cache", value: (row) => row.cache },
            ]),
      );
    });

  cli
    .command("docs [subcommand] [slug]", "Manage DevDocs docsets")
    .option("--json", "Print JSON")
    .option("--offline", "Use the cached DevDocs index without refreshing")
    .option("--force", "Reinstall even when cached docsets appear current")
    .action(async (subcommand: string | undefined, slug: string | undefined, options: CommandOptions) => {
      if (subcommand === "available") {
      const result = await getAvailableDocsets({
        cacheRoot,
        http: deps.http,
        offline: options.offline,
        now: deps.now,
      });

      for (const warning of result.warnings) {
        stderr(`${warning}\n`);
      }

      if (options.json) {
        writeOutput(stdout, JSON.stringify(result, null, 2));
        return;
      }

      writeOutput(
        stdout,
        formatTable(result.docsets, [
          { header: "slug", value: (row) => row.slug },
          { header: "name", value: (row) => row.name },
          { header: "type", value: (row) => row.type },
          { header: "release", value: (row) => row.release ?? row.version },
          { header: "db", value: (row) => formatBytes(row.dbSize) },
        ]),
      );
        return;
      }

      if (subcommand === "installed") {
      await ensureCacheRoot(cacheRoot);
      const manifest = await readCacheManifest(cacheRoot);
      const docs = Object.values(manifest.docs).sort((left, right) => left.slug.localeCompare(right.slug));

      if (options.json) {
        writeOutput(stdout, JSON.stringify(docs, null, 2));
        return;
      }

      if (docs.length === 0) {
        writeOutput(stdout, "No docsets installed.");
        return;
      }

      writeOutput(
        stdout,
        formatTable(docs, [
          { header: "slug", value: (row) => row.slug },
          { header: "name", value: (row) => row.name },
          { header: "release", value: (row) => row.release ?? row.version },
          { header: "pages", value: (row) => row.pageCount },
          { header: "updated", value: (row) => row.updatedAt },
        ]),
      );
        return;
      }

      if (subcommand === "install") {
        if (!slug) {
          throw new DdserveError('Missing docset slug. Try "ddserve docs install <slug>".');
        }

      const result = await installDocset(slug, {
        cacheRoot,
        http: deps.http,
        force: options.force,
        offline: options.offline,
        now: deps.now,
        configPath: options.config,
        config: deps.config,
        env: deps.env,
        embeddingClient: deps.embeddingClient,
      });

      for (const warning of result.warnings) {
        stderr(`${warning}\n`);
      }

      writeOutput(
        stdout,
        options.json
          ? JSON.stringify(result, null, 2)
          : `${result.status} ${result.slug} (${result.pages} pages, ${result.skippedEntries} skipped)`,
      );
        return;
      }

      if (subcommand === "update") {
      const results = await updateDocsets(slug, {
        cacheRoot,
        http: deps.http,
        force: options.force,
        offline: options.offline,
        now: deps.now,
        configPath: options.config,
        config: deps.config,
        env: deps.env,
        embeddingClient: deps.embeddingClient,
        onProgress: (event) => {
          if (options.json) {
            return;
          }

          if (event.phase === "start") {
            stderr(`Updating ${event.slug} (${event.index}/${event.total})...\n`);
            return;
          }

          if (event.result) {
            stderr(
              `Finished ${event.slug}: ${event.result.status} (${event.result.pages} pages, ${event.result.skippedEntries} skipped)\n`,
            );
          }
        },
      });

       for (const result of results) {
        for (const warning of result.warnings) {
          stderr(`${warning}\n`);
        }
       }

       if (options.json) {
        writeOutput(stdout, JSON.stringify(results, null, 2));
        return;
       }

      if (results.length === 0) {
        writeOutput(stdout, "No docsets installed.");
        return;
      }

      writeOutput(
        stdout,
        formatTable(results, [
          { header: "slug", value: (row) => row.slug },
          { header: "status", value: (row) => row.status },
          { header: "pages", value: (row) => row.pages },
          { header: "skipped", value: (row) => row.skippedEntries },
        ]),
      );
        return;
      }

      throw new DdserveError(
        'Unknown docs command. Try "ddserve docs available", "ddserve docs installed", "ddserve docs install <slug>", or "ddserve docs update [slug]".',
      );
    });

  cli.command("cache [subcommand]", "Manage cache").action((subcommand: string | undefined) => {
    if (subcommand !== "path") {
      throw new DdserveError('Unknown cache command. Try "ddserve cache path".');
    }
    writeOutput(stdout, cachePaths(cacheRoot).root);
  });

  cli
    .command("search [...query]", "Search installed documentation")
    .option("--slug <slug>", "Filter to installed docset slug(s); repeat or comma-separate")
    .option("--language <language>", "Filter by docset language/name/type/alias; repeat or comma-separate")
    .option("--limit <n>", "Maximum number of results", { default: "10" })
    .option("--format <format>", "Output format: text, json, or xml", { default: "text" })
    .option("--json", "Print JSON")
    .action(async (queryParts: string[] | undefined, options: SearchCommandOptions) => {
      const query = normalizeSearchQuery(queryParts);
      const limit = parseSearchLimit(options.limit);
      const outputFormat = parseSearchOutputFormat(options);
      const config = await resolveCliConfig(options, deps);
      const resolvedSlugs = await resolveSearchFilterSlugs({
        cacheRoot,
        slug: options.slug,
        language: options.language,
      });
      const result = await searchDocs({
        cacheRoot,
        config,
        env: deps.env,
        client: deps.embeddingClient,
        query,
        resolvedSlugs,
        limit,
      });

      writeOutput(
        stdout,
        formatSearchOutput(result, resolvedSlugs, cacheRoot, outputFormat),
      );
    });

  cli
    .command("embeddings [subcommand] [slug]", "Inspect, refresh, and rebuild embeddings")
    .option("--json", "Print JSON")
    .action(async (subcommand: string | undefined, slug: string | undefined, options: CommandOptions) => {
      if (subcommand === "status") {
        const config = await resolveCliConfig(options, deps);
        const result = await getEmbeddingsStatus({
          cacheRoot,
          config,
          slug,
        });

        writeOutput(stdout, options.json ? JSON.stringify(result, null, 2) : formatEmbeddingsStatus(result));
        return;
      }

      if (subcommand === "rebuild") {
        const config = await resolveCliConfig(options, deps);
        const results = await rebuildEmbeddings({
          cacheRoot,
          config,
          env: deps.env,
          client: deps.embeddingClient,
          slug,
          now: deps.now,
          onProgress: (event) => {
            if (options.json) {
              return;
            }

            if (event.phase === "start") {
              stderr(`Rebuilding embeddings for ${event.slug} (${event.index}/${event.total})...\n`);
              return;
            }

            if (event.result) {
              stderr(`Finished ${event.slug}: ${event.result.status} (${event.result.embeddedChunks} embedded)\n`);
            }
          },
        });

        if (options.json) {
          writeOutput(stdout, JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          writeOutput(stdout, "No docsets installed.");
          return;
        }

        writeOutput(
          stdout,
          formatTable(results, [
            { header: "slug", value: (row) => row.slug },
            { header: "status", value: (row) => row.status },
            { header: "model", value: (row) => row.model },
            { header: "chunks", value: (row) => row.chunks },
            { header: "embedded", value: (row) => row.embeddedChunks },
            { header: "skipped", value: (row) => row.skippedChunks },
          ]),
        );
        return;
      }

      if (subcommand === "refresh") {
        const config = await resolveCliConfig(options, deps);
        const results = await refreshEmbeddings({
          cacheRoot,
          config,
          env: deps.env,
          client: deps.embeddingClient,
          slug,
          now: deps.now,
          onProgress: (event) => {
            if (options.json) {
              return;
            }

            if (event.phase === "start") {
              stderr(`Refreshing embeddings for ${event.slug} (${event.index}/${event.total})...\n`);
              return;
            }

            if (event.result) {
              stderr(`Finished ${event.slug}: ${event.result.status} (${event.result.embeddedChunks} embedded)\n`);
            }
          },
        });

        if (options.json) {
          writeOutput(stdout, JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          writeOutput(stdout, "No docsets installed.");
          return;
        }

        writeOutput(
          stdout,
          formatTable(results, [
            { header: "slug", value: (row) => row.slug },
            { header: "status", value: (row) => row.status },
            { header: "model", value: (row) => row.model },
            { header: "chunks", value: (row) => row.chunks },
            { header: "embedded", value: (row) => row.embeddedChunks },
            { header: "skipped", value: (row) => row.skippedChunks },
          ]),
        );
        return;
      }

      throw new DdserveError(
        'Unknown embeddings command. Try "ddserve embeddings status [slug]", "ddserve embeddings refresh [slug]", or "ddserve embeddings rebuild [slug]".',
      );
    });

  cli
    .command("serve", "Start the read-only REST API server")
    .option("--host <host>", "Bind address")
    .option("--port <port>", "Port to listen on")
    .action(async (options: ServeCommandOptions) => {
      const config = await resolveCliConfig(options, deps);
      const serveOptions = resolveServeOptions(config, {
        ...(options.host !== undefined ? { host: parseServeHost(options.host) } : {}),
        ...(options.port !== undefined ? { port: parseServePort(options.port) } : {}),
      });
      const app = createServerApp({
        cacheRoot,
        config,
        env: deps.env,
        embeddingClient: deps.embeddingClient,
        bindAddress: serveOptions.host,
      });

      app.listen({
        hostname: serveOptions.host,
        port: serveOptions.port,
      });

      writeOutput(stdout, `ddserve listening on http://${serveOptions.host}:${serveOptions.port}`);
      await waitForServerShutdown(app);
    });

  cli
    .command("config [subcommand]", "Manage configuration")
    .option("--json", "Print JSON")
    .action(async (subcommand: string | undefined, options: CommandOptions) => {
      if (subcommand === "path") {
        writeOutput(stdout, resolveConfigPath({ configPath: options.config, env: deps.env }));
        return;
      }

      if (subcommand === "show") {
        const loaded = await loadConfig({ configPath: options.config, env: deps.env });
        const config = redactConfig(loaded.config);

        writeOutput(
          stdout,
          JSON.stringify(options.json ? { path: loaded.path, found: loaded.found, config } : config, null, 2),
        );
        return;
      }

      throw new DdserveError('Unknown config command. Try "ddserve config path" or "ddserve config show".');
    });

  configureHelp(cli);
  cli.version("0.1.0");

  cli.parse(["bun", "ddserve", ...argv], { run: false });
  await cli.runMatchedCommand();
}

function configureHelp(cli: CAC): void {
  cli.help((sections) => {
    const group = SUBCOMMAND_HELP_GROUPS.find(({ rawName }) => rawName === cli.matchedCommand?.rawName);

    if (group) {
      return insertBeforeHelpSection(sections, "Options", {
        title: "Subcommands",
        body: formatSubcommandRows(group.entries),
      });
    }

    if (!cli.matchedCommand) {
      return insertAfterHelpSection(sections, "Commands", {
        title: "Subcommands",
        body: formatSubcommandRows(
          SUBCOMMAND_HELP_GROUPS.flatMap(({ command, entries }) =>
            entries.map((entry) => ({
              name: `${command} ${entry.name}`,
              description: entry.description,
            })),
          ),
        ),
      });
    }

    return sections;
  });
}

function formatSubcommandRows(entries: readonly SubcommandHelpEntry[]): string {
  const longestNameLength = Math.max(...entries.map(({ name }) => name.length));

  return entries.map(({ name, description }) => `  ${name.padEnd(longestNameLength)}  ${description}`).join("\n");
}

function insertAfterHelpSection(sections: HelpSection[], title: string, section: HelpSection): HelpSection[] {
  const index = sections.findIndex((candidate) => candidate.title === title);

  if (index === -1) {
    return [...sections, section];
  }

  return [...sections.slice(0, index + 1), section, ...sections.slice(index + 1)];
}

function insertBeforeHelpSection(sections: HelpSection[], title: string, section: HelpSection): HelpSection[] {
  const index = sections.findIndex((candidate) => candidate.title === title);

  if (index === -1) {
    return [...sections, section];
  }

  return [...sections.slice(0, index), section, ...sections.slice(index)];
}

function writeOutput(stdout: (message: string) => void, message: string): void {
  stdout(`${message}\n`);
}

function normalizeSearchQuery(queryParts: readonly string[] | undefined): string {
  const query = (queryParts ?? []).join(" ").trim();
  if (query.length === 0) {
    throw new DdserveError('Missing search query. Try "ddserve search <query>".');
  }
  return query;
}

function parseSearchLimit(value: string | number | undefined): number {
  if (value === undefined) {
    return 10;
  }

  if (typeof value === "number") {
    assertPositiveInteger(value, "--limit");
    return value;
  }

  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new DdserveError("Invalid --limit: expected a positive integer");
  }
  return Number(trimmed);
}

function parseServeHost(value: string): string {
  const host = value.trim();
  if (host.length === 0) {
    throw new DdserveError("Invalid --host: expected a non-empty bind address");
  }
  return host;
}

function parseServePort(value: string | number): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new DdserveError("Invalid --port: expected an integer between 1 and 65535");
  }
  return port;
}

function parseSearchOutputFormat(options: SearchCommandOptions): SearchOutputFormat {
  const rawFormat = options.format ?? "text";
  const format = rawFormat.trim().toLowerCase();
  if (options.json && format !== "text" && format !== "json") {
    throw new DdserveError('Cannot combine --json with --format other than "json".');
  }
  if (options.json) {
    return "json";
  }

  if (format === "text" || format === "json" || format === "xml") {
    return format;
  }

  throw new DdserveError('Invalid --format: expected "text", "json", or "xml"');
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DdserveError(`Invalid ${label}: expected a positive integer`);
  }
}

function formatSearchOutput(
  result: SearchResponse,
  resolvedSlugs: readonly string[] | undefined,
  cacheRoot: string,
  format: SearchOutputFormat,
): string {
  if (format === "json") {
    return formatSearchJson(result, resolvedSlugs, cacheRoot);
  }
  if (format === "xml") {
    return formatSearchXml(result, resolvedSlugs, cacheRoot);
  }
  return formatSearchText(result, resolvedSlugs, cacheRoot);
}

function formatSearchJson(result: SearchResponse, resolvedSlugs: readonly string[] | undefined, cacheRoot: string): string {
  return JSON.stringify(
    {
      query: result.query,
      mode: result.mode,
      model: result.model,
      dimensions: result.dimensions,
      resolvedSlugs: resolvedSlugs ?? [],
      results: result.results.map((item) => resultWithInstalledFilePath(item, cacheRoot)),
    },
    null,
    2,
  );
}

function formatSearchXml(result: SearchResponse, resolvedSlugs: readonly string[] | undefined, cacheRoot: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<search>",
    `  <query>${escapeXml(result.query)}</query>`,
    `  <mode>${escapeXml(result.mode)}</mode>`,
    `  <model>${escapeXml(result.model)}</model>`,
    `  <dimensions>${result.dimensions}</dimensions>`,
    "  <resolvedSlugs>",
    ...(resolvedSlugs ?? []).map((slug) => `    <slug>${escapeXml(slug)}</slug>`),
    "  </resolvedSlugs>",
    "  <results>",
  ];

  result.results.forEach((item, index) => {
    const withPath = resultWithInstalledFilePath(item, cacheRoot);
    lines.push(`    <result rank="${index + 1}">`);
    lines.push(`      <score>${formatScore(withPath.score)}</score>`);
    lines.push(`      <mode>${escapeXml(withPath.mode)}</mode>`);
    lines.push(`      <docsetSlug>${escapeXml(withPath.docsetSlug)}</docsetSlug>`);
    lines.push(`      <docsetName>${escapeXml(withPath.docsetName)}</docsetName>`);
    lines.push(`      <pageId>${escapeXml(withPath.pageId)}</pageId>`);
    lines.push(`      <pageName>${escapeXml(withPath.pageName)}</pageName>`);
    lines.push(`      <pagePath>${escapeXml(withPath.pagePath)}</pagePath>`);
    if (withPath.pageType) {
      lines.push(`      <pageType>${escapeXml(withPath.pageType)}</pageType>`);
    }
    lines.push(`      <pageFilePath>${escapeXml(withPath.pageFilePath)}</pageFilePath>`);
    lines.push(`      <installedFilePath>${escapeXml(withPath.installedFilePath)}</installedFilePath>`);
    lines.push(`      <chunkId>${withPath.chunkId}</chunkId>`);
    lines.push(`      <chunkOrdinal>${withPath.chunkOrdinal}</chunkOrdinal>`);
    lines.push(`      <chunkContentHash>${escapeXml(withPath.chunkContentHash)}</chunkContentHash>`);
    lines.push(`      <snippet>${escapeXml(withPath.snippet)}</snippet>`);
    lines.push(`      <text>${escapeXml(withPath.text)}</text>`);
    lines.push("    </result>");
  });

  lines.push("  </results>");
  lines.push("</search>");
  return lines.join("\n");
}

function formatSearchText(result: SearchResponse, resolvedSlugs: readonly string[] | undefined, cacheRoot: string): string {
  const scope = resolvedSlugs && resolvedSlugs.length > 0 ? ` in ${resolvedSlugs.join(", ")}` : "";
  if (result.results.length === 0) {
    return `No search results found for "${result.query}"${scope} (${result.mode}).`;
  }

  const lines = [`Search results for "${result.query}"${scope} (${result.mode}, ${result.model})`];
  result.results.forEach((item, index) => {
    const path = installedMarkdownPath(cacheRoot, item);
    const pageType = item.pageType ? `, ${item.pageType}` : "";
    lines.push("");
    lines.push(
      `${index + 1}. ${item.docsetSlug}/${item.pagePath} — ${item.pageName} [${item.mode}, score ${formatScore(item.score)}]`,
    );
    lines.push(`   File: ${path}`);
    lines.push(`   Page: ${item.pageId}${pageType}, chunk ${item.chunkOrdinal}`);
    lines.push(`   ${item.snippet}`);
  });
  return lines.join("\n");
}

function resultWithInstalledFilePath(result: SearchResult, cacheRoot: string): SearchResult & { installedFilePath: string } {
  return {
    ...result,
    installedFilePath: installedMarkdownPath(cacheRoot, result),
  };
}

function installedMarkdownPath(cacheRoot: string, result: Pick<SearchResult, "docsetSlug" | "pageFilePath">): string {
  if (isAbsolute(result.pageFilePath)) {
    return result.pageFilePath;
  }
  return join(cachePaths(cacheRoot).docsRoot, result.docsetSlug, result.pageFilePath);
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : String(score);
}

function escapeXml(value: string): string {
  return value
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function waitForServerShutdown(app: ReturnType<typeof createServerApp>): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void app.stop().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function resolveCliConfig(options: CommandOptions, deps: CliDependencies): Promise<DdserveConfig> {
  if (deps.config) {
    return deps.config;
  }
  return (await loadConfig({ configPath: options.config, env: deps.env })).config;
}

function formatEmbeddingsStatus(result: EmbeddingsStatusResult): string {
  const lines = [
    `Database: ${result.databasePath}`,
    `Enabled: ${result.enabled ? "yes" : "no"}`,
    `Configured: ${result.configured ? "yes" : "no"}`,
    `Model: ${result.model ?? ""}`,
    `Installed docsets: ${result.installed.docsets}`,
    `Installed pages: ${result.installed.pages}`,
    `Indexed docsets: ${result.indexed.docsets}`,
    `Indexed pages: ${result.indexed.pages}`,
    `Indexed chunks: ${result.indexed.chunks}`,
  ];

  if (result.staleChunks !== undefined || result.missingChunks !== undefined) {
    lines.push(`Current chunks: ${result.currentChunks ?? 0}`);
    lines.push(`Stale chunks: ${result.staleChunks ?? 0}`);
    lines.push(`Missing chunks: ${result.missingChunks ?? 0}`);
  }

  if (result.docsets.length > 0) {
    lines.push("");
    lines.push(
      formatTable(result.docsets, [
        { header: "slug", value: (row) => row.slug },
        { header: "pages", value: (row) => row.pages },
        { header: "indexed_pages", value: (row) => row.indexedPages },
        { header: "indexed_chunks", value: (row) => row.indexedChunks },
        { header: "current", value: (row) => row.currentChunks },
        { header: "stale", value: (row) => row.staleChunks },
        { header: "missing", value: (row) => row.missingChunks },
        { header: "model", value: (row) => row.model },
      ]),
    );
  }

  return lines.join("\n");
}
