import OpenAI from "openai";
import type { ClientOptions } from "openai";

import type { DdserveConfig } from "../config";
import { resolveOpenAiApiKey } from "../config";
import { DdserveError, getErrorMessage } from "../errors";
import { removeUnpairedSurrogates } from "../unicode";

const INTERNAL_API_KEY_PLACEHOLDER = "ddserve-local-openai-compatible-endpoint";

export type EmbeddingInput = string | readonly string[];
export type EmbeddingVector = number[];

export interface EmbeddingClient {
  createEmbeddings(input: EmbeddingInput): Promise<EmbeddingVector[]>;
}

export interface OpenAiClientOptions {
  apiKey: string;
  baseURL?: string;
}

interface OpenAiEmbeddingCreateParams {
  model: string;
  input: string | string[];
}

interface OpenAiEmbeddingData {
  index: unknown;
  embedding: unknown;
}

interface OpenAiEmbeddingResponse {
  data: OpenAiEmbeddingData[];
}

export interface OpenAiEmbeddingsSdk {
  embeddings: {
    create(params: OpenAiEmbeddingCreateParams): Promise<OpenAiEmbeddingResponse>;
  };
}

export type OpenAiClientFactory = (options: OpenAiClientOptions) => OpenAiEmbeddingsSdk;

export interface OpenAiEmbeddingClientOptions {
  env?: NodeJS.ProcessEnv;
  clientFactory?: OpenAiClientFactory;
}

export function createOpenAiEmbeddingClient(
  config: DdserveConfig,
  options: OpenAiEmbeddingClientOptions = {},
): EmbeddingClient {
  if (!config.openai) {
    throw new DdserveError("OpenAI embeddings are not configured");
  }

  const apiKey = resolveOpenAiApiKey(config, options.env)?.value ?? INTERNAL_API_KEY_PLACEHOLDER;
  const clientOptions: OpenAiClientOptions = {
    apiKey,
    ...(config.openai.baseURL ? { baseURL: config.openai.baseURL } : {}),
  };
  const clientFactory = options.clientFactory ?? defaultOpenAiClientFactory;

  return new OpenAiEmbeddingClient(clientFactory(clientOptions), config.openai.embeddingModel);
}

function defaultOpenAiClientFactory(options: OpenAiClientOptions): OpenAiEmbeddingsSdk {
  const sdkOptions: ClientOptions = {
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? null,
  };

  return new OpenAI(sdkOptions);
}

class OpenAiEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly client: OpenAiEmbeddingsSdk,
    private readonly model: string,
  ) {}

  async createEmbeddings(input: EmbeddingInput): Promise<EmbeddingVector[]> {
    const normalizedInput = normalizeEmbeddingInput(input);

    let response: OpenAiEmbeddingResponse;
    try {
      response = await this.client.embeddings.create({
        model: this.model,
        input: normalizedInput,
      });
    } catch (error) {
      throw new DdserveError(`OpenAI embedding request failed: ${getErrorMessage(error)}`, { cause: error });
    }

    return extractEmbeddingVectors(response, expectedEmbeddingCount(normalizedInput));
  }
}

function normalizeEmbeddingInput(input: EmbeddingInput): string | string[] {
  if (typeof input === "string") {
    return removeUnpairedSurrogates(input);
  }

  if (input.length === 0) {
    throw new DdserveError("Embedding input must include at least one text value");
  }

  return input.map((text) => removeUnpairedSurrogates(text));
}

function expectedEmbeddingCount(input: string | string[]): number {
  return typeof input === "string" ? 1 : input.length;
}

function extractEmbeddingVectors(response: OpenAiEmbeddingResponse, expectedCount: number): EmbeddingVector[] {
  if (!response || !Array.isArray(response.data)) {
    throw new DdserveError("OpenAI embedding response was invalid: expected a data array");
  }

  if (response.data.length !== expectedCount) {
    throw new DdserveError(
      `OpenAI embedding response was invalid: expected ${expectedCount} embeddings, received ${response.data.length}`,
    );
  }

  const vectors: Array<EmbeddingVector | undefined> = new Array(expectedCount);
  let dimensions: number | undefined;

  for (const item of response.data) {
    const index = item.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= expectedCount) {
      throw new DdserveError("OpenAI embedding response was invalid: embedding index was out of range");
    }

    if (vectors[index] !== undefined) {
      throw new DdserveError("OpenAI embedding response was invalid: duplicate embedding index");
    }

    if (!Array.isArray(item.embedding)) {
      throw new DdserveError("OpenAI embedding response was invalid: embedding vector was not an array");
    }

    const vector = validateEmbeddingVector(item.embedding, index, dimensions);
    dimensions = dimensions ?? vector.length;
    vectors[index] = vector;
  }

  if (vectors.some((vector) => vector === undefined)) {
    throw new DdserveError("OpenAI embedding response was invalid: missing embedding vector");
  }

  return vectors as EmbeddingVector[];
}

function validateEmbeddingVector(vector: unknown[], index: number, dimensions: number | undefined): EmbeddingVector {
  if (vector.length === 0) {
    throw new DdserveError(`OpenAI embedding response was invalid: embedding at index ${index} was empty`);
  }

  if (dimensions !== undefined && vector.length !== dimensions) {
    throw new DdserveError(
      `OpenAI embedding response dimensions mismatch: expected ${dimensions}, received ${vector.length} at index ${index}`,
    );
  }

  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DdserveError(`OpenAI embedding response was invalid: embedding at index ${index} contained non-numeric values`);
    }
  }

  return [...vector] as EmbeddingVector;
}
