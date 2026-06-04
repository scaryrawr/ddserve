---
name: ddserve-docs-mcp
description: Use this skill when a task would benefit from current documentation for external APIs, frameworks, libraries, runtimes, CLIs, language features, or package behavior before making decisions or code changes. Prefer it for documentation-backed API usage; avoid it for purely repository-internal edits.
---

# ddserve Docs MCP

## When to use

Use this skill when a task may depend on external documentation that could affect the correctness of the answer or code change: runtime APIs, framework routes and handlers, TypeScript options or syntax, browser APIs, package manager commands, migration behavior, or dependency-specific error messages.

Do not use it for simple repository-internal edits, renames, formatting, typo fixes, or changes where the relevant behavior is fully defined by local code and tests.

## Workflow

1. Check whether the session-start context already lists installed ddserve docsets or prompt-specific matches. If it does, use that as the first hint instead of listing docsets again.
2. If documentation may help and available docsets are unknown, call `ddserve-list_docsets` once. Choose likely docsets from the task, dependency names, imports, config files, error messages, and local package manifests.
3. Before changing API-dependent code, call `ddserve-search_docs` with a targeted query. Prefer `languages` aliases or known `slugs` when the relevant docset is clear. Include the exact API, option, error, or migration term in the query.
4. Read the most relevant results with `ddserve-get_page_content`. Use line ranges for long pages and read enough context to confirm signatures, defaults, constraints, and examples.
5. Apply the documented behavior to the implementation, tests, or explanation. If the docs contradict your first assumption, follow the docs and adjust the plan.
6. If the ddserve MCP tools are unavailable, no relevant docset is installed, or search has no useful result, say that briefly and continue using local code, tests, and other allowed sources.

## Guardrails

- Use ddserve as a read-only documentation source; never ask it to mutate local files or cache state.
- Do not paste long documentation excerpts into the final answer. Mention the specific docset or page only when it helps explain a decision.
- Do not keep searching after the relevant API behavior is confirmed.
- Avoid performative tool use. If the task is obviously local and docs will not change the answer, skip ddserve.
