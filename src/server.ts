// Minimal web server for the QuoteBot chat UI.
// usage: npm run dev  ->  http://localhost:3000 (first visit shows the start page, then the chat)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { runTurn, type TraceEvent } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3000);
const EVIDENCE_ROOT = path.resolve("evidence");

// conversations live in memory, keyed by an id the browser sends
const conversations = new Map<string, Anthropic.MessageParam[]>();

function latestQuoteFromTrace(trace: TraceEvent): unknown | undefined {
  for (let i = trace.tools.length - 1; i >= 0; i--) {
    const call = trace.tools[i];
    if (call.name !== "quote_shipment" || call.is_error) continue;
    try { return JSON.parse(call.result); } catch { return undefined; }
  }
  return undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveEvidence(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/evidence/")) return false;
  const rel = decodeURIComponent(req.url.slice("/evidence/".length));
  const resolved = path.resolve(EVIDENCE_ROOT, rel);
  if (!resolved.startsWith(EVIDENCE_ROOT + path.sep) && resolved !== EVIDENCE_ROOT) {
    res.writeHead(403); res.end("forbidden"); return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404); res.end("not found"); return true;
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = ext === ".png" ? "image/png"
             : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
             : ext === ".html" ? "text/html; charset=utf-8"
             : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=300" });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

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
    sendJson(res, 200, {
      node: process.versions.node,
      nodeOk: major >= 20,
      chromium: hasChromium,
      apiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    });
    return;
  }

  if (serveEvidence(req, res)) return;

  if (req.method === "GET" && req.url === "/whatsapp.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" });
    res.end(fs.readFileSync("public/whatsapp.js"));
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
    let conversationId: string; let message: string;
    try {
      const parsed = JSON.parse(body);
      conversationId = String(parsed.conversationId);
      message = String(parsed.message ?? "");
    } catch {
      sendJson(res, 400, { error: "Solicitud inválida." });
      return;
    }

    const messages = conversations.get(conversationId) ?? [];
    conversations.set(conversationId, messages);
    messages.push({ role: "user", content: message });

    const trace: TraceEvent = { tools: [], usages: [] };
    try {
      const answer = await runTurn(messages, trace);
      const quote = latestQuoteFromTrace(trace);
      sendJson(res, 200, { answer, quote });
    } catch (e: any) {
      console.log(e);
      sendJson(res, 500, { error: "No pude conectar con el servidor, intenta de nuevo.", detail: e?.message ?? String(e) });
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`QuoteBot on http://localhost:${PORT}  (start page: http://localhost:${PORT}/start)`));
