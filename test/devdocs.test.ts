import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAvailableDocsets, normalizeDocsets } from "../src/devdocs";
import type { HttpClient } from "../src/http";

describe("normalizeDocsets", () => {
  test("normalizes and sorts DevDocs metadata", () => {
    expect(
      normalizeDocsets([
        { name: "Zed", slug: "zed", alias: ["z"] },
        { name: "Alpha", slug: "alpha", type: "platform", release: "1.2", db_size: 1024, alias: "a" },
      ]),
    ).toEqual([
      {
        source: "devdocs",
        name: "Alpha",
        slug: "alpha",
        type: "platform",
        release: "1.2",
        version: undefined,
        mtime: undefined,
        dbSize: 1024,
        aliases: ["a"],
      },
      {
        source: "devdocs",
        name: "Zed",
        slug: "zed",
        type: "zed",
        release: undefined,
        version: undefined,
        mtime: undefined,
        dbSize: undefined,
        aliases: ["z"],
      },
    ]);
  });
});

describe("getAvailableDocsets", () => {
  test("falls back to cached source index when refresh fails", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "ddserve-source-test-"));
    const successfulClient: HttpClient = {
      async fetchJson<T>() {
        return [{ name: "HTTP", slug: "http", mtime: 1 }] as T;
      },
      async downloadFile() {
        throw new Error("not used");
      },
    };
    await getAvailableDocsets({ cacheRoot, http: successfulClient, now: new Date("2026-01-01T00:00:00Z") });

    const failingClient: HttpClient = {
      async fetchJson<T>() {
        throw new Error("offline");
      },
      async downloadFile() {
        throw new Error("not used");
      },
    };
    const result = await getAvailableDocsets({ cacheRoot, http: failingClient });

    expect(result.fromCache).toBe(true);
    expect(result.warnings[0]).toContain("Failed to refresh");
    expect(result.docsets[0]?.slug).toBe("http");
  });
});
