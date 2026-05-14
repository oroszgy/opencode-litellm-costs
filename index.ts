import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  resolveConfig,
  fetchModelPricing,
  fetchKeyInfo,
  fetchSpendLogs,
  calculateCost,
  loadCostData,
  saveCostData,
  pruneOldData,
  addUsage,
  getSessionSummary,
  getTodaySummary,
  getWeekSummary,
  getMonthSummary,
  getSessionModelBreakdown,
  getTodayModelBreakdown,
  getWeekModelBreakdown,
  getMonthModelBreakdown,
  formatCost,
  formatTokens,
  maskApiKey,
  getTodayKey,
  getWeekStartKey,
  getMonthStartKey,
  type PricingMap,
  type CostData,
  type PluginConfig,
  type TokenUsage,
  type ModelUsageEntry,
} from "./tracker"

export const LiteLLMCostPlugin: Plugin = async ({ client }, options?) => {
  // --- Initialization ---
  const config: PluginConfig = resolveConfig(
    options as Record<string, unknown> | undefined
  )

  // Fetch model pricing from LiteLLM proxy (fail gracefully)
  let pricing: PricingMap = new Map()
  if (config.apiKey) {
    try {
      pricing = await fetchModelPricing(config)
      await client.app.log({
        body: {
          service: "litellm-cost-tracker",
          level: "info",
          message: `Loaded pricing for ${pricing.size} models from ${config.baseUrl}`,
        },
      })
    } catch (err) {
      await client.app.log({
        body: {
          service: "litellm-cost-tracker",
          level: "warn",
          message: `Failed to fetch model pricing: ${err instanceof Error ? err.message : String(err)}. Plugin will not track costs until pricing is available.`,
        },
      })
    }
  } else {
    await client.app.log({
      body: {
        service: "litellm-cost-tracker",
        level: "warn",
        message:
          "No LITELLM_API_KEY configured. Set LITELLM_API_KEY or pass apiKey in plugin options.",
      },
    })
  }

  // Load persisted cost data from disk and prune entries older than 90 days
  let costData: CostData = pruneOldData(loadCostData())
  saveCostData(costData)

  // Track current session and processed messages
  let currentSessionId: string | null = null
  let alertFired = false
  const processedMessages = new Set<string>()

  // --- Helper: look up pricing for a model ---
  function findPricing(modelID: string, providerID?: string) {
    // Try exact match first
    let p = pricing.get(modelID)
    if (p) return p

    // Try with provider prefix: "providerID/modelID"
    if (providerID) {
      p = pricing.get(`${providerID}/${modelID}`)
      if (p) return p
    }

    // Try suffix match: find a pricing key that ends with the model ID
    // (handles cases like "openai/gpt-4o" matching "gpt-4o")
    for (const [key, value] of pricing) {
      if (key.endsWith(`/${modelID}`)) {
        return value
      }
    }

    return null
  }

  // --- Helper: process a completed assistant message ---
  function processMessage(msg: {
    id: string
    sessionID: string
    modelID: string
    providerID: string
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    cost: number
    time: { completed?: number }
  }) {
    // Only process completed messages, and only once
    if (!msg.time.completed) return
    if (processedMessages.has(msg.id)) return
    processedMessages.add(msg.id)

    const sessionId = msg.sessionID || currentSessionId
    if (!sessionId) return

    // Calculate total input/output tokens
    const totalInput = msg.tokens.input + msg.tokens.cache.read
    const totalOutput = msg.tokens.output + msg.tokens.reasoning
    const tokens: TokenUsage = { input: totalInput, output: totalOutput }

    // Determine cost: use built-in cost if available, otherwise calculate
    let cost = 0
    if (msg.cost > 0) {
      cost = msg.cost
    } else {
      if (totalInput === 0 && totalOutput === 0) return

      const modelPricing = findPricing(msg.modelID, msg.providerID)
      if (!modelPricing) {
        void client.app.log({
          body: {
            service: "litellm-cost-tracker",
            level: "debug",
            message: `No pricing found for model "${msg.modelID}" (provider: ${msg.providerID}). Tokens: in=${totalInput}, out=${totalOutput}`,
          },
        }).catch(() => {})
        // Still track tokens even without cost
        costData = addUsage(costData, sessionId, 0, tokens, msg.modelID)
        saveCostData(costData)
        return
      }

      cost = calculateCost(totalInput, totalOutput, modelPricing)
    }

    // Accumulate cost and tokens
    costData = addUsage(costData, sessionId, cost, tokens, msg.modelID)
    saveCostData(costData)

    // Check alert threshold (fires once per session)
    const sessionSummary = getSessionSummary(costData, sessionId)
    if (!alertFired && sessionSummary.cost >= config.alertThreshold) {
      alertFired = true
      client.tui.showToast({
        body: {
          message: `Cost alert: session has reached ${formatCost(sessionSummary.cost)}`,
          variant: "warning",
        },
      })
    }
  }

  // --- Hooks ---
  return {
    // Listen for message and session events
    event: async ({ event }) => {
      switch (event.type) {
        case "message.updated": {
          const msg = event.properties.info
          if (msg.role === "assistant") {
            processMessage(msg)
          }
          break
        }

        case "message.part.updated": {
          const part = event.properties.part
          if (part.type === "step-finish" && part.cost > 0) {
            // Reserved for future per-step tracking
          }
          break
        }

        case "session.created": {
          currentSessionId = event.properties.info.id
          alertFired = false
          processedMessages.clear()
          break
        }

        case "session.updated": {
          if (!currentSessionId) {
            currentSessionId = event.properties.info.id
          }
          break
        }
      }
    },

    // Custom tools
    tool: {
      // /cost — local cost and token tracking
      cost: tool({
        description:
          "Returns a summary of locally tracked LiteLLM API costs and token usage for the current session, today, this week, and this month",
        args: {},
        async execute() {
          const sessionId = currentSessionId || "unknown"
          const session = getSessionSummary(costData, sessionId)
          const today = getTodaySummary(costData)
          const week = getWeekSummary(costData)
          const month = getMonthSummary(costData)

          const sessionEntry = costData.sessions[sessionId]
          const startedAt = sessionEntry?.startedAt
            ? new Date(sessionEntry.startedAt).toLocaleString()
            : "N/A"

          return [
            "## LiteLLM Cost Summary (Local Tracking)",
            "",
            "| Period       | Cost          | Tokens In    | Tokens Out   |",
            "|--------------|---------------|--------------|--------------|",
            `| This Session | ${formatCost(session.cost).padEnd(13)} | ${formatTokens(session.tokens.input).padEnd(12)} | ${formatTokens(session.tokens.output).padEnd(12)} |`,
            `| Today        | ${formatCost(today.cost).padEnd(13)} | ${formatTokens(today.tokens.input).padEnd(12)} | ${formatTokens(today.tokens.output).padEnd(12)} |`,
            `| This Week    | ${formatCost(week.cost).padEnd(13)} | ${formatTokens(week.tokens.input).padEnd(12)} | ${formatTokens(week.tokens.output).padEnd(12)} |`,
            `| This Month   | ${formatCost(month.cost).padEnd(13)} | ${formatTokens(month.tokens.input).padEnd(12)} | ${formatTokens(month.tokens.output).padEnd(12)} |`,
            "",
            `Session started: ${startedAt}`,
            `Alert threshold: ${formatCost(config.alertThreshold)}`,
            `Models with pricing: ${pricing.size}`,
          ].join("\n")
        },
      }),

      // /spend — server-side spend from LiteLLM API
      spend: tool({
        description:
          "Fetches actual spend and token usage from the LiteLLM proxy for the configured API key (today, this week, this month, and lifetime)",
        args: {},
        async execute() {
          if (!config.apiKey) {
            return "Error: No LITELLM_API_KEY configured. Cannot query server-side spend."
          }

          try {
            const maskedKey = maskApiKey(config.apiKey)
            const lines: string[] = [
              `## LiteLLM Server Spend (Key: ${maskedKey})`,
              "",
            ]

            // Fetch key info for lifetime spend + model breakdown
            const keyInfo = await fetchKeyInfo(config)

            // Fetch spend logs for period breakdowns
            const todayKey = getTodayKey()
            const weekStart = getWeekStartKey()
            const monthStart = getMonthStartKey()
            // Add one day to today for end_date (inclusive)
            const tomorrow = new Date()
            tomorrow.setDate(tomorrow.getDate() + 1)
            const endDate = tomorrow.toISOString().slice(0, 10)

            const [todayLogs, weekLogs, monthLogs] = await Promise.all([
              fetchSpendLogs(config, todayKey, endDate),
              fetchSpendLogs(config, weekStart, endDate),
              fetchSpendLogs(config, monthStart, endDate),
            ])

            // Aggregate spend from logs
            const sumSpend = (logs: { spend?: number }[]) =>
              logs.reduce((sum, entry) => sum + (entry.spend || 0), 0)

            const todaySpend = sumSpend(todayLogs)
            const weekSpend = sumSpend(weekLogs)
            const monthSpend = sumSpend(monthLogs)
            const lifetimeSpend = keyInfo?.info?.spend || 0

            lines.push("| Period     | Spend         |")
            lines.push("|------------|---------------|")
            lines.push(`| Today      | ${formatCost(todaySpend).padEnd(13)} |`)
            lines.push(`| This Week  | ${formatCost(weekSpend).padEnd(13)} |`)
            lines.push(`| This Month | ${formatCost(monthSpend).padEnd(13)} |`)
            lines.push(`| Lifetime   | ${formatCost(lifetimeSpend).padEnd(13)} |`)

            // Budget info
            if (keyInfo?.info?.max_budget) {
              const pct = ((lifetimeSpend / keyInfo.info.max_budget) * 100).toFixed(1)
              lines.push("")
              lines.push(
                `Budget: ${formatCost(keyInfo.info.max_budget)} | Used: ${pct}%`
              )
              if (keyInfo.info.budget_reset_at) {
                lines.push(`Resets: ${keyInfo.info.budget_reset_at}`)
              }
            }

            // Per-model breakdown: prefer key info, fall back to lifetime spend logs
            let modelSpend = keyInfo?.info?.model_spend
            if (!modelSpend || Object.keys(modelSpend).length === 0) {
              // Fetch lifetime spend logs from key creation date
              const keyCreatedAt = keyInfo?.info?.created_at
              const lifetimeStart = keyCreatedAt
                ? keyCreatedAt.slice(0, 10)
                : "2020-01-01"
              const lifetimeLogs = await fetchSpendLogs(config, lifetimeStart, endDate)
              const aggregated: Record<string, number> = {}
              for (const entry of lifetimeLogs) {
                const models = (entry as { models?: Record<string, number> }).models
                if (models) {
                  for (const [model, spend] of Object.entries(models)) {
                    aggregated[model] = (aggregated[model] || 0) + spend
                  }
                }
              }
              if (Object.keys(aggregated).length > 0) {
                modelSpend = aggregated
              }
            }

            if (modelSpend && Object.keys(modelSpend).length > 0) {
              lines.push("")
              lines.push("### Per-Model (Lifetime)")
              lines.push("| Model                                    | Spend         |")
              lines.push("|------------------------------------------|---------------|")

              const sorted = Object.entries(modelSpend).sort(
                ([, a], [, b]) => b - a
              )
              for (const [model, spend] of sorted) {
                lines.push(
                  `| ${model.padEnd(40)} | ${formatCost(spend).padEnd(13)} |`
                )
              }
            }

            // Note about data source
            if (!keyInfo && todayLogs.length === 0) {
              lines.push("")
              lines.push(
                "_Could not reach LiteLLM spend endpoints. Verify your API key has access._"
              )
            }

            return lines.join("\n")
          } catch (err) {
            return `Error fetching spend data: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      // /cost-models — per-model cost breakdown from local tracking
      "cost-models": tool({
        description:
          "Returns a per-model breakdown of locally tracked costs and token usage for the current session, today, this week, and this month",
        args: {},
        async execute() {
          const sessionId = currentSessionId || "unknown"
          const sessionModels = getSessionModelBreakdown(costData, sessionId)
          const todayModels = getTodayModelBreakdown(costData)
          const weekModels = getWeekModelBreakdown(costData)
          const monthModels = getMonthModelBreakdown(costData)

          const lines: string[] = [
            "## Per-Model Cost Breakdown (Local Tracking)",
            "",
          ]

          function renderModelTable(
            models: Record<string, ModelUsageEntry>
          ): string[] {
            const entries = Object.entries(models).sort(
              ([, a], [, b]) => b.cost - a.cost
            )
            if (entries.length === 0) return ["_No model data recorded._", ""]

            const rows: string[] = []
            rows.push(
              "| Model                              | Cost          | Tokens In    | Tokens Out   |"
            )
            rows.push(
              "|------------------------------------|---------------|--------------|--------------|"
            )
            for (const [model, usage] of entries) {
              rows.push(
                `| ${model.padEnd(34)} | ${formatCost(usage.cost).padEnd(13)} | ${formatTokens(usage.tokens.input).padEnd(12)} | ${formatTokens(usage.tokens.output).padEnd(12)} |`
              )
            }
            rows.push("")
            return rows
          }

          lines.push("### This Session")
          lines.push(...renderModelTable(sessionModels))

          lines.push("### Today")
          lines.push(...renderModelTable(todayModels))

          lines.push("### This Week")
          lines.push(...renderModelTable(weekModels))

          lines.push("### This Month")
          lines.push(...renderModelTable(monthModels))

          return lines.join("\n")
        },
      }),

      // /spend-models — per-model server-side spend from LiteLLM API
      "spend-models": tool({
        description:
          "Fetches per-model spend breakdown from the LiteLLM proxy for today, this week, this month, and lifetime",
        args: {},
        async execute() {
          if (!config.apiKey) {
            return "Error: No LITELLM_API_KEY configured. Cannot query server-side spend."
          }

          try {
            const maskedKey = maskApiKey(config.apiKey)
            const lines: string[] = [
              `## Per-Model Server Spend (Key: ${maskedKey})`,
              "",
            ]

            // Fetch key info for lifetime model breakdown
            const keyInfo = await fetchKeyInfo(config)

            // Fetch spend logs for period breakdowns
            const todayKey = getTodayKey()
            const weekStart = getWeekStartKey()
            const monthStart = getMonthStartKey()
            const tomorrow = new Date()
            tomorrow.setDate(tomorrow.getDate() + 1)
            const endDate = tomorrow.toISOString().slice(0, 10)

            const [todayLogs, weekLogs, monthLogs] = await Promise.all([
              fetchSpendLogs(config, todayKey, endDate),
              fetchSpendLogs(config, weekStart, endDate),
              fetchSpendLogs(config, monthStart, endDate),
            ])

            // Aggregate per-model spend from logs
            type LogEntry = { models?: Record<string, number>; spend?: number }
            function aggregateModels(
              logs: LogEntry[]
            ): Record<string, number> {
              const result: Record<string, number> = {}
              for (const entry of logs) {
                if (entry.models) {
                  for (const [model, spend] of Object.entries(entry.models)) {
                    result[model] = (result[model] || 0) + spend
                  }
                }
              }
              return result
            }

            const todayModels = aggregateModels(todayLogs as LogEntry[])
            const weekModels = aggregateModels(weekLogs as LogEntry[])
            const monthModels = aggregateModels(monthLogs as LogEntry[])

            // Lifetime per-model: prefer key info, fall back to spend logs from key creation
            let lifetimeModels = keyInfo?.info?.model_spend || {}
            if (Object.keys(lifetimeModels).length === 0) {
              const keyCreatedAt = keyInfo?.info?.created_at
              const lifetimeStart = keyCreatedAt
                ? keyCreatedAt.slice(0, 10)
                : "2020-01-01"
              const lifetimeLogs = await fetchSpendLogs(config, lifetimeStart, endDate)
              lifetimeModels = aggregateModels(lifetimeLogs as LogEntry[])
            }

            // Collect all model names across all periods
            const allModels = new Set<string>([
              ...Object.keys(todayModels),
              ...Object.keys(weekModels),
              ...Object.keys(monthModels),
              ...Object.keys(lifetimeModels),
            ])

            if (allModels.size === 0) {
              lines.push("_No per-model spend data available._")
              return lines.join("\n")
            }

            // Sort models by month spend (descending), then lifetime
            const sortedModels = [...allModels].sort((a, b) => {
              const aSpend = monthModels[a] || lifetimeModels[a] || 0
              const bSpend = monthModels[b] || lifetimeModels[b] || 0
              return bSpend - aSpend
            })

            lines.push(
              "| Model                                    | Today         | This Week     | This Month    | Lifetime      |"
            )
            lines.push(
              "|------------------------------------------|---------------|---------------|---------------|---------------|"
            )

            for (const model of sortedModels) {
              const today = todayModels[model] || 0
              const week = weekModels[model] || 0
              const month = monthModels[model] || 0
              const lifetime = lifetimeModels[model] || 0
              lines.push(
                `| ${model.padEnd(40)} | ${formatCost(today).padEnd(13)} | ${formatCost(week).padEnd(13)} | ${formatCost(month).padEnd(13)} | ${formatCost(lifetime).padEnd(13)} |`
              )
            }

            // Note about data source
            if (!keyInfo && Object.keys(todayModels).length === 0) {
              lines.push("")
              lines.push(
                "_Could not reach LiteLLM spend endpoints. Verify your API key has access._"
              )
            }

            return lines.join("\n")
          } catch (err) {
            return `Error fetching per-model spend data: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),
    },
  }
}

// Support both named and default export for auto-discovery
export default LiteLLMCostPlugin
