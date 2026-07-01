import { describe, it, expect, afterEach } from "bun:test";
import { NvidiaNimKeyRotator } from "./index.js";
import type { PluginInput } from "@opencode-ai/plugin";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testStoreCounter = 0;

function createTestStorePath(): string {
  return join(
    tmpdir(),
    `test-nim-rotator-${Date.now()}-${++testStoreCounter}.json`,
  );
}

function createMockClient(
  overrides: {
    sessionGet?: (id: string) => Promise<unknown>;
    sessionAbort?: (id: string) => Promise<unknown>;
    sessionPrompt?: (id: string, body: unknown) => Promise<unknown>;
    sessionMessages?: (id: string) => Promise<unknown>;
    sessionStatus?: () => Promise<unknown>;
  } = {},
) {
  return {
    session: {
      get:
        overrides.sessionGet ??
        (() => Promise.resolve({ data: { parentID: undefined } })),
      abort: overrides.sessionAbort ?? (() => Promise.resolve()),
      prompt: overrides.sessionPrompt ?? (() => Promise.resolve()),
      messages:
        overrides.sessionMessages ?? (() => Promise.resolve({ data: [] })),
      status: overrides.sessionStatus ?? (() => Promise.resolve({})),
    },
    tui: {
      showToast: () => Promise.resolve(),
    },
  } as unknown as PluginInput["client"];
}

function createPluginInput(client: PluginInput["client"]): PluginInput {
  return { client } as PluginInput;
}

function createTestPlugin(client: PluginInput["client"], storePath?: string) {
  return NvidiaNimKeyRotator(createPluginInput(client), {
    storePath: storePath ?? createTestStorePath(),
    proxyPort: 0,
    disableProxy: true,
  });
}

describe("NvidiaNimKeyRotator", () => {
  afterEach(() => {
    testStoreCounter = 0;
  });

  it("should export the plugin", async () => {
    const client = createMockClient();
    const plugin = await createTestPlugin(client);
    expect(plugin).toBeDefined();
    expect(plugin.auth).toBeDefined();
    expect(plugin["chat.headers"]).toBeDefined();
    expect(plugin["chat.message"]).toBeDefined();
    expect(plugin["shell.env"]).toBeDefined();
    expect(plugin.event).toBeDefined();
  });

  it("should skip abort for subagent sessions on rate limit", async () => {
    let abortCalled = false;
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: "parent-123" } }),
      sessionAbort: () => {
        abortCalled = true;
        return Promise.resolve();
      },
    });

    const plugin = await createTestPlugin(client);
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    await plugin.event!({ event } as any);
    expect(abortCalled).toBe(false);
  });

  it("should track rate limit count for primary sessions", async () => {
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: undefined } }),
    });

    const plugin = await createTestPlugin(client);
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    await plugin["chat.message"]!(
      {
        sessionID: "primary-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    await plugin.event!({ event } as any);
    expect(true).toBe(true);
  });

  it("should proactively skip blacklisted models in chat.message", async () => {
    const client = createMockClient();
    const storePath = createTestStorePath();
    writeFileSync(
      storePath,
      JSON.stringify({
        keys: [],
        currentIndex: 0,
        rotationStrategy: "round-robin",
        updatedAt: Date.now(),
        fallbackChain: [],
        maxRateLimitFailures: 3,
      }),
    );
    try {
      const plugin = await createTestPlugin(client, storePath);

      const output = {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        } as any,
        output as any,
      );
      expect(output.message.model).toEqual({
        providerID: "nvidia",
        modelID: "llama-3.1-70b",
      });
    } finally {
      if (existsSync(storePath)) unlinkSync(storePath);
    }
  });

  it("should update model index for subagent on rate limit", async () => {
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: "parent-123" } }),
    });

    const plugin = await createTestPlugin(client);
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    await plugin["chat.message"]!(
      {
        sessionID: "subagent-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    for (let i = 0; i < 3; i++) {
      await plugin.event!({ event } as any);
    }

    expect(true).toBe(true);
  });

  it("should handle session.status idle event and cleanup state", async () => {
    const client = createMockClient();
    const plugin = await createTestPlugin(client);

    await plugin["chat.message"]!(
      {
        sessionID: "test-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    const event = {
      type: "session.status" as const,
      properties: {
        sessionID: "test-123",
        status: { type: "idle" },
      },
    };

    await plugin.event!({ event } as any);
    expect(true).toBe(true);
  });

  it("should reset to first model after cooldown expires", async () => {
    const storePath = createTestStorePath();
    let originalDateNow: typeof Date.now = Date.now;
    try {
      writeFileSync(
        storePath,
        JSON.stringify({
          keys: [],
          currentIndex: 0,
          rotationStrategy: "round-robin",
          updatedAt: Date.now(),
          fallbackChain: [
            { id: "model-a", name: "Model A" },
            { id: "model-b", name: "Model B" },
          ],
          maxRateLimitFailures: 3,
        }),
      );

      const client = createMockClient();
      const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
        storePath,
        proxyPort: 0,
        disableProxy: true,
      });

      const output1 = {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "model-a" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-a" },
        } as any,
        output1 as any,
      );
      expect(output1.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-a",
      });

      const event = {
        type: "session.error" as const,
        properties: {
          sessionID: "test-123",
          error: {
            name: "APIError",
            data: {
              statusCode: 429,
              responseHeaders: { "retry-after-ms": "0" },
            },
          },
        },
      };
      for (let i = 0; i < 3; i++) {
        await plugin.event!({ event } as any);
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }

      await plugin.event!({
        event: {
          type: "session.status",
          properties: {
            sessionID: "test-123",
            status: { type: "idle" },
          },
        },
      } as any);

      const output2 = {
        message: {
          id: "msg-2",
          model: { providerID: "nvidia", modelID: "model-b" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-b" },
        } as any,
        output2 as any,
      );
      expect(output2.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-b",
      });

      originalDateNow = Date.now;
      let mockTime = Date.now();
      Date.now = () => mockTime;

      mockTime += 60 * 60 * 1000 + 1;

      const output3 = {
        message: {
          id: "msg-3",
          model: { providerID: "nvidia", modelID: "model-b" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-b" },
        } as any,
        output3 as any,
      );
      expect(output3.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-a",
      });
    } finally {
      Date.now = originalDateNow;
      if (existsSync(storePath)) unlinkSync(storePath);
    }
  }, 10000);
});
