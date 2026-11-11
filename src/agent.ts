import Anthropic from "@anthropic-ai/sdk";
import "./env.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { tools, executeTool } from "./tools.js";

const client = new Anthropic();

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
const MAX_STEPS = 60;

export interface TraceEvent {
  tools: Array<{ name: string; input: unknown; result: string }>;
  usages: Array<{ input_tokens: number; output_tokens: number; model: string }>;
}

export const MODEL_NAME = MODEL;

// Runs the agent for one user turn. Mutates `messages` with the whole exchange.
export async function runTurn(messages: Anthropic.MessageParam[], trace?: TraceEvent): Promise<string> {
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      // On a safety decline, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (trace && response.usage) {
      trace.usages.push({
        input_tokens: response.usage.input_tokens ?? 0,
        output_tokens: response.usage.output_tokens ?? 0,
        model: (response as any).model ?? MODEL,
      });
    }

    messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      return text;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`  -> ${block.name} ${JSON.stringify(block.input)}`);
        const out = await executeTool(block.name, block.input);
        if (trace) trace.tools.push({ name: block.name, input: block.input, result: out });
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return "Lo siento, tardé demasiado. Intenta de nuevo.";
}
