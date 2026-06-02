import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";

import { HttpError, getErrorMessage } from "./errors";
import type { DownloadedFile } from "./types";

export interface HttpClient {
  fetchJson<T>(url: string): Promise<T>;
  downloadFile(url: string, destination: string): Promise<DownloadedFile>;
}

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
}

export class FetchHttpClient implements HttpClient {
  constructor(private readonly options: FetchOptions = {}) {}

  async fetchJson<T>(url: string): Promise<T> {
    const response = await fetchWithRetry(url, this.options);
    const text = await response.text();
    return JSON.parse(text) as T;
  }

  async downloadFile(url: string, destination: string): Promise<DownloadedFile> {
    const response = await fetchWithRetry(url, this.options);
    if (!response.body) {
      throw new HttpError(`No response body for ${url}`, response.status, url);
    }

    await mkdir(dirname(destination), { recursive: true });
    const tempFile = `${destination}.${process.pid}.${Date.now()}.tmp`;
    const file = createWriteStream(tempFile);
    const hash = createHash("sha256");
    let bytes = 0;

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        bytes += chunk.byteLength;
        hash.update(chunk);
        if (!file.write(chunk)) {
          await once(file, "drain");
        }
      }
      file.end();
      await once(file, "finish");
      await rename(tempFile, destination);
    } catch (error) {
      file.destroy();
      await rm(tempFile, { force: true });
      throw error;
    }

    return {
      path: destination,
      bytes,
      sha256: hash.digest("hex"),
    };
  }
}

async function fetchWithRetry(url: string, options: FetchOptions): Promise<Response> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: abortController.signal,
        headers: {
          "user-agent": "ddserve/0.1.0",
          "accept": "application/json,text/html,*/*",
        },
      });

      if (response.ok) {
        return response;
      }

      if (!isRetryableStatus(response.status) || attempt === retries) {
        throw new HttpError(`Request failed with HTTP ${response.status}: ${url}`, response.status, url);
      }

      lastError = new HttpError(`Request failed with HTTP ${response.status}: ${url}`, response.status, url);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error instanceof HttpError
          ? error
          : new Error(`Request failed for ${url}: ${getErrorMessage(error)}`, { cause: error });
      }
    } finally {
      clearTimeout(timeout);
    }

    await sleep(250 * (attempt + 1));
  }

  throw new Error(`Request failed for ${url}: ${getErrorMessage(lastError)}`, { cause: lastError });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
