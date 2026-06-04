# ddserve Docs MCP Skill Evals

These evals compare whether the skill leads Copilot CLI to use ddserve MCP documentation before documentation-sensitive code changes.

Run them from a disposable checkout or worktree. The harness executes against the project root, but prompts use small input fixtures and ask for outputs under the eval outputs directory instead of direct repository edits.

## Prerequisites

1. Install and index docsets that the eval prompts reference, such as `bun`, `typescript`, `javascript`, and `react`.
2. Start ddserve on the plugin's configured endpoint:

   ```sh
   bun run ddserve serve --host 127.0.0.1 --port 43877
   ```

3. Ensure Copilot CLI can load local MCP and hook endpoints from this checkout. For hook calls, include `COPILOT_HOOK_ALLOW_LOCALHOST=1` in the Copilot environment.
4. Verify a Copilot CLI session can see the `ddserve-list_docsets`, `ddserve-search_docs`, and `ddserve-get_page_content` tools before interpreting task-eval results.

## Task evals

```sh
cd /Users/mike/.agents/skills/skill-creator
python3 -m scripts.run_harness_eval \
  --evals /Users/mike/GitHub/ddserve/skills/ddserve-docs-mcp/evals/evals.json \
  --skill-path /Users/mike/GitHub/ddserve/skills/ddserve-docs-mcp \
  --workspace /Users/mike/GitHub/ddserve/.test-work/ddserve-docs-mcp-evals \
  --project-root /Users/mike/GitHub/ddserve \
  --harness copilot \
  --runs-per-config 1 \
  --num-workers 1 \
  --timeout 240
```

After runs finish, grade each run against its `eval_metadata.json`, aggregate, and generate the review page:

```sh
python3 -m scripts.aggregate_benchmark \
  /Users/mike/GitHub/ddserve/.test-work/ddserve-docs-mcp-evals/iteration-1 \
  --skill-name ddserve-docs-mcp

python3 eval-viewer/generate_review.py \
  /Users/mike/GitHub/ddserve/.test-work/ddserve-docs-mcp-evals/iteration-1 \
  --skill-name ddserve-docs-mcp \
  --benchmark /Users/mike/GitHub/ddserve/.test-work/ddserve-docs-mcp-evals/iteration-1/benchmark.json \
  --static /Users/mike/GitHub/ddserve/.test-work/ddserve-docs-mcp-evals/iteration-1/review.html
```

## Trigger evals

```sh
cd /Users/mike/.agents/skills/skill-creator
python3 -m scripts.run_eval \
  --eval-set /Users/mike/GitHub/ddserve/skills/ddserve-docs-mcp/evals/trigger-evals.json \
  --skill-path /Users/mike/GitHub/ddserve/skills/ddserve-docs-mcp \
  --harness copilot \
  --runs-per-query 3 \
  --project-root /Users/mike/GitHub/ddserve \
  --verbose
```
