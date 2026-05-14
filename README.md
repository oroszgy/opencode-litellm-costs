# opencode-litellm-cost-tracker

An [OpenCode](https://opencode.ai) plugin that tracks LiteLLM API costs and token usage per session, day, week, and month. Also queries your LiteLLM proxy for server-side spend reporting.

## Why?

OpenCode's built-in cost tracking can fail when using a LiteLLM proxy. This plugin:

1. Fetches model pricing directly from your LiteLLM instance
2. Calculates costs from token usage on every completed turn
3. Tracks input/output token counts alongside costs
4. Queries the LiteLLM server for actual recorded spend per API key

## Features

- **Local cost tracking** — calculates costs from token counts using cached model pricing
- **Token tracking** — records input and output tokens per session/day/week/month
- **Server-side spend** — queries LiteLLM's `/key/info` and `/spend/logs` for actual billed costs
- **Per-model breakdown** — dedicated `/cost-models` and `/spend-models` commands for model-level stats
- **Four commands** — `/cost`, `/spend`, `/cost-models`, `/spend-models`
- **Configurable alert** — one-time warning toast when session cost crosses a threshold
- **Persistent storage** — survives restarts via `~/.config/opencode/plugin-cost.json`
- **Graceful degradation** — never crashes the TUI, fails silently with debug logging

## Installation

### Step 1: Clone the plugin

```bash
git clone https://github.com/YOUR_USER/opencode-litellm-cost-tracker.git
cd opencode-litellm-cost-tracker
bun install
```

### Step 2: Register with OpenCode

You have three options:

#### Option A: Global plugin directory (recommended for all projects)

Symlink into the global plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf /absolute/path/to/opencode-litellm-cost-tracker/index.ts \
  ~/.config/opencode/plugins/litellm-cost-tracker.ts
```

#### Option B: Per-project plugin directory

Symlink into a specific project's `.opencode/plugins/`:

```bash
mkdir -p /path/to/your/project/.opencode/plugins
ln -sf /absolute/path/to/opencode-litellm-cost-tracker/index.ts \
  /path/to/your/project/.opencode/plugins/litellm-cost-tracker.ts
```

#### Option C: Explicit in opencode.json

Add to your `~/.config/opencode/opencode.json` (global) or project-level `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["/absolute/path/to/opencode-litellm-cost-tracker/index.ts", {
      "baseURL": "https://your-litellm-proxy.example.com",
      "apiKey": "sk-your-litellm-key",
      "alertThreshold": 5.0
    }]
  ]
}
```

### Step 3: Set up slash commands

Create the command files in the global config directory:

```bash
mkdir -p ~/.config/opencode/commands

cat > ~/.config/opencode/commands/cost.md << 'EOF'
---
description: Show LiteLLM API cost breakdown (session, today, week, month)
---
Call the cost tool to display the current LiteLLM API spending summary.
EOF

cat > ~/.config/opencode/commands/spend.md << 'EOF'
---
description: Fetch actual LiteLLM server-side spend for your API key
---
Call the spend tool to show the server-reported usage and costs from LiteLLM for today, this week, this month, and lifetime.
EOF

cat > ~/.config/opencode/commands/cost-models.md << 'EOF'
---
description: Show per-model cost breakdown from local tracking
---
Call the cost-models tool to display a per-model breakdown of locally tracked costs and token usage for this session, today, this week, and this month.
EOF

cat > ~/.config/opencode/commands/spend-models.md << 'EOF'
---
description: Show per-model spend breakdown from LiteLLM server
---
Call the spend-models tool to display a per-model spend breakdown from the LiteLLM server for today, this week, this month, and lifetime.
EOF
```

### Step 4: Restart OpenCode

Plugin and command changes only take effect after restarting OpenCode.

## Configuration

Configuration is resolved in order: **plugin options** > **environment variables** > **defaults**.

| Parameter | Env Variable | Default | Description |
|-----------|-------------|---------|-------------|
| `baseUrl` or `baseURL` | `LITELLM_BASE_URL` | `http://localhost:4000` | LiteLLM proxy base URL |
| `apiKey` | `LITELLM_API_KEY` | _(required)_ | Bearer token for LiteLLM API |
| `alertThreshold` | `LITELLM_COST_ALERT_THRESHOLD` | `1.0` | Session cost (USD) that triggers a warning toast |

### Environment variables

```bash
export LITELLM_BASE_URL="https://your-litellm-proxy.example.com"
export LITELLM_API_KEY="sk-your-litellm-key"
export LITELLM_COST_ALERT_THRESHOLD="5.0"
```

### Inline plugin options (in opencode.json)

```json
{
  "plugin": [
    ["/path/to/opencode-litellm-cost-tracker/index.ts", {
      "baseURL": "https://your-litellm-proxy.example.com",
      "apiKey": "sk-your-litellm-key",
      "alertThreshold": 5.0
    }]
  ]
}
```

Both `baseUrl` and `baseURL` are accepted (for consistency with other OpenCode provider configs that use `baseURL`).

> **Important**: The `baseURL` should point to your LiteLLM proxy's root (e.g., `https://your-proxy.example.com`), **not** the `/v1` path. LiteLLM serves management endpoints (`/key/info`, `/spend/logs`, `/model/info`) at the root level, not under `/v1`.

## Usage

### `/cost` — Local Cost & Token Tracking

Type `/cost` in the OpenCode TUI to see locally-tracked costs and tokens:

```
## LiteLLM Cost Summary (Local Tracking)

| Period       | Cost          | Tokens In    | Tokens Out   |
|--------------|---------------|--------------|--------------|
| This Session | $0.05         | 12.5K        | 3.2K         |
| Today        | $1.23         | 245K         | 62K          |
| This Week    | $4.56         | 920K         | 230K         |
| This Month   | $12.34        | 2.4M         | 610K         |

Session started: 5/14/2026, 8:00:00 AM
Alert threshold: $1.00
Models with pricing: 12
```

This data is calculated locally from token counts and cached model pricing. It updates after every completed assistant message.

### `/spend` — Server-Side Spend from LiteLLM

Type `/spend` to query the LiteLLM proxy for the actual recorded spend associated with your API key:

```
## LiteLLM Server Spend (Key: sk-Gg...uGhA)

| Period     | Spend         |
|------------|---------------|
| Today      | $1.45         |
| This Week  | $5.23         |
| This Month | $18.90        |
| Lifetime   | $42.50        |

Budget: $100.00 | Used: 42.5%

### Per-Model (Lifetime)
| Model                         | Spend         |
|-------------------------------|---------------|
| claude-opus-4-6               | $30.00        |
| claude-sonnet-4-6             | $12.50        |
```

This queries the LiteLLM API endpoints:
- `GET /key/info` — lifetime spend, budget, per-model breakdown
- `GET /spend/logs?api_key=...&start_date=...&end_date=...` — daily spend for time periods

### `/cost-models` — Per-Model Cost Breakdown (Local)

Type `/cost-models` to see a per-model breakdown from local tracking:

```
## Per-Model Cost Breakdown (Local Tracking)

### This Session
| Model                              | Cost          | Tokens In    | Tokens Out   |
|------------------------------------|---------------|--------------|--------------|
| claude-opus-4-6                    | $0.04         | 8.5K         | 2.1K         |
| claude-sonnet-4-6                  | $0.01         | 4.0K         | 1.1K         |

### Today
| Model                              | Cost          | Tokens In    | Tokens Out   |
|------------------------------------|---------------|--------------|--------------|
| claude-opus-4-6                    | $0.95         | 180K         | 45K          |
| claude-sonnet-4-6                  | $0.28         | 65K          | 17K          |

### This Week
...

### This Month
...
```

Shows per-model cost and token usage across all time periods. Useful for understanding which models consume the most resources.

### `/spend-models` — Per-Model Spend (Server)

Type `/spend-models` to see a combined per-model spend table from the LiteLLM server across all time periods:

```
## Per-Model Server Spend (Key: sk-Gg...uGhA)

| Model                                    | Today         | This Week     | This Month    | Lifetime      |
|------------------------------------------|---------------|---------------|---------------|---------------|
| bedrock/eu.anthropic.claude-opus-4-6-v1  | $12.83        | $45.20        | $120.50       | $350.00       |
| bedrock/eu.anthropic.claude-sonnet-4-6-v1| $0.00         | $3.50         | $15.00        | $52.55        |
```

Aggregates per-model data from the LiteLLM `/spend/logs` endpoint (for today/week/month) and `/key/info` (for lifetime). Models are sorted by spend descending.

### Alert Toast

When the session cost crosses the configured threshold (default `$1.00`), a one-time warning toast appears:

```
Cost alert: session has reached $1.05
```

This fires once per session and resets when you start a new session (`/new`).

## How It Works

### Local Tracking (`/cost`, `/cost-models`)

1. **Startup**: Fetches model pricing from `GET {baseUrl}/model/info` with `Authorization: Bearer {apiKey}`
2. **Per turn**: Listens for `message.updated` events. When an `AssistantMessage` completes:
   - If the built-in `cost` field is > 0, uses it directly
   - Otherwise, calculates cost from `tokens.input + tokens.cache.read` and `tokens.output + tokens.reasoning` using the pricing cache
   - Always records token counts regardless of cost availability
   - Tracks cost and tokens per model ID for per-model breakdown
3. **Deduplication**: Each message is processed exactly once (tracked by message ID)
4. **Persistence**: Writes to `~/.config/opencode/plugin-cost.json` after every turn

### Server Spend (`/spend`, `/spend-models`)

Queries LiteLLM's spend tracking endpoints live. This reflects what the proxy actually billed — useful for verifying local estimates against server records. The `/spend-models` command aggregates the per-model data from `/spend/logs` across time periods.

### Cost File Format

```json
{
  "sessions": {
    "session-id-1": {
      "cost": 0.05,
      "tokens": { "input": 12000, "output": 3000 },
      "startedAt": "2026-05-14T08:00:00.000Z",
      "models": {
        "claude-opus-4-6": { "cost": 0.04, "tokens": { "input": 10000, "output": 2500 } },
        "claude-sonnet-4-6": { "cost": 0.01, "tokens": { "input": 2000, "output": 500 } }
      }
    }
  },
  "daily": {
    "2026-05-14": {
      "cost": 1.23,
      "tokens": { "input": 245000, "output": 62000 },
      "models": {
        "claude-opus-4-6": { "cost": 0.95, "tokens": { "input": 180000, "output": 45000 } },
        "claude-sonnet-4-6": { "cost": 0.28, "tokens": { "input": 65000, "output": 17000 } }
      }
    }
  }
}
```

Weekly and monthly costs (and per-model breakdowns) are computed on-the-fly by summing relevant daily entries. Old data without the `models` field is automatically migrated on load.

## Error Handling

| Failure | Behavior |
|---------|----------|
| LiteLLM unreachable at startup | Logs warning, plugin loads but cannot calculate costs |
| API key missing | Logs warning, plugin loads in degraded mode |
| No pricing found for a model | Logs debug, tokens still tracked but cost is 0 |
| `/key/info` or `/spend/logs` fails | `/spend` shows available data, notes what couldn't be fetched |
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
├── index.ts           # Plugin entry point, event hooks, cost + spend tools
├── tracker.ts         # Pricing fetch, cost math, LiteLLM API, file persistence
├── index.test.ts      # Integration tests for plugin hooks and tools
├── tracker.test.ts    # Unit tests for tracker functions
├── package.json
├── tsconfig.json
└── .gitignore
```

## License

MIT
