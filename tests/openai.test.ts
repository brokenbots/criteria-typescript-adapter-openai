import { TestHost } from "@criteria/adapter-sdk/testing";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { adapterConfig } from "../index.ts";

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/chat/completions" && req.method === "POST") {
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "submit_outcome",
                      arguments: JSON.stringify({ outcome: "success", reason: "Done" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = mockServer.port;
});

afterAll(() => {
  mockServer.stop();
});

describe("openai adapter", () => {
  let host: TestHost | undefined;

  afterEach(async () => {
    if (host) {
      await host.stop();
      host = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("opens a session and finalizes an outcome", async () => {
    host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "gpt-4o", max_turns: "3" },
      secrets: {
        OPENAI_API_KEY: "sk-test-key",
        OPENAI_BASE_URL: `http://localhost:${mockPort}`,
      },
    });

    const result = await host.execute({
      stepName: "analyze",
      input: { prompt: "Test prompt" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("success");
  });

  it("rejects missing OPENAI_API_KEY", async () => {
    host = new TestHost({ config: adapterConfig });
    await expect(
      host.openSession({
        config: {},
        secrets: {},
      })
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("serializes and restores session state", async () => {
    host = new TestHost({ config: adapterConfig });
    await host.openSession({
      config: { model: "gpt-4o" },
      secrets: { OPENAI_API_KEY: "sk-test-key" },
    });

    const snapshot = await host.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.state).toBeDefined();
    expect(snapshot.state.length).toBeGreaterThan(0);

    // Restore into a fresh session
    const host2 = new TestHost({ config: adapterConfig });
    try {
      await host2.openSession({
        config: {},
        secrets: { OPENAI_API_KEY: "sk-test-key" },
      });
      await host2.restore(snapshot);
    } finally {
      await host2.stop();
    }
  });
});
