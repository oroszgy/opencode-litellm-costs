import { join, dirname } from "path"
import { homedir } from "os"
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"

// --- Types ---

export interface PricingInfo {
  inputPricePerToken: number
  outputPricePerToken: number
}

export type PricingMap = Map<string, PricingInfo>

export interface TokenUsage {
  input: number
  output: number
}

export interface ModelUsageEntry {
  cost: number
  tokens: TokenUsage
}

export interface SessionCostEntry {
  cost: number
  tokens: TokenUsage
  startedAt: string
  models: Record<string, ModelUsageEntry>
}

export interface DailyEntry {
  cost: number
  tokens: TokenUsage
  models: Record<string, ModelUsageEntry>
}

export interface CostData {
  sessions: Record<string, SessionCostEntry>
  daily: Record<string, DailyEntry> // ISO date string → accumulated cost + tokens
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
      (options?.baseURL as string) ||
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

// --- LiteLLM Spend API ---

export interface KeyInfoResponse {
  key: string
  info: {
    key_name?: string
    key_alias?: string
    spend?: number
    max_budget?: number | null
    model_spend?: Record<string, number>
    expires?: string | null
    budget_duration?: string | null
    budget_reset_at?: string | null
    created_at?: string | null
  }
}

export interface SpendLogEntry {
  startTime: string
  spend: number
  [key: string]: unknown
}

export async function fetchKeyInfo(
  config: PluginConfig
): Promise<KeyInfoResponse | null> {
  try {
    const url = `${config.baseUrl.replace(/\/$/, "")}/key/info`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    })
    if (!response.ok) return null
    return (await response.json()) as KeyInfoResponse
  } catch {
    return null
  }
}

export async function fetchSpendLogs(
  config: PluginConfig,
  startDate: string,
  endDate: string
): Promise<SpendLogEntry[]> {
  try {
    const baseUrl = config.baseUrl.replace(/\/$/, "")
    const params = new URLSearchParams({
      api_key: config.apiKey,
      start_date: startDate,
      end_date: endDate,
    })
    const url = `${baseUrl}/spend/logs?${params.toString()}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    })
    if (!response.ok) return []
    const data = await response.json()
    if (Array.isArray(data)) return data as SpendLogEntry[]
    return []
  } catch {
    return []
  }
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

function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0 }
}

function emptyCostData(): CostData {
  return { sessions: {}, daily: {} }
}

export function loadCostData(filePath?: string): CostData {
  const path = filePath || COST_FILE_PATH
  try {
    const text = readFileSync(path, "utf-8")
    const data = JSON.parse(text) as CostData
    // Basic validation
    if (!data.sessions || !data.daily) {
      return emptyCostData()
    }
    // Migrate old format: daily entries that are plain numbers → DailyEntry
    for (const [key, value] of Object.entries(data.daily)) {
      if (typeof value === "number") {
        ;(data.daily as any)[key] = { cost: value, tokens: emptyTokenUsage(), models: {} }
      } else if (!value.models) {
        value.models = {}
      }
    }
    // Migrate old sessions without tokens or models
    for (const [key, value] of Object.entries(data.sessions)) {
      if (!value.tokens) {
        value.tokens = emptyTokenUsage()
      }
      if (!value.models) {
        value.models = {}
      }
    }
    return data
  } catch {
    return emptyCostData()
  }
}

export function saveCostData(data: CostData, filePath?: string): void {
  const path = filePath || COST_FILE_PATH
  try {
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

/**
 * Remove daily entries and sessions older than the given number of days.
 * Defaults to 90 days. Returns a new CostData object with old entries removed.
 */
export function pruneOldData(data: CostData, maxAgeDays = 90): CostData {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - maxAgeDays)
  cutoff.setHours(0, 0, 0, 0)

  // Prune daily entries
  const daily: Record<string, DailyEntry> = {}
  for (const [dateStr, entry] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= cutoff) {
      daily[dateStr] = entry
    }
  }

  // Prune sessions older than cutoff
  const sessions: Record<string, SessionCostEntry> = {}
  for (const [id, entry] of Object.entries(data.sessions)) {
    if (entry.startedAt) {
      const sessionDate = new Date(entry.startedAt)
      if (sessionDate >= cutoff) {
        sessions[id] = entry
      }
    } else {
      // Keep sessions without a date (can't determine age)
      sessions[id] = entry
    }
  }

  return { sessions, daily }
}

export function addUsage(
  data: CostData,
  sessionId: string,
  cost: number,
  tokens: TokenUsage,
  modelId?: string
): CostData {
  const today = getTodayKey()

  // Update session
  if (!data.sessions[sessionId]) {
    data.sessions[sessionId] = {
      cost: 0,
      tokens: emptyTokenUsage(),
      startedAt: new Date().toISOString(),
      models: {},
    }
  }
  data.sessions[sessionId].cost += cost
  data.sessions[sessionId].tokens.input += tokens.input
  data.sessions[sessionId].tokens.output += tokens.output

  // Update session per-model
  if (modelId) {
    if (!data.sessions[sessionId].models) {
      data.sessions[sessionId].models = {}
    }
    if (!data.sessions[sessionId].models[modelId]) {
      data.sessions[sessionId].models[modelId] = { cost: 0, tokens: emptyTokenUsage() }
    }
    data.sessions[sessionId].models[modelId].cost += cost
    data.sessions[sessionId].models[modelId].tokens.input += tokens.input
    data.sessions[sessionId].models[modelId].tokens.output += tokens.output
  }

  // Update daily
  if (!data.daily[today]) {
    data.daily[today] = { cost: 0, tokens: emptyTokenUsage(), models: {} }
  }
  data.daily[today].cost += cost
  data.daily[today].tokens.input += tokens.input
  data.daily[today].tokens.output += tokens.output

  // Update daily per-model
  if (modelId) {
    if (!data.daily[today].models) {
      data.daily[today].models = {}
    }
    if (!data.daily[today].models[modelId]) {
      data.daily[today].models[modelId] = { cost: 0, tokens: emptyTokenUsage() }
    }
    data.daily[today].models[modelId].cost += cost
    data.daily[today].models[modelId].tokens.input += tokens.input
    data.daily[today].models[modelId].tokens.output += tokens.output
  }

  return data
}

// Keep backward compat — addCost delegates to addUsage with zero tokens
export function addCost(
  data: CostData,
  sessionId: string,
  cost: number
): CostData {
  return addUsage(data, sessionId, cost, emptyTokenUsage())
}

// --- Period Queries ---

export interface PeriodSummary {
  cost: number
  tokens: TokenUsage
}

export function getSessionSummary(data: CostData, sessionId: string): PeriodSummary {
  const entry = data.sessions[sessionId]
  if (!entry) return { cost: 0, tokens: emptyTokenUsage() }
  return { cost: entry.cost, tokens: entry.tokens }
}

export function getSessionCost(data: CostData, sessionId: string): number {
  return data.sessions[sessionId]?.cost || 0
}

export function getTodaySummary(data: CostData): PeriodSummary {
  const entry = data.daily[getTodayKey()]
  if (!entry) return { cost: 0, tokens: emptyTokenUsage() }
  return { cost: entry.cost, tokens: entry.tokens }
}

export function getTodayCost(data: CostData): number {
  const entry = data.daily[getTodayKey()]
  if (!entry) return 0
  return typeof entry === "number" ? entry : entry.cost
}

export function getWeekSummary(data: CostData): PeriodSummary {
  const today = new Date()
  const dayOfWeek = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - (dayOfWeek - 1))
  monday.setHours(0, 0, 0, 0)

  const result: PeriodSummary = { cost: 0, tokens: emptyTokenUsage() }
  for (const [dateStr, entry] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= monday && date <= today) {
      if (typeof entry === "number") {
        result.cost += entry
      } else {
        result.cost += entry.cost
        result.tokens.input += entry.tokens.input
        result.tokens.output += entry.tokens.output
      }
    }
  }
  return result
}

export function getWeekCost(data: CostData): number {
  return getWeekSummary(data).cost
}

export function getMonthSummary(data: CostData): PeriodSummary {
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

  const result: PeriodSummary = { cost: 0, tokens: emptyTokenUsage() }
  for (const [dateStr, entry] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= firstOfMonth && date <= today) {
      if (typeof entry === "number") {
        result.cost += entry
      } else {
        result.cost += entry.cost
        result.tokens.input += entry.tokens.input
        result.tokens.output += entry.tokens.output
      }
    }
  }
  return result
}

export function getMonthCost(data: CostData): number {
  return getMonthSummary(data).cost
}

// --- Model Breakdown Queries ---

function mergeModelUsage(
  target: Record<string, ModelUsageEntry>,
  source: Record<string, ModelUsageEntry>
): void {
  for (const [modelId, usage] of Object.entries(source)) {
    if (!target[modelId]) {
      target[modelId] = { cost: 0, tokens: emptyTokenUsage() }
    }
    target[modelId].cost += usage.cost
    target[modelId].tokens.input += usage.tokens.input
    target[modelId].tokens.output += usage.tokens.output
  }
}

export function getSessionModelBreakdown(
  data: CostData,
  sessionId: string
): Record<string, ModelUsageEntry> {
  const entry = data.sessions[sessionId]
  if (!entry || !entry.models) return {}
  // Return a copy to avoid mutation
  const result: Record<string, ModelUsageEntry> = {}
  mergeModelUsage(result, entry.models)
  return result
}

export function getTodayModelBreakdown(
  data: CostData
): Record<string, ModelUsageEntry> {
  const entry = data.daily[getTodayKey()]
  if (!entry || typeof entry === "number" || !entry.models) return {}
  const result: Record<string, ModelUsageEntry> = {}
  mergeModelUsage(result, entry.models)
  return result
}

export function getWeekModelBreakdown(
  data: CostData
): Record<string, ModelUsageEntry> {
  const today = new Date()
  const dayOfWeek = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - (dayOfWeek - 1))
  monday.setHours(0, 0, 0, 0)

  const result: Record<string, ModelUsageEntry> = {}
  for (const [dateStr, entry] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= monday && date <= today) {
      if (typeof entry !== "number" && entry.models) {
        mergeModelUsage(result, entry.models)
      }
    }
  }
  return result
}

export function getMonthModelBreakdown(
  data: CostData
): Record<string, ModelUsageEntry> {
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

  const result: Record<string, ModelUsageEntry> = {}
  for (const [dateStr, entry] of Object.entries(data.daily)) {
    const date = new Date(dateStr + "T00:00:00")
    if (date >= firstOfMonth && date <= today) {
      if (typeof entry !== "number" && entry.models) {
        mergeModelUsage(result, entry.models)
      }
    }
  }
  return result
}

// --- Formatting ---

export function formatCost(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatTokens(count: number): string {
  if (count === 0) return "0"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1_000).toFixed(0)}K`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toLocaleString()
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****"
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

// --- Date Helpers ---

export function getTodayKey(): string {
  const now = new Date()
  return now.toISOString().slice(0, 10)
}

export function getWeekStartKey(): string {
  const today = new Date()
  const dayOfWeek = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - (dayOfWeek - 1))
  return monday.toISOString().slice(0, 10)
}

export function getMonthStartKey(): string {
  const today = new Date()
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  return first.toISOString().slice(0, 10)
}
