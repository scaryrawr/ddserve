import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { cachePaths, readCacheManifest, readJsonFile, resolveCacheRoot } from "./cache";
import type { CacheManifestDocset, DevDocsRawDocset } from "./types";
import { isPlainObject } from "./utils";

export const DDSERVE_PI_CONTEXT_DOC_LIMIT = 5;
const DDSERVE_PI_SEARCH_CANDIDATE_LIMIT = 15;
const DDSERVE_PI_SEARCH_TIMEOUT_MS = 5_000;
const DDSERVE_PI_CUSTOM_MESSAGE_TYPE = "ddserve";
const DEFAULT_DDSERVE_COMMAND = "ddserve";

const execFile = promisify(execFileCallback);

const PACKAGE_DOC_HINTS: Record<string, readonly string[]> = {
  "@angular/core": ["angular"],
  "@angular/cli": ["angular"],
  "@apollo/client": ["apollo", "graphql"],
  "@nestjs/core": ["nestjs"],
  "@playwright/test": ["playwright"],
  "@remix-run/react": ["react", "remix"],
  "@sveltejs/kit": ["svelte"],
  "@types/node": ["node"],
  "@vitejs/plugin-react": ["vite", "react"],
  "@vue/cli-service": ["vue"],
  astro: ["astro"],
  bootstrap: ["bootstrap", "css"],
  bun: ["bun"],
  chai: ["chai"],
  cypress: ["cypress"],
  d3: ["d3"],
  django: ["django", "python"],
  electron: ["electron", "node", "javascript"],
  elysia: ["elysia", "bun", "typescript"],
  eslint: ["eslint", "javascript"],
  express: ["express", "node", "javascript"],
  fastify: ["fastify", "node", "javascript"],
  flask: ["flask", "python"],
  graphql: ["graphql"],
  hono: ["hono", "typescript"],
  jquery: ["jquery", "javascript"],
  jest: ["jest", "javascript"],
  koa: ["koa", "node", "javascript"],
  lodash: ["lodash", "javascript"],
  mocha: ["mocha", "javascript"],
  next: ["nextjs", "react"],
  nuxt: ["nuxt", "vue"],
  openai: ["openai"],
  pandas: ["pandas", "python"],
  playwright: ["playwright"],
  pytest: ["pytest", "python"],
  react: ["react"],
  "react-dom": ["react"],
  "react-native": ["react_native", "react"],
  "react-router": ["react_router", "react"],
  "react-router-dom": ["react_router", "react"],
  requests: ["requests", "python"],
  rollup: ["rollup", "javascript"],
  rxjs: ["rxjs", "javascript"],
  svelte: ["svelte"],
  tailwindcss: ["tailwindcss", "css"],
  typescript: ["typescript"],
  vite: ["vite", "javascript"],
  vitest: ["vitest", "vite", "typescript"],
  vue: ["vue"],
  webpack: ["webpack", "javascript"],
  zod: ["zod", "typescript"],
};

const PYTHON_PACKAGE_DOC_HINTS: Record<string, readonly string[]> = {
  django: ["django", "python"],
  fastapi: ["fastapi", "python"],
  flask: ["flask", "python"],
  matplotlib: ["matplotlib", "python"],
  numpy: ["numpy", "python"],
  pandas: ["pandas", "python"],
  pytest: ["pytest", "python"],
  requests: ["requests", "python"],
  sqlalchemy: ["sqlalchemy", "python"],
};

export interface PiDdserveContextOptions {
  prompt: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cacheRoot?: string;
  runSearch?: DdserveSearchRunner;
}

export interface ProjectDocsetDetection {
  cwd: string;
  hints: string[];
}

export interface DdserveSearchRunnerOptions {
  query: string;
  slugs?: readonly string[];
  limit: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type DdserveSearchRunner = (options: DdserveSearchRunnerOptions) => Promise<DdserveCliSearchResponse>;

export interface DdserveCliSearchResponse {
  results: DdserveSearchResult[];
}

export interface DdserveSearchResult {
  docsetSlug: string;
  pageId: string;
  pageName: string;
  pagePath: string;
  pageType?: string;
  snippet: string;
}

interface PackageJsonProject {
  packageManager?: string;
  dependencies: string[];
}

interface InstalledDocsetMatchEntry {
  slug: string;
  name: string;
  type: string;
  aliases: string[];
}

interface CachedDevDocsSourceIndex {
  docsets?: DevDocsRawDocset[];
}

class DdserveCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DdserveCommandError";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult | undefined> => {
    const content = await buildPiDdserveContext({
      prompt: event.prompt,
      cwd: event.systemPromptOptions.cwd,
    });

    if (!content) {
      return undefined;
    }

    return {
      message: {
        customType: DDSERVE_PI_CUSTOM_MESSAGE_TYPE,
        content,
        display: true,
      },
    };
  });
}

export async function buildPiDdserveContext(options: PiDdserveContextOptions): Promise<string | undefined> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    return undefined;
  }

  const env = options.env ?? process.env;

  try {
    const cacheRoot = options.cacheRoot ?? resolveCacheRoot(env);
    const detected = await detectProjectDocsetHints(options.cwd);
    const detectedSlugs = await resolveDetectedDocsetSlugs(cacheRoot, detected.hints);
    const response = await (options.runSearch ?? runDdserveSearch)({
      query: prompt,
      slugs: detectedSlugs.length > 0 ? detectedSlugs : undefined,
      limit: DDSERVE_PI_SEARCH_CANDIDATE_LIMIT,
      cwd: options.cwd,
      env,
    });
    return formatDdserveContext(topDistinctDocs(response.results, DDSERVE_PI_CONTEXT_DOC_LIMIT));
  } catch (error) {
    return formatDdserveUnavailable(error);
  }
}

export async function runDdserveSearch(options: DdserveSearchRunnerOptions): Promise<DdserveCliSearchResponse> {
  const command = options.env.DDSERVE_PI_COMMAND?.trim() || DEFAULT_DDSERVE_COMMAND;
  const args = [
    "search",
    options.query,
    "--limit",
    String(options.limit),
    "--format",
    "json",
  ];

  if (options.slugs && options.slugs.length > 0) {
    args.push("--slug", options.slugs.join(","));
  }

  let stdout: string;
  try {
    ({ stdout } = await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: DDSERVE_PI_SEARCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    throw new DdserveCommandError(commandFailureMessage(command, error));
  }

  try {
    return parseDdserveSearchResponse(JSON.parse(stdout) as unknown);
  } catch (error) {
    throw new DdserveCommandError("ddserve search returned invalid JSON");
  }
}

export async function detectProjectDocsetHints(cwd: string): Promise<ProjectDocsetDetection> {
  const hints: string[] = [];
  const add = (...values: readonly string[]) => pushUnique(hints, values);
  const fileNames = await readProjectFileNames(cwd);
  const packageJson = await readPackageJsonProject(cwd);

  if (packageJson) {
    add("node", "javascript");

    if (packageJson.packageManager?.startsWith("bun@")) {
      add("bun");
    }

    for (const dependency of packageJson.dependencies) {
      add(...packageDocsetHints(dependency));
    }
  }

  if (fileNames.has("bun.lock") || fileNames.has("bun.lockb") || fileNames.has("bunfig.toml")) {
    add("bun", "javascript");
  }

  if (
    fileNames.has("tsconfig.json") ||
    fileNames.has("tsconfig.build.json") ||
    hasProjectFileExtension(fileNames, [".ts", ".tsx", ".mts", ".cts"])
  ) {
    add("typescript", "javascript");
  }

  if (hasProjectFileExtension(fileNames, [".js", ".jsx", ".mjs", ".cjs"])) {
    add("javascript");
  }

  if (fileNames.has("vite.config.ts") || fileNames.has("vite.config.js") || fileNames.has("vite.config.mjs")) {
    add("vite", "javascript");
  }

  if (fileNames.has("eslint.config.js") || fileNames.has("eslint.config.mjs") || fileNames.has(".eslintrc.json")) {
    add("eslint", "javascript");
  }

  if (
    fileNames.has("index.html") ||
    hasProjectFileExtension(fileNames, [".html", ".css", ".scss", ".sass", ".less"])
  ) {
    add("html", "css", "dom");
  }

  if (
    fileNames.has("pyproject.toml") ||
    fileNames.has("requirements.txt") ||
    fileNames.has("setup.py") ||
    hasProjectFileExtension(fileNames, [".py"])
  ) {
    add("python");
    add(...(await pythonDependencyHints(cwd)));
  }

  if (fileNames.has("Cargo.toml") || hasProjectFileExtension(fileNames, [".rs"])) {
    add("rust");
  }

  if (fileNames.has("go.mod") || hasProjectFileExtension(fileNames, [".go"])) {
    add("go");
  }

  if (fileNames.has("CMakeLists.txt") || hasProjectFileExtension(fileNames, [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"])) {
    add("cpp", "cmake");
  }

  if (fileNames.has("pom.xml") || fileNames.has("build.gradle") || fileNames.has("build.gradle.kts")) {
    add("java");
  }

  if (fileNames.has("composer.json") || hasProjectFileExtension(fileNames, [".php"])) {
    add("php");
  }

  if (fileNames.has("Gemfile") || hasProjectFileExtension(fileNames, [".rb"])) {
    add("ruby");
  }

  if (fileNames.has("Dockerfile") || fileNames.has("docker-compose.yml") || fileNames.has("compose.yml")) {
    add("docker");
  }

  if (fileNames.has("package-lock.json")) {
    add("npm");
  }
  if (fileNames.has("yarn.lock")) {
    add("yarn");
  }

  return { cwd, hints };
}

export async function resolveDetectedDocsetSlugs(cacheRoot: string, hints: readonly string[]): Promise<string[]> {
  if (hints.length === 0) {
    return [];
  }

  const entries = await installedDocsetMatchEntries(cacheRoot);
  const slugs: string[] = [];
  const seen = new Set<string>();

  for (const hint of hints) {
    const matches = matchInstalledDocsets(entries, hint);
    if (matches.length === 1) {
      pushUniqueValue(slugs, seen, matches[0]!.slug);
    }
  }

  return slugs;
}

export function formatDdserveContext(results: readonly DdserveSearchResult[]): string {
  const lines = ["<ddserve>", "  <docs>"];

  for (const result of results) {
    lines.push(
      `    <doc slug="${escapeXml(result.docsetSlug)}" pageId="${escapeXml(result.pageId)}">`,
      `      <title>${escapeXml(result.pageName)}</title>`,
      `      <path>${escapeXml(result.pagePath)}</path>`,
      ...(result.pageType ? [`      <type>${escapeXml(result.pageType)}</type>`] : []),
      `      <info>${escapeXml(shortInfo(result.snippet))}</info>`,
      "    </doc>",
    );
  }

  lines.push("  </docs>", "</ddserve>");
  return lines.join("\n");
}

function parseDdserveSearchResponse(value: unknown): DdserveCliSearchResponse {
  if (!isPlainObject(value) || !Array.isArray(value.results)) {
    throw new Error("Invalid ddserve search response");
  }

  return {
    results: value.results.filter(isSearchResult),
  };
}

function isSearchResult(value: unknown): value is DdserveSearchResult {
  return isPlainObject(value) &&
    typeof value.docsetSlug === "string" &&
    typeof value.pageId === "string" &&
    typeof value.pageName === "string" &&
    typeof value.pagePath === "string" &&
    (value.pageType === undefined || typeof value.pageType === "string") &&
    typeof value.snippet === "string";
}

function formatDdserveUnavailable(error: unknown): string {
  const message = error instanceof DdserveCommandError
    ? error.message
    : "Request could not be completed";

  return [
    "<ddserve>",
    "  <docs />",
    `  <note>${escapeXml(`Documentation search unavailable: ${message}.`)}</note>`,
    "</ddserve>",
  ].join("\n");
}

function topDistinctDocs(results: readonly DdserveSearchResult[], limit: number): DdserveSearchResult[] {
  const selected: DdserveSearchResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const key = `${result.docsetSlug}\0${result.pageId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(result);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

async function readProjectFileNames(cwd: string): Promise<Set<string>> {
  const names = new Set<string>();
  await addDirectoryFileNames(names, cwd);
  await addDirectoryFileNames(names, join(cwd, "src"));
  await addDirectoryFileNames(names, join(cwd, "app"));
  await addDirectoryFileNames(names, join(cwd, "lib"));
  return names;
}

async function addDirectoryFileNames(names: Set<string>, directory: string): Promise<void> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) {
        names.add(entry.name);
      }
    }
  } catch {
    // Project detection is best-effort and should never block prompt handling.
  }
}

async function readPackageJsonProject(cwd: string): Promise<PackageJsonProject | undefined> {
  const json = await readJsonFile<unknown>(join(cwd, "package.json"));
  if (!isPlainObject(json)) {
    return undefined;
  }

  return {
    packageManager: typeof json.packageManager === "string" ? json.packageManager : undefined,
    dependencies: dependencyNames(json),
  };
}

function dependencyNames(packageJson: Record<string, unknown>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const dependencies = packageJson[key];
    if (!isPlainObject(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies).sort()) {
      pushUniqueValue(names, seen, name);
    }
  }

  return names;
}

function packageDocsetHints(packageName: string): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();

  for (const hint of packageNameVariants(packageName)) {
    pushUniqueValue(hints, seen, hint);
  }
  for (const hint of PACKAGE_DOC_HINTS[packageName] ?? []) {
    pushUniqueValue(hints, seen, hint);
  }

  return hints;
}

function packageNameVariants(packageName: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim().toLocaleLowerCase();
    if (trimmed.length === 0) {
      return;
    }
    pushUniqueValue(variants, seen, trimmed);
    pushUniqueValue(variants, seen, trimmed.replace(/-/g, "_"));
  };

  add(packageName);
  const scoped = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (scoped) {
    add(scoped[1]!);
    add(scoped[2]!);
  }
  if (packageName.startsWith("@types/")) {
    add(packageName.slice("@types/".length));
  }

  return variants;
}

function parseRequirementNames(requirements: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const line of requirements.split(/\r?\n/)) {
    const withoutComment = line.replace(/#.*/, "").trim();
    if (!withoutComment || withoutComment.startsWith("-") || withoutComment.includes("://")) {
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)/.exec(withoutComment);
    if (match) {
      pushUniqueValue(names, seen, match[1]!);
    }
  }

  return names;
}

function parsePyprojectDependencyNames(pyproject: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const dependencyPattern = /["']([A-Za-z0-9_.-]+)(?:\[[^\]"']+\])?\s*(?:[<>=!~]=?|["'])/g;
  let match: RegExpExecArray | null;

  while ((match = dependencyPattern.exec(pyproject)) !== null) {
    pushUniqueValue(names, seen, match[1]!);
  }

  return names;
}

async function pythonDependencyHints(cwd: string): Promise<string[]> {
  const hints: string[] = [];
  const seen = new Set<string>();
  const pyproject = await readTextIfExists(join(cwd, "pyproject.toml"));
  const requirements = await readTextIfExists(join(cwd, "requirements.txt"));
  const text = [pyproject, requirements].filter((value): value is string => value !== undefined).join("\n");

  for (const dependency of [
    ...parseRequirementNames(requirements ?? ""),
    ...parsePyprojectDependencyNames(pyproject ?? ""),
  ]) {
    for (const hint of packageNameVariants(dependency)) {
      pushUniqueValue(hints, seen, hint);
    }
  }

  for (const [dependency, dependencyHints] of Object.entries(PYTHON_PACKAGE_DOC_HINTS)) {
    if (new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(dependency)}([^a-z0-9_-]|$)`, "i").test(text)) {
      for (const hint of dependencyHints) {
        pushUniqueValue(hints, seen, hint);
      }
    }
  }

  return hints;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function installedDocsetMatchEntries(cacheRoot: string): Promise<InstalledDocsetMatchEntry[]> {
  const manifest = await readCacheManifest(cacheRoot);
  const installed = Object.values(manifest.docs).sort((left, right) => left.slug.localeCompare(right.slug));
  const sourceMetadata = await readSourceDocsetMetadata(cacheRoot);
  return installed.map((docset) => toMatchEntry(docset, sourceMetadata.get(docset.slug)));
}

async function readSourceDocsetMetadata(cacheRoot: string): Promise<Map<string, { aliases: string[] }>> {
  const cached = await readJsonFile<CachedDevDocsSourceIndex>(cachePaths(cacheRoot).devdocsSourceIndex);
  if (!Array.isArray(cached?.docsets)) {
    return new Map();
  }

  return new Map(
    cached.docsets
      .filter((docset) => typeof docset?.slug === "string" && docset.slug.length > 0)
      .map((docset) => [docset.slug, { aliases: normalizeAliases(docset.alias) }]),
  );
}

function toMatchEntry(docset: CacheManifestDocset, sourceMetadata: { aliases: string[] } | undefined): InstalledDocsetMatchEntry {
  return {
    slug: docset.slug,
    name: docset.name,
    type: docset.type,
    aliases: sourceMetadata?.aliases ?? [],
  };
}

function matchInstalledDocsets(entries: readonly InstalledDocsetMatchEntry[], hint: string): InstalledDocsetMatchEntry[] {
  const normalizedHint = normalizeMatchKey(hint);
  return entries.filter((entry) => matchFields(entry).some((field) => normalizeMatchKey(field) === normalizedHint));
}

function matchFields(entry: InstalledDocsetMatchEntry): string[] {
  return [entry.slug, entry.name, entry.type, ...entry.aliases].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function hasProjectFileExtension(fileNames: Set<string>, extensions: readonly string[]): boolean {
  for (const fileName of fileNames) {
    const lower = fileName.toLocaleLowerCase();
    if (extensions.some((extension) => lower.endsWith(extension))) {
      return true;
    }
  }
  return false;
}

function commandFailureMessage(command: string, error: unknown): string {
  const code = isNodeError(error) ? error.code : undefined;
  if (code === "ENOENT") {
    return `${command} command was not found on PATH`;
  }
  if (isTimedOut(error)) {
    return "ddserve search timed out";
  }

  const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
    ? (error as { stderr: string }).stderr.trim()
    : "";
  const message = firstLine(stderr) || "ddserve search failed";
  return safeCommandMessage(message);
}

function safeCommandMessage(message: string): string {
  if (containsFilesystemPath(message)) {
    return "Request could not be completed";
  }
  if (/^(Invalid|Missing|Unknown|Ambiguous|No docsets|Embeddings|OpenAI|Search)/.test(message)) {
    return message;
  }
  return "Request could not be completed";
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

function isTimedOut(error: unknown): boolean {
  const candidate = error as { signal?: unknown; killed?: unknown };
  return candidate.signal === "SIGTERM" || candidate.killed === true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function containsFilesystemPath(message: string): boolean {
  return /(?:^|\s)(?:\.{1,2}[\\/]|[^\s:]+[\\/][^\s]+|\/|~\/|[A-Za-z]:[\\/])/.test(message);
}

function shortInfo(value: string): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > 240 ? `${compacted.slice(0, 237)}...` : compacted;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeAliases(alias: string | string[] | undefined): string[] {
  if (!alias) {
    return [];
  }
  return Array.isArray(alias) ? alias : [alias];
}

function normalizeMatchKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pushUnique(values: string[], incoming: readonly string[]): void {
  const seen = new Set(values);
  for (const value of incoming) {
    pushUniqueValue(values, seen, value);
  }
}

function pushUniqueValue(values: string[], seen: Set<string>, value: string): void {
  if (!seen.has(value)) {
    seen.add(value);
    values.push(value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
