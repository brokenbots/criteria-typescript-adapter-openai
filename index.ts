/**
 * OpenAI Adapter for Criteria (Protocol v2)
 *
 * This adapter enables using OpenAI's models as agent backends in Criteria
 * workflows. It supports multi-turn conversations, tool calling, and
 * outcome finalization via the v2 SDK helper surface.
 *
 * Secrets (all flow via the secret channel; only OPENAI_API_KEY is required):
 * - OPENAI_API_KEY    – Required. Your OpenAI API key.
 * - OPENAI_BASE_URL   – Optional. Override the API base URL.
 * - OPENAI_ORG_ID     – Optional. Organization ID.
 * - OPENAI_PROJECT_ID – Optional. Project ID.
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "openai"
 *   input {
 *     prompt    = "Analyze this codebase for security issues"
 *     max_turns = 10
 *   }
 *   outcome "clean"        { transition_to = "deploy" }
 *   outcome "issues_found" { transition_to = "review" }
 *   outcome "failure"      { transition_to = "failed" }
 * }
 * ```
 */

import { serve } from "@criteria/adapter-sdk";
import OpenAI from "openai";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TURNS = 10;

const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current step. Call this exactly once with one of the allowed outcomes before ending the turn. The allowed outcomes are provided in the conversation context. Failure to call this tool with a valid outcome will fail the step.`;

// ============================================================================
// Helpers
// ============================================================================

function buildSystemPrompt(configSystemPrompt?: string): string {
  return (
    configSystemPrompt ??
    "You are a helpful assistant integrated into a workflow system. When you complete your task, you MUST call the submit_outcome tool with the appropriate outcome to proceed."
  );
}

function buildTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: SUBMIT_OUTCOME_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              description: "The outcome name to finalize. Must be one of the allowed outcomes.",
            },
            reason: {
              type: "string",
              description: "Optional reason for the outcome.",
            },
          },
          required: ["outcome"],
        },
      },
    },
  ];
}

interface SubmitOutcomeArgs {
  outcome: string;
  reason?: string;
}

function parseSubmitOutcomeArgs(raw: string): SubmitOutcomeArgs {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("submit_outcome arguments must be an object");
  }
  const args = parsed as Record<string, unknown>;
  if (typeof args.outcome !== "string") {
    throw new Error('submit_outcome argument "outcome" is required and must be a string');
  }
  return {
    outcome: args.outcome,
    reason: typeof args.reason === "string" ? args.reason : undefined,
  };
}

// ============================================================================
// Main
// ============================================================================

export const adapterConfig = {
  name: "openai",
  version: "2.0.0",
  description: "OpenAI adapter for Criteria workflows.",
  source_url: "https://github.com/criteria-adapters/openai",
  capabilities: ["multi_turn", "structured_events", "tool_calling"],
  platforms: ["linux/amd64", "linux/arm64", "darwin/arm64"],

  config_schema: {
    fields: {
      model: {
        type: "string",
        required: false,
        description: `Model to use (default: ${DEFAULT_MODEL})`,
      },
      max_turns: {
        type: "number",
        required: false,
        description: "Maximum turns per Execute call",
      },
      system_prompt: {
        type: "string",
        required: false,
        description: "System prompt for the conversation",
      },
    },
  },

  input_schema: {
    fields: {
      prompt: {
        type: "string",
        required: true,
        description: "The prompt to send to the model",
      },
      max_turns: {
        type: "number",
        required: false,
        description: "Per-step override for max turns",
      },
      model: {
        type: "string",
        required: false,
        description: "Per-step override for model",
      },
    },
  },

  output_schema: {
    fields: {
      reason: {
        type: "string",
        required: false,
        description: "Reason for the chosen outcome",
      },
    },
  },

  secrets: [
    {
      name: "OPENAI_API_KEY",
      required: true,
      description: "OpenAI API key",
    },
    {
      name: "OPENAI_BASE_URL",
      required: false,
      description: "Override the OpenAI API base URL",
    },
    {
      name: "OPENAI_ORG_ID",
      required: false,
      description: "OpenAI organization ID",
    },
    {
      name: "OPENAI_PROJECT_ID",
      required: false,
      description: "OpenAI project ID",
    },
  ],

  permissions: [],

  async openSession(req, helpers) {
    const apiKey = await helpers.secrets.get("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI API key is required. Set the OPENAI_API_KEY secret.");
    }

    const baseURL = (await helpers.secrets.get("OPENAI_BASE_URL")) ?? undefined;
    const organization = (await helpers.secrets.get("OPENAI_ORG_ID")) ?? undefined;
    const project = (await helpers.secrets.get("OPENAI_PROJECT_ID")) ?? undefined;

    const client = new OpenAI({
      apiKey,
      baseURL,
      organization,
      project,
    });

    const model = req.config.model || DEFAULT_MODEL;
    const maxTurns = parseInt(req.config.max_turns, 10) || DEFAULT_MAX_TURNS;
    const systemPrompt = buildSystemPrompt(req.config.system_prompt);

    helpers.session.set("client", client);
    helpers.session.set("model", model);
    helpers.session.set("maxTurns", maxTurns);
    helpers.session.set("systemPrompt", systemPrompt);
    helpers.session.set("messages", [] as OpenAI.Chat.ChatCompletionMessageParam[]);
    helpers.session.set("finalizeAttempts", 0);

    await helpers.log.stdout(`[openai] Session opened (model=${model})\n`);
  },

  async execute(req, helpers) {
    const prompt = req.input.prompt;
    if (!prompt) {
      throw new Error("input.prompt is required");
    }

    const client = helpers.session.get<OpenAI>("client");
    const model = req.input.model ?? helpers.session.get<string>("model") ?? DEFAULT_MODEL;
    const maxTurns = parseInt(req.input.max_turns, 10) || helpers.session.get<number>("maxTurns") || DEFAULT_MAX_TURNS;
    const systemPrompt = helpers.session.get<string>("systemPrompt") ?? buildSystemPrompt();

    // Reset per-execution state
    helpers.session.set("finalizeAttempts", 0);
    let messages = helpers.session.get<OpenAI.Chat.ChatCompletionMessageParam[]>("messages") ?? [];

    // Inject system prompt at the start if not already present
    if (messages.length === 0 || messages[0]?.role !== "system") {
      messages = [{ role: "system", content: systemPrompt }, ...messages];
    }

    // Add allowed-outcomes preamble to the prompt
    const allowedOutcomes = req.allowedOutcomes ?? [];
    if (allowedOutcomes.length > 0) {
      const outcomeList = allowedOutcomes.join(", ");
      const preamble = `You must finalize the outcome for this step by calling the submit_outcome tool exactly once before ending the turn. The allowed outcomes are: ${outcomeList}. If you do not call the tool with a valid outcome, the step will fail.\n\n`;
      messages.push({ role: "user", content: preamble + prompt });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    await helpers.log.stdout(`[openai] Starting conversation with model ${model}\n`);

    const tools = buildTools();
    let turnCount = 0;

    while (turnCount < maxTurns) {
      turnCount++;
      await helpers.log.stdout(`[openai] Turn ${turnCount}/${maxTurns}\n`);

      const response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: "auto",
      });

      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("No response from OpenAI API");
      }

      // Append assistant message to history
      messages.push(message);

      // Stream content
      if (message.content) {
        await helpers.log.stdout(message.content);
        await helpers.log.adapterEvent("agent.message", {
          content: message.content,
          turn: turnCount,
        });
      }

      // Handle tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.function.name === SUBMIT_OUTCOME_TOOL_NAME) {
            let args: SubmitOutcomeArgs;
            try {
              args = parseSubmitOutcomeArgs(toolCall.function.arguments);
            } catch (e) {
              await helpers.log.adapterEvent("tool.error", {
                error: "Failed to parse submit_outcome arguments",
                detail: String(e),
              });
              // Push tool error back into conversation
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: Failed to parse submit_outcome arguments. ${String(e)}`,
              });
              continue;
            }

            const outcome = args.outcome?.trim();
            const reason = args.reason?.trim() ?? "";

            // Validate outcome via helpers.outcomes
            const validation = await helpers.outcomes.validate(outcome);
            if (!validation.valid) {
              const errorMsg = validation.error ?? `Outcome "${outcome}" is not allowed.`;
              await helpers.log.adapterEvent("outcome.finalized", {
                outcome,
                reason,
                success: false,
                error: errorMsg,
              });
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: errorMsg,
              });
              continue;
            }

            // Success — finalize
            await helpers.log.adapterEvent("outcome.finalized", {
              outcome,
              reason,
              success: true,
            });

            await helpers.outcomes.finalize(outcome, { reason });
            helpers.session.set("messages", messages);
            return;
          }
        }
      }

      // No tool calls — model ended turn without finalizing
      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }
    }

    // Max turns reached or conversation ended without outcome
    if (turnCount >= maxTurns) {
      await helpers.log.adapterEvent("limit.reached", { max_turns: maxTurns });
    } else {
      await helpers.log.adapterEvent("outcome.failure", {
        reason: "missing finalize",
        attempts: helpers.session.get<number>("finalizeAttempts") ?? 0,
      });
    }

    // Fallback outcome selection
    const fallback = allowedOutcomes.includes("needs_review")
      ? "needs_review"
      : "failure";
    await helpers.outcomes.finalize(fallback, {
      reason: turnCount >= maxTurns ? "Max turns reached" : "Conversation ended without submit_outcome",
    });

    helpers.session.set("messages", messages);
  },

  async snapshot(sessionId, helpers) {
    const messages = helpers.session.get<OpenAI.Chat.ChatCompletionMessageParam[]>("messages") ?? [];
    const state = {
      messages,
      model: helpers.session.get<string>("model"),
      maxTurns: helpers.session.get<number>("maxTurns"),
      systemPrompt: helpers.session.get<string>("systemPrompt"),
      finalizeAttempts: helpers.session.get<number>("finalizeAttempts"),
    };
    return {
      state: new TextEncoder().encode(JSON.stringify(state)),
      schemaVersion: 1,
    };
  },

  async restore(sessionId, blob, helpers) {
    const state = JSON.parse(new TextDecoder().decode(blob.state)) as {
      messages: OpenAI.Chat.ChatCompletionMessageParam[];
      model: string;
      maxTurns: number;
      systemPrompt: string;
      finalizeAttempts: number;
    };

    helpers.session.set("messages", state.messages);
    helpers.session.set("model", state.model);
    helpers.session.set("maxTurns", state.maxTurns);
    helpers.session.set("systemPrompt", state.systemPrompt);
    helpers.session.set("finalizeAttempts", state.finalizeAttempts);
  },

  async closeSession(req, helpers) {
    await helpers.log.stdout(`[openai] Session closed\n`);
  },
};

export default adapterConfig;

if (import.meta.url === `file://${process.argv[1]}`) {
  serve(adapterConfig);
}
