import { TestHost } from "@criteria/adapter-sdk/testing";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";

const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isArm64 = process.arch === "arm64";
const isX64 = process.arch === "x64";

function getBinaryPath(): string {
  if (isDarwin && isArm64) return "./out/adapter-darwin-arm64";
  if (isLinux && isX64) return "./out/adapter-linux-amd64";
  if (isLinux && isArm64) return "./out/adapter-linux-arm64";
  throw new Error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
}

const BINARY = getBinaryPath();

// Monkey-patch TestHost.execute to add an error handler on the Log stream,
// preventing unhandled gRPC connection-drop noise during binary cleanup.
const _origExecute = (TestHost.prototype as any).execute;
(TestHost.prototype as any).execute = async function (...args: any[]) {
  const client = (this as any).client;
  if (client && !client.__patchedLog) {
    const origLog = client.Log.bind(client);
    client.Log = function (...logArgs: any[]) {
      const stream = origLog(...logArgs);
      stream.on("error", () => {});
      stream.on("end", () => {});
      return stream;
    };
    client.__patchedLog = true;
  }
  return _origExecute.apply(this, args);
};

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
    host = new TestHost({ binary: BINARY });
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
    host = new TestHost({ binary: BINARY });
    await expect(
      host.openSession({
        config: {},
        secrets: {},
      })
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("serializes and restores session state", async () => {
    host = new TestHost({ binary: BINARY });
    await host.openSession({
      config: { model: "gpt-4o" },
      secrets: { OPENAI_API_KEY: "sk-test-key" },
    });

    const snapshot = await host.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.state).toBeDefined();
    expect(snapshot.state.length).toBeGreaterThan(0);

    // Restore into a fresh session
    const host2 = new TestHost({ binary: BINARY });
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
