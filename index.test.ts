import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdirSync, rmSync, existsSync } from "fs"
import { getCostFilePath } from "./tracker"

// Mock the client SDK
function createMockClient() {
  return {
    app: {
      log: mock(() => Promise.resolve()),
    },
    tui: {
      showToast: mock(() => Promise.resolve()),
    },
  }
}

// Mock fetch for pricing endpoint
const MOCK_PRICING_RESPONSE = {
  data: [
    {
      model_name: "claude-opus-4-6",
      model_info: {
        input_cost_per_token: 0.000015,
        output_cost_per_token: 0.000075,
      },
    },
    {
      model_name: "claude-sonnet-4-6",
      model_info: {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    },
    {
      model_name: "gpt-4o",
      model_info: {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
      },
    },
  ],
}

const MOCK_KEY_INFO_RESPONSE = {
  key: "sk-GgJBySyVzFKmk0Y4AwuGhA",
  info: {
    key_name: "test-key",
    spend: 42.5,
    max_budget: 100.0,
    model_spend: {
      "claude-opus-4-6": 30.0,
      "claude-sonnet-4-6": 12.5,
    },
  },
}

describe("LiteLLMCostPlugin", () => {
  const tmpDir = join("/tmp/opencode", "plugin-test")
  const costFile = getCostFilePath()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    if (existsSync(costFile)) rmSync(costFile)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Helper to instantiate the plugin with mocks
  async function setupPlugin(options?: Record<string, unknown>) {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      if (url.includes("/key/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_KEY_INFO_RESPONSE),
        } as Response)
      }
      if (url.includes("/spend/logs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { startTime: "2026-05-14", spend: 1.23 },
              { startTime: "2026-05-13", spend: 0.45 },
            ]),
        } as Response)
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      {
        baseUrl: "http://localhost:4000",
        apiKey: "sk-GgJBySyVzFKmk0Y4AwuGhA",
        alertThreshold: 1.0,
        ...options,
      }
    )

    return { hooks, client }
  }

  const toolCtx = {
    sessionID: "test",
    messageID: "msg-1",
    agent: "general",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: {} as any,
  }

  test("fetches pricing on init and logs success", async () => {
    const { client } = await setupPlugin()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(client.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "info",
          message: expect.stringContaining("Loaded pricing for 3 models"),
        }),
      })
    )
  })

  test("handles LiteLLM unreachable gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused"))
    ) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "test-key" }
    )

    expect(hooks.event).toBeDefined()
    expect(hooks.tool).toBeDefined()
    expect(client.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("Failed to fetch model pricing"),
        }),
      })
    )
  })

  test("event hook tracks session creation", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "test-session-123" } },
      } as any,
    })

    const result = await hooks.tool!.cost.execute({} as any, toolCtx)
    expect(result).toContain("$0.00")
    expect(result).toContain("Tokens In")
    expect(result).toContain("Tokens Out")
  })

  test("event hook processes completed messages with token tracking", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-tokens" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: "sess-tokens",
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 1000,
              output: 500,
              reasoning: 0,
              cache: { read: 200, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    })

    const result = await hooks.tool!.cost.execute({} as any, toolCtx)
    // Cost: (1000+200) * 0.000003 + 500 * 0.000015 = 0.0036 + 0.0075 = 0.0111
    expect(result).toContain("| This Session |")
    // Token tracking: input = 1000 + 200 cache = 1200, output = 500
    expect(result).toContain("1.2K")  // 1200 tokens formatted
    expect(result).toContain("500")   // 500 output tokens
  })

  test("does not double-count the same message", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-dedup" } },
      } as any,
    })

    const messageEvent = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-same",
            sessionID: "sess-dedup",
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 1000,
              output: 500,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    }

    await hooks.event!(messageEvent)
    await hooks.event!(messageEvent)

    const result = await hooks.tool!.cost.execute({} as any, toolCtx)
    // Should only count once
    expect(result).toContain("| This Session | $0.01")
  })

  test("ignores incomplete (streaming) messages", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-stream" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-streaming",
            sessionID: "sess-stream",
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 500,
              output: 200,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now() },
          },
        },
      } as any,
    })

    const result = await hooks.tool!.cost.execute({} as any, toolCtx)
    expect(result).toContain("| This Session | $0.00")
  })

  test("fires toast when session cost crosses threshold", async () => {
    const { hooks, client } = await setupPlugin({ alertThreshold: 0.01 })

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-alert" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-expensive",
            sessionID: "sess-alert",
            role: "assistant",
            modelID: "claude-opus-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 5000,
              output: 2000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    })

    expect(client.tui.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          variant: "warning",
          message: expect.stringContaining("Cost alert"),
        }),
      })
    )
  })

  test("toast only fires once per session", async () => {
    const { hooks, client } = await setupPlugin({ alertThreshold: 0.001 })

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-once" } },
      } as any,
    })

    for (let i = 0; i < 2; i++) {
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: `msg-${i}`,
              sessionID: "sess-once",
              role: "assistant",
              modelID: "claude-sonnet-4-6",
              providerID: "anthropic",
              cost: 0,
              tokens: {
                input: 1000,
                output: 500,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: Date.now(), completed: Date.now() },
            },
          },
        } as any,
      })
    }

    expect(client.tui.showToast).toHaveBeenCalledTimes(1)
  })

  test("cost tool returns formatted summary with tokens", async () => {
    const { hooks } = await setupPlugin()

    const result = await hooks.tool!.cost.execute({} as any, toolCtx)

    expect(result).toContain("## LiteLLM Cost Summary (Local Tracking)")
    expect(result).toContain("This Session")
    expect(result).toContain("Today")
    expect(result).toContain("This Week")
    expect(result).toContain("This Month")
    expect(result).toContain("Tokens In")
    expect(result).toContain("Tokens Out")
    expect(result).toContain("Models with pricing: 3")
  })

  test("spend tool fetches and returns server-side spend", async () => {
    const { hooks } = await setupPlugin()

    const result = await hooks.tool!.spend.execute({} as any, toolCtx)

    expect(result).toContain("## LiteLLM Server Spend")
    expect(result).toContain("sk-G...uGhA")
    expect(result).toContain("Lifetime")
    expect(result).toContain("$42.50")
    expect(result).toContain("Budget")
    expect(result).toContain("Per-Model")
    expect(result).toContain("claude-opus-4-6")
    expect(result).toContain("$30.00")
  })

  test("spend tool handles missing API key", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      return Promise.reject(new Error("nope"))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "" }
    )

    const result = await hooks.tool!.spend.execute({} as any, toolCtx)
    expect(result).toContain("Error: No LITELLM_API_KEY")
  })

  // --- cost-models tool tests ---

  test("cost-models tool shows per-model breakdown after messages", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-models" } },
      } as any,
    })

    // Send messages from two different models
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-opus-1",
            sessionID: "sess-models",
            role: "assistant",
            modelID: "claude-opus-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 2000,
              output: 1000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-sonnet-1",
            sessionID: "sess-models",
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
            cost: 0,
            tokens: {
              input: 1000,
              output: 500,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    })

    const result = await hooks.tool!["cost-models"].execute({} as any, toolCtx)

    expect(result).toContain("## Per-Model Cost Breakdown (Local Tracking)")
    expect(result).toContain("### This Session")
    expect(result).toContain("claude-opus-4-6")
    expect(result).toContain("claude-sonnet-4-6")
    expect(result).toContain("### Today")
    expect(result).toContain("### This Week")
    expect(result).toContain("### This Month")
  })

  test("cost-models tool shows no data message when no models tracked", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-empty-models" } },
      } as any,
    })

    const result = await hooks.tool!["cost-models"].execute({} as any, toolCtx)
    expect(result).toContain("_No model data recorded._")
  })

  test("cost-models tool tracks model from message with built-in cost", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-builtin" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-builtin-cost",
            sessionID: "sess-builtin",
            role: "assistant",
            modelID: "gpt-4o",
            providerID: "openai",
            cost: 0.15,
            tokens: {
              input: 5000,
              output: 2000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: Date.now(), completed: Date.now() },
          },
        },
      } as any,
    })

    const result = await hooks.tool!["cost-models"].execute({} as any, toolCtx)
    expect(result).toContain("gpt-4o")
    expect(result).toContain("$0.15")
  })

  // --- spend-models tool tests ---

  test("spend-models tool shows per-model server spend", async () => {
    const { hooks } = await setupPlugin()

    const result = await hooks.tool!["spend-models"].execute({} as any, toolCtx)

    expect(result).toContain("## Per-Model Server Spend")
    expect(result).toContain("sk-G...uGhA")
    // Table headers
    expect(result).toContain("Today")
    expect(result).toContain("This Week")
    expect(result).toContain("This Month")
    expect(result).toContain("Lifetime")
    // Model data from mock key info (lifetime)
    expect(result).toContain("claude-opus-4-6")
    expect(result).toContain("claude-sonnet-4-6")
  })

  test("spend-models tool handles missing API key", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      return Promise.reject(new Error("nope"))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "" }
    )

    const result = await hooks.tool!["spend-models"].execute({} as any, toolCtx)
    expect(result).toContain("Error: No LITELLM_API_KEY")
  })

  test("spend-models tool aggregates models from spend logs", async () => {
    // Override fetch with model data in spend logs
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      if (url.includes("/key/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            key: "test",
            info: { spend: 50, model_spend: { "model-a": 30, "model-b": 20 } },
          }),
        } as Response)
      }
      if (url.includes("/spend/logs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { startTime: "2026-05-14", spend: 5.0, models: { "model-a": 3.0, "model-b": 2.0 } },
            { startTime: "2026-05-13", spend: 4.0, models: { "model-a": 2.5, "model-b": 1.5 } },
          ]),
        } as Response)
      }
      return Promise.reject(new Error(`Unexpected: ${url}`))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "sk-test-key-1234567890" }
    )

    const result = await hooks.tool!["spend-models"].execute({} as any, toolCtx)

    expect(result).toContain("model-a")
    expect(result).toContain("model-b")
    // Lifetime from key info
    expect(result).toContain("$30.00")
    expect(result).toContain("$20.00")
  })

  test("spend-models falls back to spend logs when model_spend is empty", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      if (url.includes("/key/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            key: "test",
            info: {
              spend: 100,
              model_spend: {},  // Empty! Should trigger fallback
              created_at: "2025-08-13T13:03:18.536000+00:00",
            },
          }),
        } as Response)
      }
      if (url.includes("/spend/logs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { startTime: "2026-05-14", spend: 12.0, models: { "claude-opus": 8.0, "claude-sonnet": 4.0 } },
            { startTime: "2026-05-13", spend: 10.0, models: { "claude-opus": 7.0, "claude-sonnet": 3.0 } },
          ]),
        } as Response)
      }
      return Promise.reject(new Error(`Unexpected: ${url}`))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "sk-test-key-1234567890" }
    )

    const result = await hooks.tool!["spend-models"].execute({} as any, toolCtx)

    // Should show model data from spend logs fallback
    expect(result).toContain("claude-opus")
    expect(result).toContain("claude-sonnet")
    // Lifetime aggregated from logs: claude-opus = 8+7 = $15, claude-sonnet = 4+3 = $7
    expect(result).toContain("$15.00")
    expect(result).toContain("$7.00")
  })

  test("spend tool falls back to spend logs for per-model when model_spend is empty", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
        } as Response)
      }
      if (url.includes("/key/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            key: "test",
            info: {
              spend: 100,
              model_spend: {},
              created_at: "2025-01-01T00:00:00Z",
            },
          }),
        } as Response)
      }
      if (url.includes("/spend/logs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { startTime: "2026-05-14", spend: 5.0, models: { "model-x": 3.0, "model-y": 2.0 } },
          ]),
        } as Response)
      }
      return Promise.reject(new Error(`Unexpected: ${url}`))
    }) as any

    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    const hooks = await LiteLLMCostPlugin(
      {
        client: client as any,
        project: {} as any,
        directory: tmpDir,
        worktree: tmpDir,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      },
      { baseUrl: "http://localhost:4000", apiKey: "sk-test-key-1234567890" }
    )

    const result = await hooks.tool!.spend.execute({} as any, toolCtx)

    // Should show per-model section from spend logs fallback
    expect(result).toContain("Per-Model (Lifetime)")
    expect(result).toContain("model-x")
    expect(result).toContain("model-y")
    expect(result).toContain("$3.00")
    expect(result).toContain("$2.00")
  })
})
