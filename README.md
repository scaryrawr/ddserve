# ddserve

`ddserve` is a Bun + TypeScript CLI for mirroring [DevDocs](https://devdocs.io/) docsets into a local Markdown cache, indexing those pages with OpenAI-compatible embeddings, searching the indexed chunks, and serving the cached documentation through a read-only JSON API and MCP endpoint.

It is currently a local project/package rather than a published npm package.

## Features

- Lists DevDocs docsets from `https://devdocs.io/docs.json`.
- Installs DevDocs docsets by downloading `index.json` and `db.json` from `https://documents.devdocs.io`.
- Converts DevDocs HTML pages into Markdown files while retaining the raw downloaded JSON assets.
- Updates one docset or every installed docset, with per-docset install locks.
- Stores embedding chunks and vectors in a local SQLite database.
- Searches indexed chunks semantically, with keyword fallback when no vectors exist for the configured model/scope.
- Exposes installed docsets, Markdown page content, search, embedding status, and MCP tools/resources through a read-only HTTP server.

## Requirements

- [Bun](https://bun.sh/) for running, testing, and SQLite support via `bun:sqlite`.
- Network access to DevDocs for listing/installing/updating docsets, unless you are only reading an existing cache.
- An OpenAI-compatible embeddings endpoint for embedding refresh/rebuild and search.

## Setup

```sh
bun install
```

Run the CLI from the checkout with:

```sh
bun run ddserve --help
```

## Quick start

```sh
# Show where the cache will be stored.
bun run ddserve cache path

# Refresh/list available DevDocs docsets.
bun run ddserve docs available

# Install a docset as Markdown.
bun run ddserve docs install http

# List installed docsets.
bun run ddserve docs installed

# Configure embeddings, then index installed docs.
bun run ddserve embeddings refresh http

# Search indexed chunks.
bun run ddserve search "request headers" --slug http

# Serve the read-only API.
bun run ddserve serve --host 127.0.0.1 --port 43877
```

## Commands

| Command | Description |
| --- | --- |
| `cache path` | Print the resolved cache root. |
| `sources list [--json]` | List configured documentation sources. DevDocs is the only source. |
| `docs available [--json] [--offline]` | List available DevDocs docsets. By default this refreshes `docs.json`; `--offline` requires the cached source index. |
| `docs installed [--json]` | List installed docsets from the local cache manifest. |
| `docs install <slug> [--json] [--force] [--offline]` | Install or update one DevDocs docset. |
| `docs update [slug] [--json] [--force] [--offline]` | Update one docset when `slug` is provided, otherwise update every installed docset. |
| `embeddings status [slug] [--json]` | Show embedding database, installed/indexed counts, and current/stale/missing chunk counts. |
| `embeddings refresh [slug] [--json]` | Embed only chunks missing or stale for the configured model. |
| `embeddings rebuild [slug] [--json]` | Force re-embedding of all chunks for the configured model. |
| `search <query> [--slug ...] [--language ...] [--limit n] [--format text\|json\|xml] [--json]` | Search indexed documentation chunks. |
| `serve [--host host] [--port port]` | Start the read-only REST API server. |
| `config path` | Print the resolved config path. |
| `config show [--json]` | Print the loaded config with defaults and secrets redacted. With `--json`, includes path/found metadata. |

Global option:

```sh
bun run ddserve --config <path> <command>
```

`--offline` only controls whether `docs.json` source metadata is refreshed. Installing or updating a non-current docset still downloads that docset's `index.json` and `db.json` from DevDocs.

## Configuration

`ddserve` reads JSON config from the first configured path in this order:

1. `--config <path>`
2. `DDSERVE_CONFIG`
3. `~/.config/ddserve/config.json`

Example:

```json
{
  "openai": {
    "baseURL": "http://localhost:11434/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "embeddingModel": "text-embedding-3-small"
  },
  "embeddings": {
    "enabled": true,
    "batchSize": 64,
    "maxChunkChars": 2400,
    "overlapChars": 200
  },
  "serve": {
    "bindAddress": "127.0.0.1",
    "port": 43877,
    "auth": {
      "tokenEnv": "DDSERVE_API_TOKEN"
    },
    "cors": {
      "origins": ["http://localhost:3000"]
    }
  }
}
```

### OpenAI-compatible embeddings

The `openai` block configures the embeddings client used for document indexing and search query embeddings.

- `embeddingModel` defaults to `text-embedding-3-small`.
- `apiKeyEnv` defaults to `OPENAI_API_KEY`.
- `apiKey` is an optional inline fallback and is redacted by `config show`.
- `baseURL` is optional and can point at an OpenAI-compatible local service.
- If neither an environment key nor inline key is available, `ddserve` still constructs the client with an internal placeholder key so local no-auth endpoints can work.

Embeddings are disabled when no config file exists. Defining an `openai` block enables embeddings by default. Setting `"embeddings": { "enabled": true }` without an `openai` block also creates a default OpenAI config. Set `"embeddings": { "enabled": false }` to disable automatic embedding refreshes during `docs install` and `docs update`.

### Embedding chunking

- `batchSize` controls how many chunks are sent per embedding request.
- `maxChunkChars` and `overlapChars` control Markdown chunking.
- Defaults are `64`, `2400`, and `200`.
- `overlapChars` must be smaller than `maxChunkChars`.

Changing chunk sizing makes existing indexed chunks stale. Run `bun run ddserve embeddings refresh [slug]` after changing these values.

### Server config

The `serve` block configures `ddserve serve`.

- Default bind address/port are `127.0.0.1:43877`.
- CLI `--host` and `--port` override config values.
- Set `bindAddress` to `0.0.0.0` only when you intend remote clients to connect.
- If `serve.auth` is present, API routes under `/api` and the MCP endpoint at `/mcp` require `Authorization: Bearer <token>`. The token is read from `tokenEnv` or inline `token`; inline tokens are redacted by `config show`.
- `serve.cors.origins` accepts a string or array of strings. CORS is disabled unless origins are configured; `"*"` is allowed.

When bound to a specific local address, the server rejects unexpected `Host` headers. Binding to `0.0.0.0` or `::` disables that host allow-list check.

## Cache layout

The cache root is resolved from:

1. `DDSERVE_CACHE_DIR`
2. `$XDG_CACHE_HOME/ddserve`
3. `~/.cache/ddserve`

Layout:

```text
~/.cache/ddserve/
  manifest.json
  sources/
    devdocs/
      index.json
  docs/
    <slug>/
      manifest.json
      raw/
        docset.json
        index.json
        db.json
      pages/
        <page-id>.md
  embeddings/
    embeddings.sqlite
    embeddings.sqlite-wal
    embeddings.sqlite-shm
  locks/
    <slug>.lock/
      owner.json
```

`docs/<slug>/manifest.json` records upstream URLs, raw file hashes, extracted page metadata, install/update timestamps, content format, and skipped entries. Markdown files include a generated title and DevDocs path header. DevDocs `<pre>` blocks are emitted as fenced Markdown code blocks.

Embeddings are stored only in `embeddings/embeddings.sqlite`; no vector sidecar files are written. The SQLite WAL/SHM files appear when the database is open or has recently been written.

## Embeddings workflow

```sh
bun run ddserve embeddings status [slug]
bun run ddserve embeddings refresh [slug]
bun run ddserve embeddings rebuild [slug]
```

`embeddings status` reports:

- database path
- whether embeddings are enabled and configured
- installed docset/page counts
- indexed docset/page/chunk counts
- current, stale, and missing chunk counts for the configured model

`embeddings refresh` embeds only chunks that are missing or stale for the current config and deletes stale rows after a successful refresh. It is safe to rerun after interruption.

`embeddings rebuild` requires embeddings to be enabled and configured, then forces all chunks to be re-embedded even if they are already current.

`docs install` and `docs update` automatically call the refresh path when embeddings are enabled/configured. Embedding failures are reported as warnings and leave the documentation installed.

## Search

```sh
bun run ddserve search "array map"
bun run ddserve search "array map" --slug javascript,typescript --limit 5
bun run ddserve search "component state" --language react --language typescript --json
bun run ddserve search "component state" --language react --format xml
```

Search embeds the query with the configured OpenAI-compatible model, then searches chunks in `embeddings.sqlite`.

Important behavior:

- Search requires embeddings to be enabled and OpenAI settings to be configured, because the query itself must be embedded.
- Search does not read every Markdown file directly and does not update embeddings automatically.
- Run `embeddings refresh [slug]` or install/update with embeddings enabled before expecting results.
- If semantic vectors exist for the selected model/scope, search returns semantic results.
- If no semantic vectors exist for the selected model/scope, search falls back to keyword matching over indexed chunks in SQLite.
- If a docset has installed Markdown but no indexed chunks, keyword fallback has nothing to search.

Filters:

- `--slug` accepts exact installed docset slugs. It can be repeated or comma-separated.
- `--language` accepts installed docset slug, name, type, or DevDocs alias. It can be repeated or comma-separated.
- Combining `--slug` and `--language` creates a union of resolved docsets.

Formats:

- Text output is the default and includes local Markdown file paths.
- `--json` and `--format json` emit structured JSON with `installedFilePath` for each result.
- `--format xml` emits XML with escaped result fields.

Broad semantic search currently brute-forces vectors in the selected scope. Prefer `--slug`, `--language`, and modest `--limit` values for large caches.

## REST API server

Start the server:

```sh
bun run ddserve serve
bun run ddserve serve --host 0.0.0.0 --port 43877
```

Example requests:

```sh
curl http://127.0.0.1:43877/health
curl http://127.0.0.1:43877/api/docsets
curl 'http://127.0.0.1:43877/api/search?q=request%20headers&slug=http'
curl 'http://127.0.0.1:43877/api/docsets/http/pages?limit=20&q=headers'
# Replace <page-id> with an id returned by the pages endpoint.
curl 'http://127.0.0.1:43877/api/docsets/http/pages/<page-id>/content?startLine=1&endLine=20'
# MCP clients can connect to the stateless Streamable HTTP endpoint:
# http://127.0.0.1:43877/mcp
```

Endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /health` | Liveness check. |
| `GET /api` | API metadata and links. |
| `GET /api/docsets` | Installed docset summaries. |
| `GET /api/docsets/:slug` | Installed docset metadata. |
| `GET /api/docsets/:slug/pages?limit=&offset=&q=&type=` | Page metadata with pagination and filters. Default limit is `100`, max is `500`. |
| `GET /api/docsets/:slug/pages/:pageId` | Page metadata. |
| `GET /api/docsets/:slug/pages/:pageId/content?startLine=&endLine=` | Markdown content or a 1-based inclusive line range. |
| `GET /api/search?q=&slug=&language=&limit=` | Search indexed chunks. `slug` and `language` can be repeated or comma-separated. Default limit is `10`, max is `50`. |
| `POST /api/search` | Search with JSON body: `query`, optional `slugs` array, optional `languages` array, optional `limit`. |
| `GET /api/embeddings/status?detail=full` | Read-only embedding status. Without `detail=full`, expensive current/stale/missing recomputation is omitted. |
| `GET /api/embeddings/status/:slug?detail=full` | Read-only per-docset embedding status. |
| `POST /mcp` | MCP Streamable HTTP endpoint for read-only documentation tools and resources. |

The API is read-only. It does not install, update, refresh, rebuild, or otherwise mutate docsets or embeddings. API search results include stable IDs and links, but intentionally do not expose local cache file paths.

### MCP endpoint

`ddserve serve` also exposes a stateless MCP Streamable HTTP endpoint at `/mcp`. It uses the same cache, search index, host-header protection, bearer auth, and CORS configuration as the REST API.

Available MCP capabilities:

| Capability | Description |
| --- | --- |
| Tool `search_docs` | Searches installed documentation with `query`, optional `slugs`, optional `languages`, and optional `limit` (max `50`). Results include sanitized structured metadata and `ddserve://` page resource links. |
| Tool `get_page_content` | Reads Markdown content for `slug` and `pageId`, with optional 1-based `startLine` and `endLine`. |
| Resource `ddserve://docsets/{slug}/pages/{pageId}` | Reads full Markdown content for a page linked from search results. Page IDs in resource URIs are URL-encoded. |

MCP search has the same prerequisites and fallback behavior as REST/CLI search: embeddings must be configured to embed the query, semantic results are returned when vectors exist for the selected scope, and keyword fallback only searches chunks already indexed in SQLite.

## GitHub Copilot CLI plugin

This repository can be installed as a local GitHub Copilot CLI plugin:

```sh
copilot plugin install .
```

The plugin manifest in `plugin.json` loads the MCP server configuration from `.mcp.json`, which points Copilot CLI at the local `ddserve serve` endpoint. Start `ddserve` before using the plugin-provided MCP tools:

```sh
bun run ddserve serve --host 127.0.0.1 --port 43877
```

Reinstall the local plugin after changing plugin files so Copilot CLI refreshes its cached copy.

## Development

```sh
bun test
bun run typecheck
```
