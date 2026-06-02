import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENAI_API_KEY_ENV,
  DEFAULT_SERVE_AUTH_TOKEN_ENV,
  REDACTED_SECRET,
  loadConfig,
  parseConfig,
  redactConfig,
  redactOpenAiApiKey,
  resolveConfigPath,
  resolveOpenAiApiKey,
} from "../src/config";
import { DEFAULT_CHUNK_MAX_CHARS, DEFAULT_CHUNK_OVERLAP_CHARS } from "../src/embeddings/chunks";
import { DdserveError } from "../src/errors";

const testRoot = join(process.cwd(), ".test-work", "config");

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
  test("uses explicit path before env and default path", () => {
    expect(resolveConfigPath({ configPath: "./custom.json", env: { DDSERVE_CONFIG: "./env.json" } })).toBe(
      resolve("./custom.json"),
    );
  });

  test("uses DDSERVE_CONFIG when no explicit path is provided", () => {
    expect(resolveConfigPath({ env: { DDSERVE_CONFIG: "./env.json" } })).toBe(resolve("./env.json"));
  });

  test("falls back to the default config path", () => {
    expect(resolveConfigPath({ env: {} })).toBe(DEFAULT_CONFIG_PATH);
  });

  test("expands home-relative paths", () => {
    expect(resolveConfigPath({ configPath: "~/ddserve-config.json", env: {} })).toBe(
      join(homedir(), "ddserve-config.json"),
    );
  });
});

describe("loadConfig", () => {
  test("returns defaults when the config file is absent", async () => {
    const path = join(testRoot, randomUUID(), "missing.json");
    const loaded = await loadConfig({ configPath: path, env: {} });

    expect(loaded).toEqual({
      path,
      found: false,
      config: {
        embeddings: {
          enabled: false,
          batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
          maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
          overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
        },
      },
    });
  });

  test("loads JSON config and applies defaults", async () => {
    const path = await writeConfig({
      openai: {
        baseURL: "http://localhost:11434/v1",
      },
    });

    const loaded = await loadConfig({ configPath: path, env: {} });

    expect(loaded.found).toBe(true);
    expect(loaded.config).toEqual({
      openai: {
        apiKeyEnv: DEFAULT_OPENAI_API_KEY_ENV,
        baseURL: "http://localhost:11434/v1",
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
      },
      embeddings: {
        enabled: true,
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
        overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
      },
    });
  });

  test("throws DdserveError for invalid JSON", async () => {
    const path = await writeTextConfig("{ nope");

    await expect(loadConfig({ configPath: path, env: {} })).rejects.toThrow(DdserveError);
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toThrow("Invalid JSON in config file");
  });
});

describe("parseConfig", () => {
  test("allows embeddings to be enabled without requiring an API key", () => {
    const config = parseConfig({
      openai: {
        apiKeyEnv: "MISSING_OPENAI_KEY",
        embeddingModel: "custom-embedding-model",
      },
      embeddings: {
        batchSize: 12,
        maxChunkChars: 600,
        overlapChars: 0,
      },
    });

    expect(config).toEqual({
      openai: {
        apiKeyEnv: "MISSING_OPENAI_KEY",
        embeddingModel: "custom-embedding-model",
      },
      embeddings: {
        enabled: true,
        batchSize: 12,
        maxChunkChars: 600,
        overlapChars: 0,
      },
    });
    expect(resolveOpenAiApiKey(config, {})).toBeUndefined();
  });

  test("applies OpenAI defaults when embeddings are explicitly enabled", () => {
    expect(parseConfig({ embeddings: { enabled: true } })).toEqual({
      openai: {
        apiKeyEnv: DEFAULT_OPENAI_API_KEY_ENV,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
      },
      embeddings: {
        enabled: true,
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
        overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
      },
    });
  });

  test("rejects invalid field types and values", () => {
    expect(() => parseConfig({ openai: "yes" })).toThrow("Invalid config.openai: expected a JSON object");
    expect(() => parseConfig({ openai: { baseURL: "file:///model" } })).toThrow(
      "Invalid config.openai.baseURL: expected an http or https URL",
    );
    expect(() => parseConfig({ openai: { apiKeyEnv: "not-valid-env!" } })).toThrow(
      "Invalid config.openai.apiKeyEnv: expected an environment variable name",
    );
    expect(() => parseConfig({ embeddings: { batchSize: 0 } })).toThrow(
      "Invalid config.embeddings.batchSize: expected a positive integer",
    );
    expect(() => parseConfig({ embeddings: { maxChunkChars: 0 } })).toThrow(
      "Invalid config.embeddings.maxChunkChars: expected a positive integer",
    );
    expect(() => parseConfig({ embeddings: { overlapChars: -1 } })).toThrow(
      "Invalid config.embeddings.overlapChars: expected a non-negative integer",
    );
    expect(() => parseConfig({ embeddings: { maxChunkChars: 100, overlapChars: 100 } })).toThrow(
      "Invalid config.embeddings.overlapChars: must be smaller than maxChunkChars",
    );
    expect(() => parseConfig({ serve: { port: 0 } })).toThrow(
      "Invalid config.serve.port: expected an integer between 1 and 65535",
    );
    expect(() => parseConfig({ serve: { auth: { tokenEnv: "not-valid-env!" } } })).toThrow(
      "Invalid config.serve.auth.tokenEnv: expected an environment variable name",
    );
    expect(() => parseConfig({ serve: { cors: { origins: [] } } })).toThrow(
      "Invalid config.serve.cors.origins: expected at least one origin",
    );
  });

  test("rejects unknown fields", () => {
    expect(() => parseConfig({ azure: {} })).toThrow("Invalid config.azure: unknown config field");
    expect(() => parseConfig({ openai: { organization: "org" } })).toThrow(
      "Invalid config.openai.organization: unknown config field",
    );
    expect(() => parseConfig({ serve: { protocol: "http" } })).toThrow(
      "Invalid config.serve.protocol: unknown config field",
    );
  });

  test("parses serve configuration and redacts auth tokens", () => {
    const config = parseConfig({
      serve: {
        bindAddress: "0.0.0.0",
        port: 43877,
        auth: {
          token: "serve-secret",
        },
        cors: {
          origins: ["http://localhost:3000", "https://docs.example.test"],
        },
      },
    });

    expect(config.serve).toEqual({
      bindAddress: "0.0.0.0",
      port: 43877,
      auth: {
        tokenEnv: DEFAULT_SERVE_AUTH_TOKEN_ENV,
        token: "serve-secret",
      },
      cors: {
        origins: ["http://localhost:3000", "https://docs.example.test"],
      },
    });
    expect(redactConfig(config).serve).toEqual({
      bindAddress: "0.0.0.0",
      port: 43877,
      auth: {
        tokenEnv: DEFAULT_SERVE_AUTH_TOKEN_ENV,
        token: REDACTED_SECRET,
      },
      cors: {
        origins: ["http://localhost:3000", "https://docs.example.test"],
      },
    });
  });
});

describe("OpenAI API key helpers", () => {
  test("resolves an environment key before a literal config key", () => {
    const config = parseConfig({
      openai: {
        apiKeyEnv: "OPENAI_TEST_KEY",
        apiKey: "literal-secret",
      },
    });

    expect(resolveOpenAiApiKey(config, { OPENAI_TEST_KEY: "env-secret" })).toEqual({
      source: "env",
      env: "OPENAI_TEST_KEY",
      value: "env-secret",
    });
  });

  test("falls back to literal config keys", () => {
    const config = parseConfig({
      openai: {
        apiKeyEnv: "OPENAI_TEST_KEY",
        apiKey: "literal-secret",
      },
    });

    expect(resolveOpenAiApiKey(config, {})).toEqual({
      source: "config",
      value: "literal-secret",
    });
  });

  test("redacts literal and resolved secrets", () => {
    const config = parseConfig({
      openai: {
        apiKeyEnv: "OPENAI_TEST_KEY",
        apiKey: "literal-secret",
      },
    });
    const resolved = resolveOpenAiApiKey(config, { OPENAI_TEST_KEY: "env-secret" });

    expect(redactConfig(config)).toEqual({
      openai: {
        apiKeyEnv: "OPENAI_TEST_KEY",
        apiKey: REDACTED_SECRET,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
      },
      embeddings: {
        enabled: true,
        batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
        maxChunkChars: DEFAULT_CHUNK_MAX_CHARS,
        overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
      },
    });
    expect(redactOpenAiApiKey(resolved)).toEqual({
      source: "env",
      env: "OPENAI_TEST_KEY",
      value: REDACTED_SECRET,
    });
  });
});

async function writeConfig(value: unknown): Promise<string> {
  return writeTextConfig(JSON.stringify(value));
}

async function writeTextConfig(content: string): Promise<string> {
  const dir = join(testRoot, randomUUID());
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.json");
  await writeFile(path, content, "utf8");
  return path;
}
