import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireDocsetLock, atomicWriteJson, cachePaths, resolveCacheRoot } from "../src/cache";

describe("cache paths", () => {
  test("uses explicit cache override first", () => {
    expect(resolveCacheRoot({ DDSERVE_CACHE_DIR: "~/custom-ddserve", XDG_CACHE_HOME: "/tmp/xdg" })).toContain("custom-ddserve");
  });

  test("uses XDG cache home when no override is set", () => {
    expect(resolveCacheRoot({ XDG_CACHE_HOME: "/tmp/xdg-cache" })).toBe("/tmp/xdg-cache/ddserve");
  });

  test("builds expected cache path structure", () => {
    const paths = cachePaths("/tmp/ddserve");
    expect(paths.devdocsSourceIndex).toBe("/tmp/ddserve/sources/devdocs/index.json");
    expect(paths.docsRoot).toBe("/tmp/ddserve/docs");
  });
});

describe("atomicWriteJson", () => {
  test("writes formatted JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ddserve-cache-test-"));
    const file = join(dir, "nested", "manifest.json");
    await atomicWriteJson(file, { ok: true });
    expect(await readFile(file, "utf8")).toBe('{\n  "ok": true\n}\n');
  });

  describe("acquireDocsetLock", () => {
    test("reclaims locks owned by a dead process", async () => {
      const root = await mkdtemp(join(tmpdir(), "ddserve-lock-test-"));
      const lockDir = join(root, "locks", "rust.lock");
      await mkdir(lockDir, { recursive: true });
      await atomicWriteJson(join(lockDir, "owner.json"), {
        pid: 999_999_999,
        createdAt: new Date().toISOString(),
      });

      const lock = await acquireDocsetLock(root, "rust");
      const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as { pid: number };

      expect(owner.pid).toBe(process.pid);
      await lock.release();
    });
  });
});
