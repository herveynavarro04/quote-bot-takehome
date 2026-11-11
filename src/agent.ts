import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { tools, executeTool } from "./tools.js";

const client = new Anthropic();

const MODEL = "claude-opus-5-5";
const MAX_STEPS = 60;

// Runs the agent for one user turn. Mutates `messages` with the whole exchange.
export async function runTurn(messages: Anthropic.MessageParam[]): Promise<string> {
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
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return "Lo siento, tardé demasiado. Intenta de nuevo.";
}
