import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import {
  resolveConfig,
  calculateCost,
  loadCostData,
  saveCostData,
  addCost,
  getSessionCost,
  getTodayCost,
  getWeekCost,
  getMonthCost,
  formatCost,
  type CostData,
  type PricingInfo,
} from "./tracker"

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
    inputPricePerToken: 0.000003, // $3/1M tokens
    outputPricePerToken: 0.000015, // $15/1M tokens
  }

  test("calculates cost from token counts", () => {
    const cost = calculateCost(1000, 500, pricing)
    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
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

// --- Persistence (loadCostData / saveCostData) ---

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
    require("fs").writeFileSync(testFile, "not json", "utf-8")
    const data = loadCostData(testFile)
    expect(data).toEqual({ sessions: {}, daily: {} })
  })

  test("loadCostData returns empty data for missing fields", () => {
    require("fs").writeFileSync(testFile, '{"foo": "bar"}', "utf-8")
    const data = loadCostData(testFile)
    expect(data).toEqual({ sessions: {}, daily: {} })
  })

  test("saveCostData and loadCostData roundtrip", () => {
    const data: CostData = {
      sessions: {
        "sess-1": { cost: 0.05, startedAt: "2026-05-14T08:00:00.000Z" },
      },
      daily: { "2026-05-14": 0.05 },
    }

    saveCostData(data, testFile)
    const loaded = loadCostData(testFile)

    expect(loaded).toEqual(data)
  })

  test("saveCostData creates parent directories", () => {
    const nestedFile = join(tmpDir, "nested", "deep", "cost.json")
    const data: CostData = { sessions: {}, daily: { "2026-05-14": 0.01 } }

    saveCostData(data, nestedFile)
    expect(existsSync(nestedFile)).toBe(true)

    const loaded = loadCostData(nestedFile)
    expect(loaded.daily["2026-05-14"]).toBe(0.01)

    // Cleanup
    rmSync(join(tmpDir, "nested"), { recursive: true })
  })
})

// --- addCost ---

describe("addCost", () => {
  test("adds cost to a new session", () => {
    let data: CostData = { sessions: {}, daily: {} }
    data = addCost(data, "sess-1", 0.05)

    expect(data.sessions["sess-1"].cost).toBeCloseTo(0.05, 6)
    expect(data.sessions["sess-1"].startedAt).toBeDefined()
  })

  test("accumulates cost on existing session", () => {
    let data: CostData = {
      sessions: {
        "sess-1": { cost: 0.05, startedAt: "2026-05-14T08:00:00.000Z" },
      },
      daily: { "2026-05-14": 0.05 },
    }

    data = addCost(data, "sess-1", 0.03)

    expect(data.sessions["sess-1"].cost).toBeCloseTo(0.08, 6)
    // startedAt should not change
    expect(data.sessions["sess-1"].startedAt).toBe("2026-05-14T08:00:00.000Z")
  })

  test("accumulates daily cost", () => {
    let data: CostData = { sessions: {}, daily: {} }
    data = addCost(data, "sess-1", 0.01)
    data = addCost(data, "sess-2", 0.02)

    const todayKey = new Date().toISOString().slice(0, 10)
    expect(data.daily[todayKey]).toBeCloseTo(0.03, 6)
  })
})

// --- Period queries ---

describe("getSessionCost", () => {
  test("returns 0 for unknown session", () => {
    const data: CostData = { sessions: {}, daily: {} }
    expect(getSessionCost(data, "nonexistent")).toBe(0)
  })

  test("returns session cost", () => {
    const data: CostData = {
      sessions: { "s1": { cost: 1.23, startedAt: "" } },
      daily: {},
    }
    expect(getSessionCost(data, "s1")).toBe(1.23)
  })
})

describe("getTodayCost", () => {
  test("returns 0 when no data for today", () => {
    const data: CostData = { sessions: {}, daily: { "2020-01-01": 5.0 } }
    expect(getTodayCost(data)).toBe(0)
  })

  test("returns today's cost", () => {
    const todayKey = new Date().toISOString().slice(0, 10)
    const data: CostData = { sessions: {}, daily: { [todayKey]: 2.5 } }
    expect(getTodayCost(data)).toBe(2.5)
  })
})

describe("getWeekCost", () => {
  test("sums costs from current ISO week (Monday-Sunday)", () => {
    const today = new Date()
    const dayOfWeek = today.getDay() || 7
    const monday = new Date(today)
    monday.setDate(today.getDate() - (dayOfWeek - 1))

    const daily: Record<string, number> = {}
    // Add costs for each day of the current week up to today
    for (let i = 0; i < dayOfWeek; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      daily[d.toISOString().slice(0, 10)] = 1.0
    }
    // Add a cost from last week (should not be counted)
    const lastWeek = new Date(monday)
    lastWeek.setDate(monday.getDate() - 1)
    daily[lastWeek.toISOString().slice(0, 10)] = 99.0

    const data: CostData = { sessions: {}, daily }
    expect(getWeekCost(data)).toBeCloseTo(dayOfWeek * 1.0, 2)
  })
})

describe("getMonthCost", () => {
  test("sums costs from the 1st of the month to today", () => {
    const today = new Date()
    const dayOfMonth = today.getDate()

    const daily: Record<string, number> = {}
    for (let i = 1; i <= dayOfMonth; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), i)
      daily[d.toISOString().slice(0, 10)] = 0.5
    }
    // Add a cost from last month (should not be counted)
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15)
    daily[lastMonth.toISOString().slice(0, 10)] = 99.0

    const data: CostData = { sessions: {}, daily }
    expect(getMonthCost(data)).toBeCloseTo(dayOfMonth * 0.5, 2)
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
