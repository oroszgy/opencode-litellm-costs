import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  resolveConfig,
  fetchModelPricing,
  calculateCost,
  loadCostData,
  saveCostData,
  addCost,
  getSessionCost,
  getTodayCost,
  getWeekCost,
  getMonthCost,
  formatCost,
  type PricingMap,
  type CostData,
  type PluginConfig,
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

    // Determine cost: use built-in cost if available, otherwise calculate
    let cost = 0
    if (msg.cost > 0) {
      // OpenCode's built-in tracking worked for this message
      cost = msg.cost
    } else {
      // Calculate from tokens + LiteLLM pricing
      const totalInput = msg.tokens.input + msg.tokens.cache.read
      const totalOutput = msg.tokens.output + msg.tokens.reasoning
      if (totalInput === 0 && totalOutput === 0) return

      const modelPricing = findPricing(msg.modelID, msg.providerID)
      if (!modelPricing) {
        // No pricing data available for this model
        client.app.log({
          body: {
            service: "litellm-cost-tracker",
            level: "debug",
            message: `No pricing found for model "${msg.modelID}" (provider: ${msg.providerID}). Tokens: in=${totalInput}, out=${totalOutput}`,
          },
        })
        return
      }

      cost = calculateCost(totalInput, totalOutput, modelPricing)
    }

    if (cost <= 0) return

    // Accumulate cost
    costData = addCost(costData, sessionId, cost)
    saveCostData(costData)

    // Check alert threshold (fires once per session)
    const sessionCost = getSessionCost(costData, sessionId)
    if (!alertFired && sessionCost >= config.alertThreshold) {
      alertFired = true
      client.tui.showToast({
        body: {
          message: `Cost alert: session has reached ${formatCost(sessionCost)}`,
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
          // Only process assistant messages (not user messages)
          if (msg.role === "assistant") {
            processMessage(msg)
          }
          break
        }

        case "message.part.updated": {
          // Also track StepFinishPart for per-step cost if main message cost is missing
          const part = event.properties.part
          if (part.type === "step-finish" && part.cost > 0) {
            // StepFinishPart has its own cost — we could use this as a cross-check
            // but to avoid double-counting, we rely on message.updated for the total
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
          // Pick up session ID if we missed session.created
          if (!currentSessionId) {
            currentSessionId = event.properties.info.id
          }
          break
        }
      }
    },

    // Custom tool: /cost command calls this
    tool: {
      cost: tool({
        description:
          "Returns a summary of LiteLLM API costs for the current session, today, this week, and this month",
        args: {},
        async execute() {
          const sessionId = currentSessionId || "unknown"
          const sessionCost = getSessionCost(costData, sessionId)
          const todayCost = getTodayCost(costData)
          const weekCost = getWeekCost(costData)
          const monthCost = getMonthCost(costData)

          const sessionEntry = costData.sessions[sessionId]
          const startedAt = sessionEntry?.startedAt
            ? new Date(sessionEntry.startedAt).toLocaleString()
            : "N/A"

          return [
            "## LiteLLM Cost Summary",
            "",
            "| Period       | Cost          |",
            "|--------------|---------------|",
            `| This Session | ${formatCost(sessionCost).padEnd(13)} |`,
            `| Today        | ${formatCost(todayCost).padEnd(13)} |`,
            `| This Week    | ${formatCost(weekCost).padEnd(13)} |`,
            `| This Month   | ${formatCost(monthCost).padEnd(13)} |`,
            "",
            `Session started: ${startedAt}`,
            `Alert threshold: ${formatCost(config.alertThreshold)}`,
            `Models with pricing: ${pricing.size}`,
          ].join("\n")
        },
      }),
    },
  }
}

// Support both named and default export for auto-discovery
export default LiteLLMCostPlugin
