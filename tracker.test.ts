import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import {
  resolveConfig,
  calculateCost,
  loadCostData,
  saveCostData,
  addUsage,
  getSessionSummary,
  getSessionCost,
  getTodaySummary,
  getTodayCost,
  getWeekSummary,
  getWeekCost,
  getMonthSummary,
  getMonthCost,
  formatCost,
  formatTokens,
  maskApiKey,
  type CostData,
  type PricingInfo,
  type DailyEntry,
  type TokenUsage,
} from "./tracker"

// Helper to create a daily entry
function daily(cost: number, input = 0, output = 0): DailyEntry {
  return { cost, tokens: { input, output } }
}

// --- resolveConfig ---

describe("resolveConfig", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("uses defaults when no options or env vars", () => {
    delete process.env.LITELLM_BASE_URL
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_COST_ALERT_THRESHOLD

    const config = resolveConfig()
    expect(config.baseUrl).toBe("http://localhost:4000")
    expect(config.apiKey).toBe("")
    expect(config.alertThreshold).toBe(1.0)
  })

  test("prefers plugin options over env vars", () => {
    process.env.LITELLM_BASE_URL = "http://env-url:8000"
    process.env.LITELLM_API_KEY = "env-key"
    process.env.LITELLM_COST_ALERT_THRESHOLD = "5.0"

    const config = resolveConfig({
      baseUrl: "http://options-url:9000",
      apiKey: "options-key",
      alertThreshold: 2.5,
    })

    expect(config.baseUrl).toBe("http://options-url:9000")
    expect(config.apiKey).toBe("options-key")
    expect(config.alertThreshold).toBe(2.5)
  })

  test("falls back to env vars when options are missing", () => {
    process.env.LITELLM_BASE_URL = "http://env-url:8000"
    process.env.LITELLM_API_KEY = "env-key"
    process.env.LITELLM_COST_ALERT_THRESHOLD = "3.0"

    const config = resolveConfig({})

    expect(config.baseUrl).toBe("http://env-url:8000")
    expect(config.apiKey).toBe("env-key")
    expect(config.alertThreshold).toBe(3.0)
  })

  test("accepts baseURL (capital) as alias for baseUrl", () => {
    delete process.env.LITELLM_BASE_URL

    const config = resolveConfig({
      baseURL: "http://capital-url:5000",
    })

    expect(config.baseUrl).toBe("http://capital-url:5000")
  })

  test("prefers baseUrl over baseURL when both provided", () => {
    delete process.env.LITELLM_BASE_URL

    const config = resolveConfig({
      baseUrl: "http://lowercase-wins:1000",
      baseURL: "http://uppercase-loses:2000",
    })

    expect(config.baseUrl).toBe("http://lowercase-wins:1000")
  })
})

// --- calculateCost ---

describe("calculateCost", () => {
  const pricing: PricingInfo = {
    inputPricePerToken: 0.000003,
    outputPricePerToken: 0.000015,
  }

  test("calculates cost from token counts", () => {
    const cost = calculateCost(1000, 500, pricing)
    expect(cost).toBeCloseTo(0.0105, 6)
  })

  test("returns 0 for zero tokens", () => {
    expect(calculateCost(0, 0, pricing)).toBe(0)
  })

  test("handles input-only usage", () => {
    const cost = calculateCost(10000, 0, pricing)
    expect(cost).toBeCloseTo(0.03, 6)
  })

  test("handles output-only usage", () => {
    const cost = calculateCost(0, 10000, pricing)
    expect(cost).toBeCloseTo(0.15, 6)
  })
})

// --- Persistence ---

describe("persistence", () => {
  const tmpDir = join("/tmp/opencode", "cost-tracker-test")
  const testFile = join(tmpDir, "test-cost.json")

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    if (existsSync(testFile)) rmSync(testFile)
  })

  afterEach(() => {
    if (existsSync(testFile)) rmSync(testFile)
  })

  test("loadCostData returns empty data when file does not exist", () => {
    const data = loadCostData(join(tmpDir, "nonexistent.json"))
    expect(data).toEqual({ sessions: {}, daily: {} })
  })

  test("loadCostData returns empty data for invalid JSON", () => {
    writeFileSync(testFile, "not json", "utf-8")
    const data = loadCostData(testFile)
    expect(data).toEqual({ sessions: {}, daily: {} })
  })

  test("loadCostData returns empty data for missing fields", () => {
    writeFileSync(testFile, '{"foo": "bar"}', "utf-8")
    const data = loadCostData(testFile)
    expect(data).toEqual({ sessions: {}, daily: {} })
  })

  test("loadCostData migrates old number-only daily format", () => {
    const oldData = {
      sessions: { "s1": { cost: 0.5, startedAt: "2026-05-14T00:00:00Z" } },
      daily: { "2026-05-14": 0.5 },
    }
    writeFileSync(testFile, JSON.stringify(oldData), "utf-8")
    const data = loadCostData(testFile)

    // Should migrate to DailyEntry format
    expect(data.daily["2026-05-14"]).toEqual({
      cost: 0.5,
      tokens: { input: 0, output: 0 },
    })
    // Should add tokens to session
    expect(data.sessions["s1"].tokens).toEqual({ input: 0, output: 0 })
  })

  test("saveCostData and loadCostData roundtrip", () => {
    const data: CostData = {
      sessions: {
        "sess-1": {
          cost: 0.05,
          tokens: { input: 1000, output: 500 },
          startedAt: "2026-05-14T08:00:00.000Z",
        },
      },
      daily: {
        "2026-05-14": { cost: 0.05, tokens: { input: 1000, output: 500 } },
      },
    }

    saveCostData(data, testFile)
    const loaded = loadCostData(testFile)

    expect(loaded).toEqual(data)
  })

  test("saveCostData creates parent directories", () => {
    const nestedFile = join(tmpDir, "nested", "deep", "cost.json")
    const data: CostData = {
      sessions: {},
      daily: { "2026-05-14": daily(0.01, 100, 50) },
    }

    saveCostData(data, nestedFile)
    expect(existsSync(nestedFile)).toBe(true)

    const loaded = loadCostData(nestedFile)
    expect(loaded.daily["2026-05-14"].cost).toBe(0.01)
    expect(loaded.daily["2026-05-14"].tokens.input).toBe(100)

    rmSync(join(tmpDir, "nested"), { recursive: true })
  })
})

// --- addUsage ---

describe("addUsage", () => {
  test("adds cost and tokens to a new session", () => {
    let data: CostData = { sessions: {}, daily: {} }
    data = addUsage(data, "sess-1", 0.05, { input: 1000, output: 500 })

    expect(data.sessions["sess-1"].cost).toBeCloseTo(0.05, 6)
    expect(data.sessions["sess-1"].tokens.input).toBe(1000)
    expect(data.sessions["sess-1"].tokens.output).toBe(500)
    expect(data.sessions["sess-1"].startedAt).toBeDefined()
  })

  test("accumulates cost and tokens on existing session", () => {
    let data: CostData = {
      sessions: {
        "sess-1": {
          cost: 0.05,
          tokens: { input: 1000, output: 500 },
          startedAt: "2026-05-14T08:00:00.000Z",
        },
      },
      daily: {
        "2026-05-14": { cost: 0.05, tokens: { input: 1000, output: 500 } },
      },
    }

    data = addUsage(data, "sess-1", 0.03, { input: 800, output: 300 })

    expect(data.sessions["sess-1"].cost).toBeCloseTo(0.08, 6)
    expect(data.sessions["sess-1"].tokens.input).toBe(1800)
    expect(data.sessions["sess-1"].tokens.output).toBe(800)
    expect(data.sessions["sess-1"].startedAt).toBe("2026-05-14T08:00:00.000Z")
  })

  test("accumulates daily cost and tokens", () => {
    let data: CostData = { sessions: {}, daily: {} }
    data = addUsage(data, "sess-1", 0.01, { input: 100, output: 50 })
    data = addUsage(data, "sess-2", 0.02, { input: 200, output: 100 })

    const todayKey = new Date().toISOString().slice(0, 10)
    expect(data.daily[todayKey].cost).toBeCloseTo(0.03, 6)
    expect(data.daily[todayKey].tokens.input).toBe(300)
    expect(data.daily[todayKey].tokens.output).toBe(150)
  })
})

// --- Period queries ---

describe("getSessionSummary", () => {
  test("returns zeros for unknown session", () => {
    const data: CostData = { sessions: {}, daily: {} }
    const s = getSessionSummary(data, "nonexistent")
    expect(s.cost).toBe(0)
    expect(s.tokens.input).toBe(0)
    expect(s.tokens.output).toBe(0)
  })

  test("returns session cost and tokens", () => {
    const data: CostData = {
      sessions: {
        "s1": { cost: 1.23, tokens: { input: 5000, output: 2000 }, startedAt: "" },
      },
      daily: {},
    }
    const s = getSessionSummary(data, "s1")
    expect(s.cost).toBe(1.23)
    expect(s.tokens.input).toBe(5000)
    expect(s.tokens.output).toBe(2000)
  })
})

describe("getTodaySummary", () => {
  test("returns zeros when no data for today", () => {
    const data: CostData = {
      sessions: {},
      daily: { "2020-01-01": daily(5.0, 100, 50) },
    }
    const s = getTodaySummary(data)
    expect(s.cost).toBe(0)
    expect(s.tokens.input).toBe(0)
  })

  test("returns today's cost and tokens", () => {
    const todayKey = new Date().toISOString().slice(0, 10)
    const data: CostData = {
      sessions: {},
      daily: { [todayKey]: daily(2.5, 10000, 3000) },
    }
    const s = getTodaySummary(data)
    expect(s.cost).toBe(2.5)
    expect(s.tokens.input).toBe(10000)
    expect(s.tokens.output).toBe(3000)
  })
})

describe("getWeekSummary", () => {
  test("sums costs and tokens from current ISO week", () => {
    const today = new Date()
    const dayOfWeek = today.getDay() || 7
    const monday = new Date(today)
    monday.setDate(today.getDate() - (dayOfWeek - 1))

    const dailyData: Record<string, DailyEntry> = {}
    for (let i = 0; i < dayOfWeek; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      dailyData[d.toISOString().slice(0, 10)] = daily(1.0, 1000, 500)
    }
    // Last week entry (should not be counted)
    const lastWeek = new Date(monday)
    lastWeek.setDate(monday.getDate() - 1)
    dailyData[lastWeek.toISOString().slice(0, 10)] = daily(99.0, 99000, 99000)

    const data: CostData = { sessions: {}, daily: dailyData }
    const s = getWeekSummary(data)
    expect(s.cost).toBeCloseTo(dayOfWeek * 1.0, 2)
    expect(s.tokens.input).toBe(dayOfWeek * 1000)
    expect(s.tokens.output).toBe(dayOfWeek * 500)
  })
})

describe("getMonthSummary", () => {
  test("sums costs and tokens from the 1st of the month", () => {
    const today = new Date()
    const dayOfMonth = today.getDate()

    const dailyData: Record<string, DailyEntry> = {}
    for (let i = 1; i <= dayOfMonth; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), i)
      dailyData[d.toISOString().slice(0, 10)] = daily(0.5, 500, 200)
    }
    // Last month (should not be counted)
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15)
    dailyData[lastMonth.toISOString().slice(0, 10)] = daily(99.0, 99000, 99000)

    const data: CostData = { sessions: {}, daily: dailyData }
    const s = getMonthSummary(data)
    expect(s.cost).toBeCloseTo(dayOfMonth * 0.5, 2)
    expect(s.tokens.input).toBe(dayOfMonth * 500)
    expect(s.tokens.output).toBe(dayOfMonth * 200)
  })
})

// --- formatCost ---

describe("formatCost", () => {
  test("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00")
  })

  test("formats small amounts with 4 decimal places", () => {
    expect(formatCost(0.0042)).toBe("$0.0042")
    expect(formatCost(0.0001)).toBe("$0.0001")
  })

  test("formats amounts >= $0.01 with 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01")
    expect(formatCost(1.5)).toBe("$1.50")
    expect(formatCost(123.456)).toBe("$123.46")
  })
})

// --- formatTokens ---

describe("formatTokens", () => {
  test("formats zero", () => {
    expect(formatTokens(0)).toBe("0")
  })

  test("formats small numbers with locale string", () => {
    expect(formatTokens(999)).toBe("999")
  })

  test("formats thousands with K suffix", () => {
    expect(formatTokens(1500)).toBe("1.5K")
    expect(formatTokens(9999)).toBe("10.0K")
  })

  test("formats tens of thousands without decimal", () => {
    expect(formatTokens(45000)).toBe("45K")
  })

  test("formats millions with M suffix", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(2_400_000)).toBe("2.4M")
  })
})

// --- maskApiKey ---

describe("maskApiKey", () => {
  test("masks long keys", () => {
    expect(maskApiKey("sk-GgJBySyVzFKmk0Y4AwuGhA")).toBe("sk-G...uGhA")
  })

  test("handles short keys", () => {
    expect(maskApiKey("short")).toBe("****")
  })
})
