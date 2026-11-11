import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type TraceEvent, MODEL_NAME } from "./agent.js";

const CASE_TIMEOUT_MS = Number(process.env.EVAL_CASE_TIMEOUT_MS ?? 180_000);

// USD per 1M tokens (public prices, Nov 2026: https://platform.claude.com/docs/en/about-claude/pricing)
const PRICING: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5":   { in: 4,   out: 20, cacheWrite: 5,    cacheRead: 0.20 },
  "claude-sonnet-5-5": { in: 2,   out: 10, cacheWrite: 2.5,  cacheRead: 0.10 },
  "claude-haiku-5-5":  { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }, // solo prompts ≤100k
};

function priceFor(model: string): { in: number; out: number } {
  for (const key of Object.keys(PRICING)) if (model.startsWith(key)) return PRICING[key];
  if (model.includes("opus")) return { in: 15, out: 75 };
  if (model.includes("sonnet")) return { in: 3, out: 15 };
  if (model.includes("haiku")) return { in: 1, out: 5 };
  return { in: 15, out: 75 };
}

function costUsd(trace: TraceEvent): number {
  let total = 0;
  for (const u of trace.usages) {
    const p = priceFor(u.model);
    total += (u.input_tokens * p.in + u.output_tokens * p.out) / 1_000_000;
  }
  return total;
}

type Case = { id: number; message: string; expect: string };
type CheckResult = { name: string; pass: boolean; note?: string };

const MONEY_RE = /(?:\$\s?[\d.,]+(?:\.\d+)?|\b\d[\d.,]*\s*(?:MXN|mxn|pesos?)\b)/g;

function normalizeMoney(s: string): string {
  return s.replace(/[\s,$]/g, "").replace(/MXN|mxn|pesos?/g, "").trim();
}

function extractAmounts(text: string): string[] {
  const matches = text.match(MONEY_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const n = normalizeMoney(m);
    if (!n || n === "." || isNaN(Number(n))) continue;
    if (!seen.has(n)) { seen.add(n); out.push(m); }
  }
  return out;
}

function toolResultsConcat(trace: TraceEvent): string {
  return trace.tools.map((t) => `${t.name} ${JSON.stringify(t.input)} :: ${t.result}`).join("\n");
}

function amountInResults(amount: string, haystack: string): boolean {
  const norm = normalizeMoney(amount);
  if (!norm) return false;
  const plain = norm.replace(/\.00$/, "");
  const hayNorm = haystack.replace(/[\s,]/g, "");
  return hayNorm.includes(norm) || hayNorm.includes(plain);
}

// ---- checks ----

function checkNoUnbackedPrice(answer: string, trace: TraceEvent): CheckResult {
  const amounts = extractAmounts(answer);
  if (amounts.length === 0) return { name: "noUnbackedPrice", pass: true };
  const hay = toolResultsConcat(trace);
  const unbacked = amounts.filter((a) => !amountInResults(a, hay));
  return {
    name: "noUnbackedPrice",
    pass: unbacked.length === 0,
    note: unbacked.length ? `unbacked: ${unbacked.join(", ")}` : undefined,
  };
}

function checkMustQuote(answer: string, trace: TraceEvent): CheckResult {
  const amounts = extractAmounts(answer);
  if (amounts.length === 0) return { name: "mustQuote", pass: false, note: "no price in answer" };
  const hay = toolResultsConcat(trace);
  const backed = amounts.some((a) => amountInResults(a, hay));
  return { name: "mustQuote", pass: backed, note: backed ? undefined : "price not backed by tool result" };
}

function checkNoPrice(answer: string): CheckResult {
  const amounts = extractAmounts(answer);
  return { name: "noPrice", pass: amounts.length === 0, note: amounts.length ? `found: ${amounts.join(", ")}` : undefined };
}

function checkMustAsk(answer: string): CheckResult {
  const hasQuestion = /\?/.test(answer);
  const hasPrice = extractAmounts(answer).length > 0;
  return { name: "mustAsk", pass: hasQuestion && !hasPrice, note: !hasQuestion ? "no question mark" : hasPrice ? "contains price" : undefined };
}

function findQuoteCalls(trace: TraceEvent) {
  return trace.tools.filter((t) => t.name === "quote_shipment" || t.name === "get_price");
}

function checkNoQuoteShipment(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  return { name: "noQuoteShipment", pass: calls.length === 0, note: calls.length ? `${calls.length} calls` : undefined };
}

function checkKeepsUserUnits(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "keepsUserUnits", pass: false, note: "no quote_shipment call" };
  const ok = calls.some((c) => /\b(lb|in|inch|pound)\b/i.test(JSON.stringify(c.input)));
  return { name: "keepsUserUnits", pass: ok, note: ok ? undefined : "input did not keep lb/in units" };
}

function checkCheapestPriority(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "cheapestPriority", pass: false, note: "no quote_shipment call" };
  const hasPriority = calls.some((c) => /\bcheapest\b/i.test(JSON.stringify(c.input)));
  if (!hasPriority) return { name: "cheapestPriority", pass: false, note: "priority != cheapest" };
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  const okResults = results.filter((r: any) => r?.status === "ok" && typeof r?.price === "number");
  if (okResults.length === 0) return { name: "cheapestPriority", pass: false, note: "no ok results to rank" };
  const min = Math.min(...okResults.map((r: any) => r.price));
  const first = okResults[0];
  return { name: "cheapestPriority", pass: first.price === min, note: first.price === min ? undefined : `first=${first.price} min=${min}` };
}

function checkDeadlineHandled(answer: string, trace: TraceEvent): CheckResult {
  const amounts = extractAmounts(answer);
  if (amounts.length === 0 && /\?/.test(answer)) return { name: "deadlineHandled", pass: true, note: "asked user" };
  const calls = findQuoteCalls(trace);
  const hasDeadline = calls.some((c) => /(deadline|next[_ ]?day|dia[_ ]?siguiente|tomorrow|mañana|urgent)/i.test(JSON.stringify(c.input)));
  if (!hasDeadline) return { name: "deadlineHandled", pass: false, note: "no deadline set and no clarification question" };
  return { name: "deadlineHandled", pass: true };
}

function checkNamedCarrierStatuses(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "namedCarrierStatuses", pass: false, note: "no quote_shipment call" };
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  const needed = ["estafeta", "dhl", "fedex"];
  const valid = new Set(["ok", "blocked", "timeout", "no_service", "error"]);
  const missing: string[] = [];
  for (const name of needed) {
    const r = results.find((x: any) => String(x?.carrier ?? "").toLowerCase().includes(name));
    if (!r) missing.push(name);
    else if (!valid.has(r.status)) missing.push(`${name}(bad-status)`);
    else if (r.status !== "ok" && r.price != null) missing.push(`${name}(priced-but-${r.status})`);
  }
  return { name: "namedCarrierStatuses", pass: missing.length === 0, note: missing.length ? missing.join(",") : undefined };
}

function checkFourParcels(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "fourParcels", pass: false, note: "no quote_shipment call" };
  const ok = calls.some((c) => {
    const input: any = c.input ?? {};
    const parcels = input.parcels;
    if (!Array.isArray(parcels) || parcels.length !== 4) return false;
    return parcels.every((p: any) => Number(p.weight_kg ?? p.weight) === 10 &&
      Number(p.length_cm ?? p.length) === 40 && Number(p.width_cm ?? p.width) === 30 && Number(p.height_cm ?? p.height) === 30);
  });
  return { name: "fourParcels", pass: ok, note: ok ? undefined : "parcels != 4x(10kg,40x30x30)" };
}

function checkInsuranceOrWarning(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "insuranceOrWarning", pass: false, note: "no quote_shipment call" };
  const hasDeclared = calls.some((c) => /"(declared_value|declaredValue|insured_value)"\s*:\s*25000/.test(JSON.stringify(c.input)));
  if (!hasDeclared) return { name: "insuranceOrWarning", pass: false, note: "declared_value != 25000" };
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  const hasInsurance = results.some((r: any) => r?.insurance_cost != null || /insurance/i.test(JSON.stringify(r?.warnings ?? "")));
  const hasWarning = results.some((r: any) => /insurance not provided/i.test(JSON.stringify(r?.warnings ?? "")));
  return { name: "insuranceOrWarning", pass: hasInsurance || hasWarning, note: (hasInsurance || hasWarning) ? undefined : "no insurance cost or warning" };
}

function checkBadPostalFlagged(answer: string, trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  const rejected = results.some((r: any) => /(invalid|reject|unknown).*(postal|cp)|suspicious/i.test(JSON.stringify(r)));
  const answerFlags = /(99999|código postal|postal code|dudoso|suspicious|inválido|invalid)/i.test(answer) && extractAmounts(answer).length === 0;
  return { name: "badPostalFlagged", pass: rejected || answerFlags, note: (rejected || answerFlags) ? undefined : "no rejection or warning" };
}

function checkEvidenceOk(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "evidenceOk", pass: true };
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  const okResults = results.filter((r: any) => r?.status === "ok");
  if (okResults.length === 0) return { name: "evidenceOk", pass: true };
  const missing = okResults.filter((r: any) => {
    const hasUrl = typeof r?.url === "string" && r.url.length > 0;
    const hasEvidence = r?.screenshot || r?.raw_text || r?.raw_json || r?.evidence;
    return !(hasUrl && hasEvidence);
  });
  return { name: "evidenceOk", pass: missing.length === 0, note: missing.length ? `${missing.length} ok without evidence` : undefined };
}

// Dispatcher per check name
function runCheck(name: string, c: Case, answer: string, trace: TraceEvent): CheckResult {
  switch (name) {
    case "noUnbackedPrice": return checkNoUnbackedPrice(answer, trace);
    case "mustQuote": return checkMustQuote(answer, trace);
    case "noPrice": return checkNoPrice(answer);
    case "mustAsk": return checkMustAsk(answer);
    case "noQuoteShipment": return checkNoQuoteShipment(trace);
    case "keepsUserUnits": return checkKeepsUserUnits(trace);
    case "cheapestPriority": return checkCheapestPriority(trace);
    case "deadlineHandled": return checkDeadlineHandled(answer, trace);
    case "namedCarrierStatuses": return checkNamedCarrierStatuses(trace);
    case "fourParcels": return checkFourParcels(trace);
    case "insuranceOrWarning": return checkInsuranceOrWarning(trace);
    case "badPostalFlagged": return checkBadPostalFlagged(answer, trace);
    case "evidenceOk": return checkEvidenceOk(trace);
    default: return { name, pass: false, note: "unknown check" };
  }
}

function carrierStatusSummary(trace: TraceEvent): string {
  const calls = findQuoteCalls(trace);
  if (!calls.length) return "-";
  const results = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.results) ? j.results : []; } catch { return []; }
  });
  if (!results.length) return "-";
  return results.map((r: any) => `${r.carrier ?? "?"}:${r.status ?? "?"}`).join(" ");
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new Error(`case timed out after ${ms}ms`)); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function parseArgs(argv: string[]): number[] {
  const ids: number[] = [];
  for (const a of argv) {
    const n = Number(a);
    if (Number.isFinite(n) && Number.isInteger(n)) ids.push(n);
  }
  return ids;
}

function dateStamp(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function main() {
  const casesPath = path.resolve("cases/cases.json");
  const checksPath = path.resolve("cases/checks.json");
  const cases: Case[] = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const checksCfg = JSON.parse(fs.readFileSync(checksPath, "utf8"));

  const wanted = parseArgs(process.argv.slice(2));
  const selected = wanted.length ? cases.filter((c) => wanted.includes(c.id)) : cases;

  fs.mkdirSync("traces", { recursive: true });
  const stamp = dateStamp();

  const globalChecks: string[] = checksCfg.global ?? [];
  const summary: any[] = [];

  for (const c of selected) {
    console.log(`\n=== case ${c.id}: ${c.message}`);
    const trace: TraceEvent = { tools: [], usages: [] };
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.message }];
    const started = Date.now();
    let answer = "";
    let timedOut = false;
    let error: string | undefined;

    try {
      answer = await withTimeout(runTurn(messages, trace), CASE_TIMEOUT_MS, () => { timedOut = true; });
    } catch (e: any) {
      error = e?.message ?? String(e);
      if (!timedOut) console.log("run error", e);
    }

    const elapsedMs = Date.now() - started;
    const cost = costUsd(trace);

    const perCaseChecks: string[] = checksCfg.cases?.[String(c.id)]?.checks ?? [];
    const toRun = [...globalChecks, ...perCaseChecks];
    const results: CheckResult[] = toRun.map((name) => runCheck(name, c, answer, trace));
    if (timedOut || error) results.push({ name: "runCompleted", pass: false, note: timedOut ? "timeout" : error });

    const failed = results.filter((r) => !r.pass);
    const pass = failed.length === 0;

    const record = {
      id: c.id,
      message: c.message,
      model: MODEL_NAME,
      elapsed_ms: elapsedMs,
      cost_usd: Number(cost.toFixed(6)),
      tokens: trace.usages.reduce((acc, u) => ({ input: acc.input + u.input_tokens, output: acc.output + u.output_tokens }), { input: 0, output: 0 }),
      tool_calls: trace.tools,
      answer,
      checks: results,
      pass,
      error,
    };
    fs.writeFileSync(path.join("traces", `${stamp}-case-${c.id}.json`), JSON.stringify(record, null, 2));
    summary.push({ ...record, carrier_statuses: carrierStatusSummary(trace) });
  }

  console.log("\n" + "=".repeat(100));
  console.log("case | pass | failed checks | time    | cost     | carrier statuses");
  console.log("-".repeat(100));
  for (const r of summary) {
    const failedNames = r.checks.filter((c: CheckResult) => !c.pass).map((c: CheckResult) => c.name).join(",") || "-";
    console.log(
      `${String(r.id).padEnd(4)} | ${r.pass ? "PASS" : "FAIL"} | ${failedNames.padEnd(40)} | ${(r.elapsed_ms + "ms").padEnd(7)} | $${r.cost_usd.toFixed(4)} | ${r.carrier_statuses}`
    );
  }

  const totals = {
    model: MODEL_NAME,
    ran: summary.length,
    passed: summary.filter((s) => s.pass).length,
    pass_rate: summary.length ? summary.filter((s) => s.pass).length / summary.length : 0,
    avg_time_ms: summary.length ? Math.round(summary.reduce((a, s) => a + s.elapsed_ms, 0) / summary.length) : 0,
    total_cost_usd: Number(summary.reduce((a, s) => a + s.cost_usd, 0).toFixed(6)),
    unbacked_price_cases: summary.filter((s) => s.checks.some((c: CheckResult) => c.name === "noUnbackedPrice" && !c.pass)).length,
  };
  fs.writeFileSync(path.join("traces", `${stamp}-summary.json`), JSON.stringify({ totals, cases: summary }, null, 2));
  console.log("\ntotals:", totals);

  try { const t = await import("./tools.js"); await (t as any).closeBrowser?.(); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
