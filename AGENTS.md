# ddserve Repository Guidelines

## Project Structure & Module Organization

`ddserve` is a Bun + TypeScript CLI/API that mirrors DevDocs into a Markdown cache, indexes/searches chunks, and serves read-only REST/MCP endpoints. `index.ts` delegates to `src/cli.ts`. Core modules live in `src/`: `cache.ts`/`config.ts` resolve filesystem and env state, `devdocs.ts`/`install.ts` mutate docsets, `embeddings/*` manages chunking/vector clients/SQLite, `search/*` handles filters/ranking, and `server.ts`/`mcp.ts`/`copilot-hooks.ts`/`pi-extension.ts` expose integrations. Tests are in `test/*.test.ts`. Root `skills/`, `plugin.json`, `.mcp.json`, and `hooks.json` are shipped Copilot CLI plugin assets, not agent instructions.

## Build, Test, and Development Commands

Use Bun for all local commands.

- `bun install` — install dependencies from `bun.lock`.
- `bun run ddserve --help` — run the checkout CLI.
- `bun run ddserve docs install <slug...>` / `docs update [slug]` / `docs remove <slug>` — mutate the local doc cache.
- `bun run typecheck` — strict TypeScript validation via `tsgo --noEmit`.
- `bun test` — full test suite; `bun test test/config.test.ts` is a narrow example.

No lint or formatter script is defined; hand off with `bun run typecheck && bun test`.

## Coding Style & Naming Conventions

TypeScript is strict (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). Keep imports extensionless, use 2-space indentation and semicolons. CLI/server/integration code should accept injected dependencies (`env`, `http`, `embeddingClient`, `now`, output callbacks, command runners) so tests avoid real network calls, shelling out, and secrets.

## Testing Guidelines

Use `bun:test` with fixture HTTP clients, fake embedding clients, in-memory Elysia `app.handle(...)` requests, and temporary cache roots cleaned with `afterEach`/`afterAll`. When manually exercising install/update/remove/search, set `DDSERVE_CACHE_DIR` to a temporary path so you do not mutate `~/.cache/ddserve`.

## Commit & Pull Request Guidelines

Use Conventional-style subjects such as `feat(plugin): ...` and `fix(hooks): ...`. Before a PR, note cache/schema/API/plugin changes and include focused and full validation commands.

## Security & Configuration Tips

Config resolution is `--config`, then `DDSERVE_CONFIG`, then `~/.config/ddserve/config.json`; cache resolution is `DDSERVE_CACHE_DIR`, then `XDG_CACHE_HOME/ddserve`, then `~/.cache/ddserve`. Keep API keys/tokens in env vars (`OPENAI_API_KEY`, `DDSERVE_API_TOKEN`) or ignored local config. The read-only server/MCP API intentionally omits local filesystem paths; preserve that for search, docset, page, and error responses.

## Agent-Specific Instructions

No repo-local `.agents/skills` workflows are defined. Add any under `.agents/skills/<name>/SKILL.md`; root `skills/` is product/plugin content covered by `test/plugin-skills.test.ts`.
