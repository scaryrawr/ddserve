import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_CHUNK_MAX_CHARS, DEFAULT_CHUNK_OVERLAP_CHARS } from "./embeddings/chunks";
import { DdserveError, isNodeError } from "./errors";
import { expandHome, isPlainObject } from "./utils";

export const DEFAULT_CONFIG_ENV = "DDSERVE_CONFIG";
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "ddserve", "config.json");
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
export const DEFAULT_SERVE_BIND_ADDRESS = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 43877;
export const DEFAULT_SERVE_AUTH_TOKEN_ENV = "DDSERVE_API_TOKEN";
export const REDACTED_SECRET = "[redacted]";

export interface ConfigPathOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RawDdserveConfig {
  openai?: RawOpenAiConfig;
  embeddings?: RawEmbeddingsConfig;
  serve?: RawServeConfig;
}

export interface RawOpenAiConfig {
  apiKeyEnv?: string;
  apiKey?: string;
  baseURL?: string;
  embeddingModel?: string;
}

export interface RawEmbeddingsConfig {
  enabled?: boolean;
  batchSize?: number;
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface RawServeConfig {
  bindAddress?: string;
  port?: number;
  auth?: RawServeAuthConfig;
  cors?: RawServeCorsConfig;
}

export interface RawServeAuthConfig {
  tokenEnv?: string;
  token?: string;
}

export interface RawServeCorsConfig {
  origins?: string | string[];
}

export interface DdserveConfig {
  openai?: OpenAiConfig;
  embeddings: EmbeddingsConfig;
  serve?: ServeConfig;
}

export interface OpenAiConfig {
  apiKeyEnv?: string;
  apiKey?: string;
  baseURL?: string;
  embeddingModel: string;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  batchSize: number;
  maxChunkChars: number;
  overlapChars: number;
}

export interface ServeConfig {
  bindAddress?: string;
  port?: number;
  auth?: ServeAuthConfig;
  cors?: ServeCorsConfig;
}

export interface ServeAuthConfig {
  tokenEnv: string;
  token?: string;
}

export interface ServeCorsConfig {
  origins: string[];
}

export interface LoadedConfig {
  path: string;
  found: boolean;
  config: DdserveConfig;
}

export type OpenAiApiKeySource =
  | {
      source: "env";
      env: string;
      value: string;
    }
  | {
      source: "config";
      value: string;
    };

export type RedactedOpenAiApiKeySource =
  | {
      source: "env";
      env: string;
      value: typeof REDACTED_SECRET;
    }
  | {
      source: "config";
      value: typeof REDACTED_SECRET;
    };

export interface RedactedDdserveConfig {
  openai?: Omit<OpenAiConfig, "apiKey"> & {
    apiKey?: typeof REDACTED_SECRET;
  };
  embeddings: EmbeddingsConfig;
  serve?: Omit<ServeConfig, "auth"> & {
    auth?: Omit<ServeAuthConfig, "token"> & {
      token?: typeof REDACTED_SECRET;
    };
  };
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitPath = options.configPath;

  if (explicitPath !== undefined) {
    if (explicitPath.trim().length === 0) {
      throw new DdserveError("Invalid config path: path must not be empty");
    }
    return resolve(expandHome(explicitPath));
  }

  const envPath = env[DEFAULT_CONFIG_ENV];
  if (envPath && envPath.trim().length > 0) {
    return resolve(expandHome(envPath));
  }

  return DEFAULT_CONFIG_PATH;
}

export async function loadConfig(options: ConfigPathOptions = {}): Promise<LoadedConfig> {
  const path = resolveConfigPath(options);

  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return {
      path,
      found: true,
      config: parseConfig(raw, path),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        path,
        found: false,
        config: defaultConfig(),
      };
    }

    if (error instanceof SyntaxError) {
      throw new DdserveError(`Invalid JSON in config file ${path}: ${error.message}`, { cause: error });
    }

    throw error;
  }
}

export function defaultConfig(): DdserveConfig {
  return {
    embeddings: {
      enabled: false,
      batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
      maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
      overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
    },
  };
}

export function parseConfig(value: unknown, path = "config"): DdserveConfig {
  const root = requirePlainObject(value, path);
  assertKnownKeys(root, path, ["openai", "embeddings", "serve"]);

  const rawOpenAi = getOptionalPlainObject(root, "openai", path);
  const rawEmbeddings = getOptionalPlainObject(root, "embeddings", path);
  const rawServe = getOptionalPlainObject(root, "serve", path);
  const embeddingsEnabledDefault = rawOpenAi !== undefined;
  const embeddings = parseEmbeddingsConfig(rawEmbeddings, embeddingsEnabledDefault, `${path}.embeddings`);
  const shouldCreateOpenAiConfig = rawOpenAi !== undefined || embeddings.enabled;
  const openai = shouldCreateOpenAiConfig ? parseOpenAiConfig(rawOpenAi ?? {}, `${path}.openai`) : undefined;
  const serve = rawServe ? parseServeConfig(rawServe, `${path}.serve`) : undefined;

  return {
    ...(openai ? { openai } : {}),
    embeddings,
    ...(serve ? { serve } : {}),
  };
}

export function resolveOpenAiApiKey(
  config: DdserveConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiApiKeySource | undefined {
  if (!config.openai) {
    return undefined;
  }

  if (config.openai.apiKeyEnv) {
    const value = env[config.openai.apiKeyEnv];
    if (value && value.trim().length > 0) {
      return {
        source: "env",
        env: config.openai.apiKeyEnv,
        value,
      };
    }
  }

  if (config.openai.apiKey) {
    return {
      source: "config",
      value: config.openai.apiKey,
    };
  }

  return undefined;
}

export function redactConfig(config: DdserveConfig): RedactedDdserveConfig {
  const redacted: RedactedDdserveConfig = {
    embeddings: { ...config.embeddings },
  };

  if (config.openai) {
    const { apiKey, ...openai } = config.openai;
    redacted.openai = {
      ...openai,
      ...(apiKey ? { apiKey: REDACTED_SECRET } : {}),
    };
  }

  if (config.serve) {
    const { auth, ...serve } = config.serve;
    redacted.serve = {
      ...serve,
      ...(auth
        ? {
            auth: {
              tokenEnv: auth.tokenEnv,
              ...(auth.token ? { token: REDACTED_SECRET } : {}),
            },
          }
        : {}),
    };
  }

  return redacted;
}

export function redactOpenAiApiKey(source: OpenAiApiKeySource | undefined): RedactedOpenAiApiKeySource | undefined {
  if (!source) {
    return undefined;
  }

  if (source.source === "env") {
    return {
      source: "env",
      env: source.env,
      value: REDACTED_SECRET,
    };
  }

  return {
    source: "config",
    value: REDACTED_SECRET,
  };
}

function parseOpenAiConfig(value: Record<string, unknown>, path: string): OpenAiConfig {
  assertKnownKeys(value, path, ["apiKeyEnv", "apiKey", "baseURL", "embeddingModel"]);

  const apiKeyEnv = getOptionalString(value, "apiKeyEnv", path);
  const apiKey = getOptionalString(value, "apiKey", path);
  const baseURL = getOptionalString(value, "baseURL", path);
  const embeddingModel = getOptionalString(value, "embeddingModel", path) ?? DEFAULT_EMBEDDING_MODEL;

  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new DdserveError(`Invalid ${path}.apiKeyEnv: expected an environment variable name`);
  }

  if (apiKey !== undefined && apiKey.trim().length === 0) {
    throw new DdserveError(`Invalid ${path}.apiKey: expected a non-empty string`);
  }

  if (baseURL !== undefined) {
    validateBaseUrl(baseURL, `${path}.baseURL`);
  }

  if (embeddingModel.trim().length === 0) {
    throw new DdserveError(`Invalid ${path}.embeddingModel: expected a non-empty string`);
  }

  return {
    apiKeyEnv: apiKeyEnv ?? DEFAULT_OPENAI_API_KEY_ENV,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    embeddingModel,
  };
}

function parseEmbeddingsConfig(
  value: Record<string, unknown> | undefined,
  enabledDefault: boolean,
  path: string,
): EmbeddingsConfig {
  if (value === undefined) {
    return {
      enabled: enabledDefault,
      batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
      maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
      overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
    };
  }

  assertKnownKeys(value, path, ["enabled", "batchSize", "maxChunkChars", "overlapChars"]);
  const maxChunkChars = getOptionalPositiveInteger(value, "maxChunkChars", path) ?? DEFAULT_CHUNK_MAX_CHARS;
  const overlapChars = getOptionalNonNegativeInteger(value, "overlapChars", path) ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  if (overlapChars >= maxChunkChars) {
    throw new DdserveError(`Invalid ${path}.overlapChars: must be smaller than maxChunkChars`);
  }

  return {
    enabled: getOptionalBoolean(value, "enabled", path) ?? enabledDefault,
    batchSize: getOptionalPositiveInteger(value, "batchSize", path) ?? DEFAULT_EMBEDDING_BATCH_SIZE,
    maxChunkChars,
    overlapChars,
  };
}

function parseServeConfig(value: Record<string, unknown>, path: string): ServeConfig {
  assertKnownKeys(value, path, ["bindAddress", "port", "auth", "cors"]);

  const bindAddress = getOptionalString(value, "bindAddress", path);
  const port = getOptionalInteger(value, "port", path);
  const rawAuth = getOptionalPlainObject(value, "auth", path);
  const rawCors = getOptionalPlainObject(value, "cors", path);

  if (bindAddress !== undefined && bindAddress.trim().length === 0) {
    throw new DdserveError(`Invalid ${path}.bindAddress: expected a non-empty string`);
  }

  if (port !== undefined && !isValidPort(port)) {
    throw new DdserveError(`Invalid ${path}.port: expected an integer between 1 and 65535`);
  }

  const auth = rawAuth ? parseServeAuthConfig(rawAuth, `${path}.auth`) : undefined;
  const cors = rawCors ? parseServeCorsConfig(rawCors, `${path}.cors`) : undefined;

  return {
    ...(bindAddress !== undefined ? { bindAddress } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(auth ? { auth } : {}),
    ...(cors ? { cors } : {}),
  };
}

function parseServeAuthConfig(value: Record<string, unknown>, path: string): ServeAuthConfig {
  assertKnownKeys(value, path, ["tokenEnv", "token"]);

  const tokenEnv = getOptionalString(value, "tokenEnv", path) ?? DEFAULT_SERVE_AUTH_TOKEN_ENV;
  const token = getOptionalString(value, "token", path);

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new DdserveError(`Invalid ${path}.tokenEnv: expected an environment variable name`);
  }

  if (token !== undefined && token.trim().length === 0) {
    throw new DdserveError(`Invalid ${path}.token: expected a non-empty string`);
  }

  return {
    tokenEnv,
    ...(token !== undefined ? { token } : {}),
  };
}

function parseServeCorsConfig(value: Record<string, unknown>, path: string): ServeCorsConfig {
  assertKnownKeys(value, path, ["origins"]);

  const origins = getOptionalStringList(value, "origins", path);
  if (!origins || origins.length === 0) {
    throw new DdserveError(`Invalid ${path}.origins: expected at least one origin`);
  }

  for (const origin of origins) {
    if (origin === "*") {
      continue;
    }
    validateBaseUrl(origin, `${path}.origins`);
  }

  return { origins };
}

function requirePlainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new DdserveError(`Invalid ${path}: expected a JSON object`);
  }
  return value;
}

function getOptionalPlainObject(
  value: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (!isPlainObject(field)) {
    throw new DdserveError(`Invalid ${path}.${key}: expected a JSON object`);
  }
  return field;
}

function getOptionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "string") {
    throw new DdserveError(`Invalid ${path}.${key}: expected a string`);
  }
  return field;
}

function getOptionalBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "boolean") {
    throw new DdserveError(`Invalid ${path}.${key}: expected a boolean`);
  }
  return field;
}

function getOptionalInteger(value: Record<string, unknown>, key: string, path: string): number | undefined {
  return getOptionalConstrainedInteger(value, key, path, "an integer", () => true);
}

function getOptionalPositiveInteger(value: Record<string, unknown>, key: string, path: string): number | undefined {
  return getOptionalConstrainedInteger(value, key, path, "a positive integer", (field) => field > 0);
}

function getOptionalNonNegativeInteger(value: Record<string, unknown>, key: string, path: string): number | undefined {
  return getOptionalConstrainedInteger(value, key, path, "a non-negative integer", (field) => field >= 0);
}

function getOptionalConstrainedInteger(
  value: Record<string, unknown>,
  key: string,
  path: string,
  expected: string,
  isValid: (field: number) => boolean,
): number | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== "number" || !Number.isSafeInteger(field) || !isValid(field)) {
    throw new DdserveError(`Invalid ${path}.${key}: expected ${expected}`);
  }
  return field;
}

function getOptionalStringList(value: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }

  const values = typeof field === "string" ? [field] : Array.isArray(field) ? field : undefined;
  if (!values) {
    throw new DdserveError(`Invalid ${path}.${key}: expected a string or array of strings`);
  }

  return values.map((item, index) => {
    if (typeof item !== "string") {
      throw new DdserveError(`Invalid ${path}.${key}[${index}]: expected a string`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new DdserveError(`Invalid ${path}.${key}[${index}]: expected a non-empty string`);
    }
    return trimmed;
  });
}

function isValidPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function validateBaseUrl(value: string, path: string): void {
  if (value.trim().length === 0) {
    throw new DdserveError(`Invalid ${path}: expected a non-empty URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new DdserveError(`Invalid ${path}: expected a valid URL`, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DdserveError(`Invalid ${path}: expected an http or https URL`);
  }
}

function assertKnownKeys(value: Record<string, unknown>, path: string, knownKeys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      throw new DdserveError(`Invalid ${path}.${key}: unknown config field`);
    }
  }
}
