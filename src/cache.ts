import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { CACHE_SCHEMA_VERSION, type CacheManifest, type DocsetManifest } from "./types";
import { DdserveError, getErrorMessage, isNodeError } from "./errors";

export const DEFAULT_CACHE_ENV = "DDSERVE_CACHE_DIR";

export interface CachePaths {
  root: string;
  manifest: string;
  sourcesRoot: string;
  devdocsSourceRoot: string;
  devdocsSourceIndex: string;
  docsRoot: string;
  embeddingsRoot: string;
  embeddingsDb: string;
  locksRoot: string;
}

export function resolveCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DEFAULT_CACHE_ENV];
  if (override && override.trim().length > 0) {
    return resolve(expandHome(override));
  }

  const xdgCacheHome = env.XDG_CACHE_HOME;
  if (xdgCacheHome && xdgCacheHome.trim().length > 0) {
    return resolve(expandHome(xdgCacheHome), "ddserve");
  }

  return join(homedir(), ".cache", "ddserve");
}

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }

  return input;
}

export function cachePaths(root = resolveCacheRoot()): CachePaths {
  return {
    root,
    manifest: join(root, "manifest.json"),
    sourcesRoot: join(root, "sources"),
    devdocsSourceRoot: join(root, "sources", "devdocs"),
    devdocsSourceIndex: join(root, "sources", "devdocs", "index.json"),
    docsRoot: join(root, "docs"),
    embeddingsRoot: join(root, "embeddings"),
    embeddingsDb: join(root, "embeddings", "embeddings.sqlite"),
    locksRoot: join(root, "locks"),
  };
}

export async function ensureEmbeddingDbPath(root = resolveCacheRoot()): Promise<string> {
  const paths = cachePaths(root);
  await mkdir(paths.embeddingsRoot, { recursive: true });
  return paths.embeddingsDb;
}

export async function ensureCacheRoot(root = resolveCacheRoot()): Promise<CachePaths> {
  const paths = cachePaths(root);
  await Promise.all([
    mkdir(paths.devdocsSourceRoot, { recursive: true }),
    mkdir(paths.docsRoot, { recursive: true }),
    mkdir(paths.locksRoot, { recursive: true }),
  ]);
  return paths;
}

export function createEmptyCacheManifest(now = new Date()): CacheManifest {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    docs: {},
  };
}

export async function readCacheManifest(root = resolveCacheRoot()): Promise<CacheManifest> {
  const paths = cachePaths(root);
  const manifest = await readJsonFile<CacheManifest>(paths.manifest);
  if (!manifest) {
    return createEmptyCacheManifest();
  }

  if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION || typeof manifest.docs !== "object" || manifest.docs === null) {
    throw new DdserveError(`Unsupported cache manifest at ${paths.manifest}`);
  }

  return manifest;
}

export async function writeCacheManifest(root: string, manifest: CacheManifest): Promise<void> {
  await atomicWriteJson(cachePaths(root).manifest, manifest);
}

export async function readDocsetManifest(root: string, slug: string): Promise<DocsetManifest | undefined> {
  assertSafePathSegment(slug, "docset slug");
  return readJsonFile<DocsetManifest>(join(cachePaths(root).docsRoot, slug, "manifest.json"));
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new DdserveError(`Invalid JSON in ${file}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._+~-]*$/i.test(value)) {
    throw new DdserveError(`Invalid ${label}: ${value}`);
  }
}

export async function replaceDirectory(stageDir: string, finalDir: string): Promise<void> {
  const backupDir = `${finalDir}.previous-${process.pid}-${Date.now()}`;
  const finalExists = await pathExists(finalDir);

  try {
    if (finalExists) {
      await rename(finalDir, backupDir);
    }

    await rename(stageDir, finalDir);
    if (finalExists) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (await pathExists(finalDir)) {
      await rm(finalDir, { recursive: true, force: true });
    }
    if (await pathExists(backupDir)) {
      await rename(backupDir, finalDir);
    }
    throw new DdserveError(`Failed to replace cached docset directory ${finalDir}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

export interface DocsetLock {
  release(): Promise<void>;
}

export async function acquireDocsetLock(root: string, slug: string): Promise<DocsetLock> {
  assertSafePathSegment(slug, "docset slug");
  const paths = await ensureCacheRoot(root);
  const lockDir = join(paths.locksRoot, `${slug}.lock`);

  try {
    await mkdir(lockDir);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }

    const stale = await isStaleLock(lockDir);
    if (!stale) {
      throw new DdserveError(`Docset "${slug}" is already being installed or updated`);
    }

    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
  }

  await atomicWriteJson(join(lockDir, "owner.json"), {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });

  return {
    async release() {
      await rm(lockDir, { recursive: true, force: true });
    },
  };
}

async function isStaleLock(lockDir: string): Promise<boolean> {
  const owner = await readJsonFile<{ pid?: number; createdAt?: string }>(join(lockDir, "owner.json"));
  if (!owner?.createdAt) {
    return false;
  }

  if (owner.pid !== undefined && !isLiveProcess(owner.pid)) {
    return true;
  }

  const createdAt = Date.parse(owner.createdAt);
  if (!Number.isFinite(createdAt)) {
    return false;
  }

  return Date.now() - createdAt > 2 * 60 * 60 * 1000;
}

function isLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}
