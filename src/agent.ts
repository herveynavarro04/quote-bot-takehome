import Anthropic from "@anthropic-ai/sdk";
import "./env.js";
import { SYSTEM_PROMPT, ACTIVE_PROMPT } from "./prompt.js";
import { quoteShipment } from "./quote/quote.js";
import { quoteShipmentJsonSchema } from "./quote/schema.js";
import { checkAnswer, buildTemplateAnswer } from "./guardrail.js";
import type { QuoteResult } from "./carriers/types.js";

const client = new Anthropic();

const MODEL = process.env.QB_AGENT_MODEL ?? "claude-sonnet-5-5";
const MAX_STEPS = 4;

export const MODEL_NAME = MODEL;
export const ACTIVE_PROMPT_VERSION = ACTIVE_PROMPT;

export interface TraceEvent {
  tools: Array<{ name: string; input: unknown; result: string; is_error?: boolean }>;
  usages: Array<{ input_tokens: number; output_tokens: number; model: string }>;
  guardrail?: { attempts: number; unbacked: string[]; used_template: boolean };
}

const quoteTool: Anthropic.Tool = {
  name: "quote_shipment",
  description: "Validate the shipment input, quote enabled carriers in parallel, and return a ranked structured result. The model never computes prices; this tool reads them from carrier sites. If required data is missing (postal code, weight, or box dimensions for packages) the tool returns status='needs_input' with the list of missing fields.",
  input_schema: quoteShipmentJsonSchema as any,
};

function extractText(content: Anthropic.ContentBlock[]): string {
  return content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
}

async function createMessage(messages: Anthropic.MessageParam[], trace?: TraceEvent) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [quoteTool],
    messages,
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
  return response;
}

// Runs the agent for one user turn. Mutates `messages` with the whole exchange.
export async function runTurn(messages: Anthropic.MessageParam[], trace?: TraceEvent): Promise<string> {
  const toolResults: QuoteResult[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await createMessage(messages, trace);
    messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

    if (response.stop_reason !== "tool_use") {
      let answer = extractText(response.content as Anthropic.ContentBlock[]);
      const latest = toolResults[toolResults.length - 1];
      if (latest) {
        const report = checkAnswer(answer, latest);
        if (!report.pass) {
          if (trace) trace.guardrail = { attempts: 1, unbacked: report.unbacked, used_template: false };
          // Re-ask once with the unbacked list.
          messages.push({
            role: "user",
            content: `Guardrail: these amounts in your answer are not backed by quote_shipment results: ${report.unbacked.join(", ")}. Rewrite your answer using only amounts that appear in the ranked list or breakdown. Allowed amounts: ${report.allowed_amounts.map((v) => v.toFixed(2)).join(", ")}.`,
          });
          const retry = await createMessage(messages, trace);
          messages.push({ role: "assistant", content: retry.content as Anthropic.ContentBlockParam[] });
          const retryAnswer = extractText(retry.content as Anthropic.ContentBlock[]);
          const retryReport = checkAnswer(retryAnswer, latest);
          if (retryReport.pass) return retryAnswer;
          if (trace) trace.guardrail = { attempts: 2, unbacked: retryReport.unbacked, used_template: true };
          return buildTemplateAnswer(latest);
        }
      }
      return answer;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`  -> ${block.name} ${JSON.stringify(block.input)}`);
      if (block.name !== "quote_shipment") {
        const msg = `unknown tool: ${block.name}`;
        if (trace) trace.tools.push({ name: block.name, input: block.input, result: msg, is_error: true });
        results.push({ type: "tool_result", tool_use_id: block.id, content: msg, is_error: true });
        continue;
      }
      try {
        const quoteResult = await quoteShipment(block.input);
        toolResults.push(quoteResult);
        const serialized = JSON.stringify(quoteResult);
        if (trace) trace.tools.push({ name: block.name, input: block.input, result: serialized });
        results.push({ type: "tool_result", tool_use_id: block.id, content: serialized });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (trace) trace.tools.push({ name: block.name, input: block.input, result: msg, is_error: true });
        results.push({ type: "tool_result", tool_use_id: block.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // Ran out of steps without a final text answer.
  const latest = toolResults[toolResults.length - 1];
  if (latest) return buildTemplateAnswer(latest);
  return "No pude completar la cotización.";
}
