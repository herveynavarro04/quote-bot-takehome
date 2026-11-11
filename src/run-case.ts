// Runs one case from cases/cases.json through the agent, single turn.
// usage: npm run case -- 3
import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "./agent.js";

const cases = JSON.parse(fs.readFileSync("cases/cases.json", "utf8"));
const id = Number(process.argv[2] ?? 1);
const c = cases.find((x: any) => x.id === id);
if (!c) throw new Error(`no case ${id}`);

const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.message }];
const answer = await runTurn(messages);
console.log(`\ncase ${id}: ${c.message}\nbot> ${answer}`);
process.exit(0);
