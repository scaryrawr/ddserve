# ddserve Repository Guidelines

## Project Structure & Module Organization

`ddserve` is a Bun + TypeScript CLI/API for mirroring DevDocs into a local Markdown cache, embedding chunks, searching them, and serving a read-only JSON API. `index.ts` is the executable entrypoint and delegates to `src/cli.ts`. Core modules live in `src/`: `cache.ts` and `config.ts` handle filesystem/env resolution, `devdocs.ts` and `install.ts` download/convert docsets, `embeddings/*` manages chunking/OpenAI-compatible embeddings/SQLite storage, `search/*` handles filters and ranking, and `server.ts` defines the Elysia API. Tests live in `test/*.test.ts` and rely heavily on injected HTTP/embedding clients and temporary cache roots.

## Build, Test, and Development Commands

Use Bun for all local commands; do not substitute npm/node runners.

- `bun install` — install dependencies from `bun.lock`.
- `bun run ddserve --help` — run the CLI from the checkout.
- `bun run typecheck` — strict TypeScript validation via `tsgo --noEmit`.
- `bun test` — full unit/integration-style test suite.
- `bun test test/config.test.ts` — narrow test command for one area.

Recommended validation before handoff: `bun run typecheck && bun test`.

## Coding Style & Naming Conventions

TypeScript is strict (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). Keep imports extensionless as in the existing code, use 2-space indentation and semicolons, and prefer explicit exported interfaces/types near the module that owns them. CLI and service code should accept injected dependencies (`env`, `http`, `embeddingClient`, `now`, output callbacks) so tests avoid real network and secrets.

## Testing Guidelines

Use `bun:test`. Add tests beside existing area tests using `describe`/`test` and temp directories cleaned in `afterEach`. Prefer fixture HTTP clients and fake embedding clients over live DevDocs/OpenAI calls. When manually exercising install/update/search, set `DDSERVE_CACHE_DIR` to a temporary path so you do not mutate a developer’s real `~/.cache/ddserve`.

## Security & Configuration Tips

Config resolution is `--config`, then `DDSERVE_CONFIG`, then `~/.config/ddserve/config.json`; cache resolution is `DDSERVE_CACHE_DIR`, then `XDG_CACHE_HOME/ddserve`, then `~/.cache/ddserve`. Keep API keys/tokens in env vars (`OPENAI_API_KEY`, `DDSERVE_API_TOKEN`) or ignored local config. The server API intentionally omits local filesystem paths; preserve that behavior when changing search, docset, or error responses.

## Agent Skills

Project skills live in `.agents/skills/<name>/SKILL.md`. Currently no project skills are defined; create new ones there when a reusable multi-step workflow is useful (e.g. repo bootstrap, PR hygiene, or common code-gen tasks).
