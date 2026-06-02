import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config";
import { createOpenAiEmbeddingClient, type OpenAiClientOptions, type OpenAiEmbeddingsSdk } from "../src/embeddings/openai";
import { DdserveError } from "../src/errors";

describe("createOpenAiEmbeddingClient", () => {
  test("creates batch embeddings through an injected OpenAI-compatible client", async () => {
    const config = parseConfig({
      openai: {
        apiKeyEnv: "OPENAI_TEST_KEY",
        baseURL: "http://localhost:11434/v1",
        embeddingModel: "local-embedding-model",
      },
    });
    const calls: unknown[] = [];
    let clientOptions: OpenAiClientOptions | undefined;

    const client = createOpenAiEmbeddingClient(config, {
      env: { OPENAI_TEST_KEY: "env-secret" },
      clientFactory: (options) => {
        clientOptions = options;
        return fakeEmbeddingsSdk(async (params) => {
          calls.push(params);
          return {
            data: [
              { index: 1, embedding: [3, 4] },
              { index: 0, embedding: [1, 2] },
            ],
          };
        });
      },
    });

    await expect(client.createEmbeddings(["one", "two"])).resolves.toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(clientOptions).toEqual({
      apiKey: "env-secret",
      baseURL: "http://localhost:11434/v1",
    });
    expect(calls).toEqual([
      {
        model: "local-embedding-model",
        input: ["one", "two"],
      },
    ]);
  });

  test("uses an internal placeholder key when no API key is configured", async () => {
    const config = parseConfig({
      openai: {
        baseURL: "http://localhost:11434/v1",
      },
    });
    let clientOptions: OpenAiClientOptions | undefined;

    const client = createOpenAiEmbeddingClient(config, {
      env: {},
      clientFactory: (options) => {
        clientOptions = options;
        return fakeEmbeddingsSdk(async () => ({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        }));
      },
    });

    await expect(client.createEmbeddings("hello")).resolves.toEqual([[1, 2, 3]]);
    expect(clientOptions?.baseURL).toBe("http://localhost:11434/v1");
    expect(typeof clientOptions?.apiKey).toBe("string");
    expect(clientOptions?.apiKey.length).toBeGreaterThan(0);
  });

  test("removes unpaired surrogates before sending embedding requests", async () => {
    const config = parseConfig({ embeddings: { enabled: true } });
    const calls: unknown[] = [];
    const client = createOpenAiEmbeddingClient(config, {
      env: {},
      clientFactory: () =>
        fakeEmbeddingsSdk(async (params) => {
          calls.push(params);
          return {
            data: [{ index: 0, embedding: [1, 2, 3] }],
          };
        }),
    });

    await expect(client.createEmbeddings("broken \uDD2C but valid 🔬 stays \uD83D")).resolves.toEqual([[1, 2, 3]]);
    expect(calls).toEqual([
      {
        model: "text-embedding-3-small",
        input: "broken  but valid 🔬 stays ",
      },
    ]);
  });

  test("rejects invalid response dimensions", async () => {
    const config = parseConfig({ embeddings: { enabled: true } });
    const client = createOpenAiEmbeddingClient(config, {
      env: {},
      clientFactory: () =>
        fakeEmbeddingsSdk(async () => ({
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: [3] },
          ],
        })),
    });

    await expect(client.createEmbeddings(["one", "two"])).rejects.toThrow("dimensions mismatch");
  });

  test("wraps SDK errors with a DdserveError and preserves the cause", async () => {
    const config = parseConfig({ embeddings: { enabled: true } });
    const cause = new Error("upstream unavailable");
    const client = createOpenAiEmbeddingClient(config, {
      env: {},
      clientFactory: () =>
        fakeEmbeddingsSdk(async () => {
          throw cause;
        }),
    });

    try {
      await client.createEmbeddings("hello");
      throw new Error("expected createEmbeddings to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DdserveError);
      expect((error as Error).message).toContain("OpenAI embedding request failed: upstream unavailable");
      expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });
});

function fakeEmbeddingsSdk(
  create: OpenAiEmbeddingsSdk["embeddings"]["create"],
): OpenAiEmbeddingsSdk {
  return {
    embeddings: {
      create,
    },
  };
}
