import { join } from "path"
import { homedir } from "os"

// --- Types ---

export interface PricingInfo {
  inputPricePerToken: number
  outputPricePerToken: number
}

export type PricingMap = Map<string, PricingInfo>

export interface SessionCostEntry {
  cost: number
  startedAt: string
}

export interface CostData {
  sessions: Record<string, SessionCostEntry>
  daily: Record<string, number> // ISO date string → accumulated cost
}

export interface PluginConfig {
  baseUrl: string
  apiKey: string
  alertThreshold: number
}

// --- Configuration ---

export function resolveConfig(options?: Record<string, unknown>): PluginConfig {
  return {
    baseUrl:
      (options?.baseUrl as string) ||
      process.env.LITELLM_BASE_URL ||
      "http://localhost:4000",
    apiKey:
      (options?.apiKey as string) ||
      process.env.LITELLM_API_KEY ||
      "",
    alertThreshold:
      Number(options?.alertThreshold) ||
      Number(process.env.LITELLM_COST_ALERT_THRESHOLD) ||
      1.0,
  }
}

// --- Pricing ---

export async function fetchModelPricing(
  config: PluginConfig
): Promise<PricingMap> {
  const pricing: PricingMap = new Map()

  const url = `${config.baseUrl.replace(/\/$/, "")}/model/info`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(
      `LiteLLM /model/info returned ${response.status}: ${response.statusText}`
    )
  }

  const body = (await response.json()) as {
    data?: Array<{
      model_name?: string
      model_info?: {
        input_cost_per_token?: number
        output_cost_per_token?: number
      }
    }>
  }

  if (body.data && Array.isArray(body.data)) {
    for (const entry of body.data) {
      const modelName = entry.model_name
      const info = entry.model_info
      if (modelName && info?.input_cost_per_token != null && info?.output_cost_per_token != null) {
        pricing.set(modelName, {
          inputPricePerToken: info.input_cost_per_token,
          outputPricePerToken: info.output_cost_per_token,
        })
      }
    }
  }

  return pricing
}

// --- Cost Calculation ---

export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  pricing: PricingInfo
): number {
  return (
    promptTokens * pricing.inputPricePerToken +
    completionTokens * pricing.outputPricePerToken
  )
}

// --- Persistence ---

const COST_FILE_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "plugin-cost.json"
)

export function getCostFilePath(): string {
  return COST_FILE_PATH
}

function emptyCostData(): CostData {
  return { sessions: {}, daily: {} }
}

export function loadCostData(filePath?: string): CostData {
  const path = filePath || COST_FILE_PATH
  try {
    const { readFileSync } = require("fs")
    const text = readFileSync(path, "utf-8")
    const data = JSON.parse(text) as CostData
    // Basic validation
    if (!data.sessions || !data.daily) {
      return emptyCostData()
    }
    return data
  } catch {
    return emptyCostData()
  }
}

export function saveCostData(data: CostData, filePath?: string): void {
  const path = filePath || COST_FILE_PATH
  try {
    const { mkdirSync, writeFileSync, renameSync } = require("fs")
    const { dirname } = require("path")

    // Ensure directory exists
    mkdirSync(dirname(path), { recursive: true })

    // Atomic write: write to temp file then rename
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
    renameSync(tmpPath, path)
  } catch {
    // Fail silently — in-memory data remains accurate
  }
}

export function addCost(
  data: CostData,
  sessionId: string,
  cost: number
): CostData {
  const today = getTodayKey()

  // Update session cost
  if (!data.sessions[sessionId]) {
    data.sessions[sessionId] = {
      cost: 0,
      startedAt: new Date().toISOString(),
    }
  }
  data.sessions[sessionId].cost += cost

  // Update daily cost
  data.daily[today] = (data.daily[today] || 0) + cost

  return data
}

// --- Period Queries ---

export function getSessionCost(data: CostData, sessionId: string): number {
  return data.sessions[sessionId]?.cost || 0
}

export function getTodayCost(data: CostData): number {
  return data.daily[getTodayKey()] || 0
}

export function getWeekCost(data: CostData): number {
  const today = new Date()
  // ISO week: Monday is day 1
  const dayOfWeek = today.getDay() || 7 // Convert Sunday (0) to 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - (dayOfWeek - 1))
  monday.setHours(0, 0, 0, 0)

  let total = 0
  for (const [dateStr, cost] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= monday && date <= today) {
      total += cost
    }
  }
  return total
}

export function getMonthCost(data: CostData): number {
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

  let total = 0
  for (const [dateStr, cost] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= firstOfMonth && date <= today) {
      total += cost
    }
  }
  return total
}

// --- Formatting ---

export function formatCost(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

// --- Helpers ---

function getTodayKey(): string {
  const now = new Date()
  return now.toISOString().slice(0, 10) // "2026-05-14"
}
