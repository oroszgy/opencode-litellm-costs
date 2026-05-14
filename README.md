# opencode-litellm-cost-tracker

An [OpenCode](https://opencode.ai) plugin that tracks LiteLLM API costs per session, day, week, and month.

OpenCode's built-in cost tracking can fail when using a LiteLLM proxy. This plugin fetches model pricing directly from your LiteLLM instance and calculates costs from token usage on every turn.

## Features

- Tracks costs per **session**, **today**, **this week**, and **this month**
- Fetches model pricing from LiteLLM's `/model/info` endpoint at startup
- Falls back to OpenCode's built-in `cost` field when it's available (non-zero)
- Persists cost data across restarts in `~/.config/opencode/plugin-cost.json`
- Configurable alert threshold triggers a one-time warning toast per session
- `/cost` slash command for on-demand cost summary
- Graceful error handling — never crashes the TUI

## Installation

### Local (auto-discovered)

Place or symlink the plugin into your project's `.opencode/plugins/` directory:

```bash
# From your project root
mkdir -p .opencode/plugins
ln -s /path/to/opencode-litellm-cost-tracker/index.ts .opencode/plugins/litellm-cost-tracker.ts
```

### Via opencode.json

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./path/to/opencode-litellm-cost-tracker/index.ts", {
      "baseUrl": "http://localhost:4000",
      "apiKey": "sk-your-litellm-key",
      "alertThreshold": 1.0
    }]
  ]
}
```

## Configuration

Configuration is resolved in order: **plugin options** > **environment variables** > **defaults**.

| Parameter | Env Variable | Default | Description |
|-----------|-------------|---------|-------------|
| `baseUrl` | `LITELLM_BASE_URL` | `http://localhost:4000` | LiteLLM proxy base URL |
| `apiKey` | `LITELLM_API_KEY` | _(required)_ | Bearer token for LiteLLM API |
| `alertThreshold` | `LITELLM_COST_ALERT_THRESHOLD` | `1.0` | Session cost (in USD) that triggers a warning toast |

### Environment variables

```bash
export LITELLM_BASE_URL="http://localhost:4000"
export LITELLM_API_KEY="sk-your-litellm-key"
export LITELLM_COST_ALERT_THRESHOLD="5.0"
```

## Usage

### `/cost` command

Type `/cost` in the OpenCode TUI to get a cost summary:

```
## LiteLLM Cost Summary

| Period       | Cost          |
|--------------|---------------|
| This Session | $0.05         |
| Today        | $1.23         |
| This Week    | $4.56         |
| This Month   | $12.34        |

Session started: 5/14/2026, 8:00:00 AM
Alert threshold: $1.00
Models with pricing: 12
```

To enable the `/cost` command, create `.opencode/commands/cost.md`:

```markdown
---
description: Show LiteLLM API cost breakdown (session, today, week, month)
---
Call the cost tool to display the current LiteLLM API spending summary.
```

### Alert toast

When the session cost crosses the configured threshold, a one-time warning toast is displayed:

```
Cost alert: session has reached $1.05
```

This only fires once per session to avoid notification fatigue. It resets when you start a new session (`/new`).

## How It Works

1. **Startup**: Fetches model pricing from `GET {baseUrl}/model/info` with `Authorization: Bearer {apiKey}`
2. **Per turn**: Listens for `message.updated` events. When an `AssistantMessage` is completed:
   - If the built-in `cost` field is > 0, uses it directly
   - Otherwise, calculates cost from `tokens.input + tokens.cache.read` and `tokens.output + tokens.reasoning` using the pricing cache
3. **Deduplication**: Each message is processed exactly once (tracked by message ID)
4. **Persistence**: Writes accumulated costs to `~/.config/opencode/plugin-cost.json` after every turn

### Cost file format

```json
{
  "sessions": {
    "session-id-1": { "cost": 0.05, "startedAt": "2026-05-14T08:00:00.000Z" }
  },
  "daily": {
    "2026-05-14": 1.23,
    "2026-05-13": 0.45
  }
}
```

Weekly and monthly costs are computed on-the-fly by summing relevant daily entries.

## Error Handling

| Failure | Behavior |
|---------|----------|
| LiteLLM unreachable at startup | Logs warning, plugin loads but cannot calculate costs |
| API key missing | Logs warning, plugin loads in degraded mode |
| No pricing found for a model | Logs debug message, skips that message |
| Persistence file corrupted/missing | Starts fresh with empty data |
| Persistence write fails | Continues with in-memory data |

The plugin never throws unhandled exceptions or crashes the OpenCode TUI.

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime (used by OpenCode for plugins)

### Install dependencies

```bash
bun install
```

### Run tests

```bash
bun test
```

### Type check

```bash
bunx tsc --noEmit
```

## File Structure

```
opencode-litellm-cost-tracker/
├── index.ts           # Plugin entry point, event hooks, cost tool
├── tracker.ts         # Pricing fetch, cost math, file persistence
├── index.test.ts      # Integration tests for plugin hooks
├── tracker.test.ts    # Unit tests for tracker functions
├── package.json
├── tsconfig.json
└── .gitignore
```

## License

MIT
