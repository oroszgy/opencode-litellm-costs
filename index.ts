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
  addUsage,
  getSessionSummary,
  getTodaySummary,
  getWeekSummary,
  getMonthSummary,
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

  // Load persisted cost data from disk
  let costData: CostData = loadCostData()

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

    // Try partial match (model name without version suffixes, etc.)
    for (const [key, value] of pricing) {
      if (key.includes(modelID) || modelID.includes(key)) {
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
        client.app.log({
          body: {
            service: "litellm-cost-tracker",
            level: "debug",
            message: `No pricing found for model "${msg.modelID}" (provider: ${msg.providerID}). Tokens: in=${totalInput}, out=${totalOutput}`,
          },
        })
        // Still track tokens even without cost
        costData = addUsage(costData, sessionId, 0, tokens)
        saveCostData(costData)
        return
      }

      cost = calculateCost(totalInput, totalOutput, modelPricing)
    }

    // Accumulate cost and tokens
    costData = addUsage(costData, sessionId, cost, tokens)
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

          // Per-model breakdown from key info
          const modelSpend = keyInfo?.info?.model_spend
          if (modelSpend && Object.keys(modelSpend).length > 0) {
            lines.push("")
            lines.push("### Per-Model (Lifetime)")
            lines.push("| Model                         | Spend         |")
            lines.push("|-------------------------------|---------------|")

            const sorted = Object.entries(modelSpend).sort(
              ([, a], [, b]) => b - a
            )
            for (const [model, spend] of sorted) {
              lines.push(
                `| ${model.padEnd(29)} | ${formatCost(spend).padEnd(13)} |`
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
        },
      }),
    },
  }
}

// Support both named and default export for auto-discovery
export default LiteLLMCostPlugin
