# ddserve Repository Guidelines

## Project Structure & Module Organization

`ddserve` is a Bun + TypeScript CLI/API for mirroring DevDocs into a local Markdown cache, indexing chunks with OpenAI-compatible embeddings, searching them, and serving read-only REST and MCP endpoints. `index.ts` is the executable entrypoint and delegates to `src/cli.ts`. Core modules live in `src/`: `cache.ts`/`config.ts` resolve filesystem and env state, `devdocs.ts`/`install.ts` download, convert, update, and remove docsets, `embeddings/*` manages chunking/SQLite/vector clients, `search/*` handles filters and ranking, `server.ts` defines the Elysia API, and `mcp.ts` defines MCP tools/resources. Tests are in `test/*.test.ts`.

## Build, Test, and Development Commands

Use Bun for all local commands; do not substitute npm/node runners.

- `bun install` — install dependencies from `bun.lock`.
- `bun run ddserve --help` — run the checkout CLI.
- `bun run ddserve docs install <slug...>` / `docs update [slug]` / `docs remove <slug>` — mutate the local doc cache.
- `bun run typecheck` — strict TypeScript validation via `tsgo --noEmit`.
- `bun test` — full test suite.
- `bun test test/config.test.ts` — narrow test command.

No lint or formatter script is defined. Preferred handoff validation: `bun run typecheck && bun test`.

## Coding Style & Naming Conventions

TypeScript is strict (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). Keep imports extensionless, use 2-space indentation and semicolons, and prefer exported interfaces/types near the owning module. CLI and service code should accept injected dependencies (`env`, `http`, `embeddingClient`, `now`, output callbacks) so tests avoid real network calls and secrets.

## Testing Guidelines

Use `bun:test` with `describe`/`test`. Add tests beside the affected area, using fixture HTTP clients, fake embedding clients, and temporary cache roots cleaned with `afterEach`/`afterAll` (often under `.test-work`). When manually exercising install/update/remove/search, set `DDSERVE_CACHE_DIR` to a temporary path so you do not mutate `~/.cache/ddserve`.

## Commit & Pull Request Guidelines

Recent history uses Conventional-style subjects such as `feat: ...` and `fix(cli): ...`; follow that pattern. Before a PR, note cache/schema/API behavior changes and include the focused test command plus full validation when run.

## Security & Configuration Tips

Config resolution is `--config`, then `DDSERVE_CONFIG`, then `~/.config/ddserve/config.json`; cache resolution is `DDSERVE_CACHE_DIR`, then `XDG_CACHE_HOME/ddserve`, then `~/.cache/ddserve`. Keep API keys/tokens in env vars (`OPENAI_API_KEY`, `DDSERVE_API_TOKEN`) or ignored local config. The read-only server/MCP API intentionally omits local filesystem paths; preserve that for search, docset, page, and error responses.

## Agent Skills

Project skills live in `.agents/skills/<name>/SKILL.md`. Currently no project skills are defined; create one only for a reusable ddserve-specific workflow too detailed for this file.
