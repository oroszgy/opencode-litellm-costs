import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdirSync, rmSync, existsSync } from "fs"
import { homedir } from "os"
import { loadCostData, getCostFilePath } from "./tracker"

/**
 * Integration tests for the plugin's event processing logic.
 * Since the plugin is a function that returns hooks, we test the hooks directly.
 */

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

describe("LiteLLMCostPlugin", () => {
  const tmpDir = join("/tmp/opencode", "plugin-test")
  const costFile = getCostFilePath()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    // Clean the shared persistence file before each test
    if (existsSync(costFile)) rmSync(costFile)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Helper to instantiate the plugin with mocks
  async function setupPlugin(options?: Record<string, unknown>) {
    // Mock fetch to return pricing data
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/model/info")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_PRICING_RESPONSE),
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
        apiKey: "test-key",
        alertThreshold: 1.0,
        ...options,
      }
    )

    return { hooks, client }
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

    // Plugin should still return hooks (not crash)
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

  test("warns when no API key configured", async () => {
    globalThis.fetch = originalFetch
    const client = createMockClient()
    const { LiteLLMCostPlugin } = await import("./index")

    // Remove env var to test no-key path
    const savedKey = process.env.LITELLM_API_KEY
    delete process.env.LITELLM_API_KEY

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

    expect(hooks.event).toBeDefined()
    expect(client.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("No LITELLM_API_KEY"),
        }),
      })
    )

    if (savedKey) process.env.LITELLM_API_KEY = savedKey
  })

  test("event hook tracks session creation", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: { id: "test-session-123" },
        },
      } as any,
    })

    // After session created, the cost tool should reference it
    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "test-session-123",
      messageID: "msg-1",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    expect(result).toContain("$0.00")
  })

  test("event hook processes completed assistant messages", async () => {
    const { hooks } = await setupPlugin()

    // Create session
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-abc" } },
      } as any,
    })

    // Simulate a completed assistant message
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: "sess-abc",
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
            cost: 0, // Built-in cost tracking failed
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

    // Check cost tool output
    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "sess-abc",
      messageID: "msg-2",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    // Expected: 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    // formatCost rounds to 2 decimal places for amounts >= $0.01 → "$0.01"
    expect(result).toContain("| This Session | $0.01")
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

    // Fire same message event twice
    await hooks.event!(messageEvent)
    await hooks.event!(messageEvent)

    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "sess-dedup",
      messageID: "msg-x",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    // Should only count once: $0.0105 → formatted as $0.01
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

    // Message without time.completed (still streaming)
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
            time: { created: Date.now() }, // No completed field
          },
        },
      } as any,
    })

    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "sess-stream",
      messageID: "msg-x",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    // Should be $0.00 since message wasn't completed
    expect(result).toContain("| This Session | $0.00")
  })

  test("uses built-in cost when available (non-zero)", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-builtin" } },
      } as any,
    })

    // Message with built-in cost already set
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-builtin",
            sessionID: "sess-builtin",
            role: "assistant",
            modelID: "claude-opus-4-6",
            providerID: "anthropic",
            cost: 0.042, // Built-in tracking worked
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

    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "sess-builtin",
      messageID: "msg-x",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    // Should use the built-in cost of $0.042 → formatted as "$0.04"
    expect(result).toContain("| This Session | $0.04")
  })

  test("fires toast when session cost crosses threshold", async () => {
    const { hooks, client } = await setupPlugin({ alertThreshold: 0.01 })

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-alert" } },
      } as any,
    })

    // Message with cost that exceeds threshold ($0.01)
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

    // 5000 * 0.000015 + 2000 * 0.000075 = 0.075 + 0.15 = 0.225 > 0.01 threshold
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

    // Two messages, both cross threshold
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

    // Toast should fire only once
    expect(client.tui.showToast).toHaveBeenCalledTimes(1)
  })

  test("ignores user messages", async () => {
    const { hooks } = await setupPlugin()

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "sess-user" } },
      } as any,
    })

    // User message (should be ignored)
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-user",
            sessionID: "sess-user",
            role: "user",
          },
        },
      } as any,
    })

    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "sess-user",
      messageID: "msg-x",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    expect(result).toContain("| This Session | $0.00")
  })

  test("cost tool returns formatted summary", async () => {
    const { hooks } = await setupPlugin()

    const result = await hooks.tool!.cost.execute({} as any, {
      sessionID: "unknown",
      messageID: "msg-1",
      agent: "general",
      directory: tmpDir,
      worktree: tmpDir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: {} as any,
    })

    expect(result).toContain("## LiteLLM Cost Summary")
    expect(result).toContain("This Session")
    expect(result).toContain("Today")
    expect(result).toContain("This Week")
    expect(result).toContain("This Month")
    expect(result).toContain("Alert threshold")
    expect(result).toContain("Models with pricing: 3")
  })
})
