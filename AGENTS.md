# AGENTS.md

## What this is

OpenCode plugin that tracks LiteLLM proxy costs/tokens. Two source files (`index.ts`, `tracker.ts`), no build step — Bun runs TypeScript directly.

## Commands

```bash
bun install          # install deps
bun test             # run all tests (bun:test, discovers *.test.ts)
bunx tsc --noEmit    # typecheck
```

No lint, format, CI, or build commands exist.

## Architecture

- `index.ts` — Plugin entry point. Exports `LiteLLMCostPlugin` (named + default). Registers event hooks and four tool commands.
- `tracker.ts` — Pure logic: config resolution, LiteLLM API calls, cost calculation, file persistence, period aggregation, formatting.
- Tests mock `globalThis.fetch` and the OpenCode client SDK; no external services needed.

## Key conventions

- **ESM only** (`"type": "module"`). Target and module are both ESNext.
- **No build artifact** — `.ts` files are the distributable. OpenCode's plugin system executes them via Bun.
- **Strict TypeScript** — `tsconfig.json` has `strict: true`.
- **Atomic file writes** — persistence uses write-to-temp-then-rename.
- **Graceful degradation** — all external calls are wrapped in try/catch; the plugin must never throw unhandled exceptions.
- **`baseUrl` and `baseURL`** are both accepted in config options (do not remove either).
- **`baseURL` must NOT include `/v1`** — LiteLLM management endpoints are at the root.

## Environment (runtime)

| Variable | Required | Default |
|----------|----------|---------|
| `LITELLM_API_KEY` | Yes | — |
| `LITELLM_BASE_URL` | No | `http://localhost:4000` |
| `LITELLM_COST_ALERT_THRESHOLD` | No | `1.0` |

## Testing notes

- Tests use `/tmp/opencode/` for filesystem operations.
- `loadCostData` accepts an optional `filePath` param for test isolation.
- Persistence path in production is hardcoded to `~/.config/opencode/plugin-cost.json`.
