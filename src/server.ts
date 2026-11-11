// Minimal web server for the QuoteBot chat UI.
// usage: npm run dev  ->  http://localhost:3000 (first visit shows the start page, then the chat)
import http from "node:http";
import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { runTurn } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3000);

// conversations live in memory, keyed by an id the browser sends
const conversations = new Map<string, Anthropic.MessageParam[]>();

const server = http.createServer(async (req, res) => {
  // Start page: the brief as a short animation plus setup checks. Shown on the first visit.
  const seenStart = (req.headers.cookie ?? "").includes("qb_started=1");
  if (req.method === "GET" && (req.url === "/start" || (req.url === "/" && !seenStart))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync("public/start.html"));
    return;
  }

  if (req.method === "GET" && req.url === "/api/setup") {
    const major = Number(process.versions.node.split(".")[0]);
    let hasChromium = false;
    try { hasChromium = fs.existsSync(chromium.executablePath()); } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      node: process.versions.node,
      nodeOk: major >= 20,
      chromium: hasChromium,
      apiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    }));
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/chat" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "qb_started=1; Path=/; Max-Age=31536000; SameSite=Lax" });
    res.end(fs.readFileSync("public/index.html"));
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { conversationId, message } = JSON.parse(body);

    const messages = conversations.get(conversationId) ?? [];
    conversations.set(conversationId, messages);
    messages.push({ role: "user", content: message });

    try {
      const answer = await runTurn(messages);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer }));
    } catch (e) {
      console.log(e);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: "Error" }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`QuoteBot on http://localhost:${PORT}  (start page: http://localhost:${PORT}/start)`));
