import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "./agent.js";

const rl = readline.createInterface({ input: stdin, output: stdout });
const messages: Anthropic.MessageParam[] = [];

console.log("QuoteBot 📦  (ctrl+c to exit)\n");
while (true) {
  const user = await rl.question("tú> ");
  messages.push({ role: "user", content: user });
  const answer = await runTurn(messages);
  console.log(`\nbot> ${answer}\n`);
}
