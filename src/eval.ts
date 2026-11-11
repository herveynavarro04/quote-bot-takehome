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
type CaseConfig = { checks: string[]; mustAskFor?: string[] };

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
  // Numeric comparison with ±0.01 tolerance — the tool result is JSON, so
  // "1168.10" in the answer and 1168.1 in the stored price would never
  // string-match, but they're the same amount. We extract every money-shaped
  // number from the haystack and compare numerically.
  const value = Number(normalizeMoney(amount));
  if (!Number.isFinite(value)) return false;
  const nums = (haystack.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  return nums.some((n) => Math.abs(n - value) <= 0.01);
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

// A model "asks" when it either uses a question mark or uses request-form language
// (necesito, me falta, dime, por favor compárteme, could you share, please provide...).
// A bulleted list of items the model needs still counts.
const ASK_RE = /(\?|¿|necesit[oa]|me falt[ao]|falt[ao]n?|d[ií]me|comp[aá]rteme|comparte|prov[ií]deme|cu[eé]ntame|puedes (?:decirme|indicarme|compartir|mandarme)|please (?:share|provide|tell|send)|could you (?:share|provide|tell))/i;

function checkMustAsk(answer: string): CheckResult {
  const asks = ASK_RE.test(answer);
  const hasPrice = extractAmounts(answer).length > 0;
  return { name: "mustAsk", pass: asks && !hasPrice, note: !asks ? "answer doesn't ask for info" : hasPrice ? "contains price" : undefined };
}

function findQuoteCalls(trace: TraceEvent) {
  return trace.tools.filter((t) => t.name === "quote_shipment" || t.name === "get_price");
}

function parsedResults(trace: TraceEvent): any[] {
  return findQuoteCalls(trace).map((c) => { try { return JSON.parse(c.result); } catch { return null; } }).filter(Boolean);
}

function latestResult(trace: TraceEvent): any | null {
  const rs = parsedResults(trace);
  return rs.length ? rs[rs.length - 1] : null;
}

function checkNoQuoteShipment(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  return { name: "noQuoteShipment", pass: calls.length === 0, note: calls.length ? `${calls.length} calls` : undefined };
}

// "No carrier was contacted": no quote call, OR every call returned needs_input,
// OR no carrier entry has a browser-captured evidence path (no site actually hit).
function checkNoCarrierContacted(trace: TraceEvent): CheckResult {
  const results = parsedResults(trace);
  if (results.length === 0) return { name: "noCarrierContacted", pass: true };
  for (const r of results) {
    if (r?.status === "needs_input") continue;
    const carriers: any[] = Array.isArray(r?.carriers) ? r.carriers : [];
    const anyHit = carriers.some((c) => c?.evidence?.screenshot && typeof c.evidence.screenshot === "string" && c.evidence.screenshot.length > 0);
    if (anyHit) return { name: "noCarrierContacted", pass: false, note: "evidence captured — a carrier site was opened" };
  }
  return { name: "noCarrierContacted", pass: true };
}

const ASK_FOR_KEYWORDS: Record<string, RegExp> = {
  postal: /c[oó]digo postal|postal code|\bCP\b|\bC\.P\.?\b|zip/i,
  origin: /origen|desde|origin\b|from\b/i,
  weight: /peso|weight\b|\bkg\b|\blb\b|libras|kilogram/i,
  dimensions: /medidas|dimens|largo|ancho|alto|high|width|length|tama[nñ]o|caja.*(cm|in|pulg)|dimensions|size\b/i,
};

function checkMustAskFor(answer: string, items: string[]): CheckResult {
  const missing: string[] = [];
  for (const it of items) {
    const re = ASK_FOR_KEYWORDS[it];
    if (!re) { missing.push(`${it}(no-pattern)`); continue; }
    if (!re.test(answer)) missing.push(it);
  }
  return { name: "mustAskFor", pass: missing.length === 0, note: missing.length ? `missing: ${missing.join(",")}` : undefined };
}

// For each warning in the latest quote result, require the answer to mention it
// (in Spanish or English). If there are no warnings, pass trivially.
const WARNING_HINTS: Record<string, RegExp> = {
  price_is_approximate: /aproximad|approx/i,
  insurance_not_provided: /seguro|insurance|cobertura/i,
  suspicious_postal_code: /sospech|suspic|dudos|parece incorrect|no (es|parece) v[aá]lid|invalid postal/i,
  weight_mismatch: /peso.*(difer|diferen|mismatch|no coincide)|diferen.*peso|weight (?:mismatch|differs)/i,
  no_service_meets_deadline: /no (hay|existe|cumpl).*(plazo|d[ií]a|deadline|mañana|next[- ]day)|ningun.*servicio.*(plazo|d[ií]a)/i,
  iva_unspecified: /iva (no )?(?:especific|indicad|se indica|informad)/i,
  carrier_not_quoted: /no (se )?(?:pudo )?cotiz|no quot|not quoted|no (?:devolvi[oó]|contest[oó]|respondi[oó])/i,
};

function checkWarningsMentioned(answer: string, trace: TraceEvent): CheckResult {
  const r = latestResult(trace);
  if (!r) return { name: "warningsMentioned", pass: true };
  const warnings: string[] = Array.isArray(r?.warnings) ? r.warnings : [];
  if (warnings.length === 0) return { name: "warningsMentioned", pass: true };
  const missing: string[] = [];
  for (const w of warnings) {
    const re = WARNING_HINTS[w];
    if (!re) { missing.push(`${w}(no-pattern)`); continue; }
    if (!re.test(answer)) missing.push(w);
  }
  return { name: "warningsMentioned", pass: missing.length === 0, note: missing.length ? `missing: ${missing.join(",")}` : undefined };
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
  const hasPriority = calls.some((c) => /"priority"\s*:\s*"cheapest"/.test(JSON.stringify(c.input)));
  if (!hasPriority) return { name: "cheapestPriority", pass: false, note: "priority != cheapest" };
  const ranked = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.ranked) ? j.ranked : []; } catch { return []; }
  });
  if (ranked.length === 0) return { name: "cheapestPriority", pass: false, note: "no ranked rates" };
  const prices = ranked.map((r: any) => r.price_mxn).filter((n: any) => typeof n === "number");
  if (prices.length === 0) return { name: "cheapestPriority", pass: false, note: "no prices in ranked" };
  const min = Math.min(...prices);
  const first = ranked[0];
  return { name: "cheapestPriority", pass: first.price_mxn === min, note: first.price_mxn === min ? undefined : `first=${first.price_mxn} min=${min}` };
}

function checkDeadlineHandled(answer: string, trace: TraceEvent): CheckResult {
  const amounts = extractAmounts(answer);
  // Credit the "asked user for missing data" branch when there's no price AND
  // the answer uses asking-form language (ASK_RE), same rule as mustAsk.
  // A literal '?' is sufficient but not required.
  if (amounts.length === 0 && ASK_RE.test(answer)) return { name: "deadlineHandled", pass: true, note: "asked user" };
  const calls = findQuoteCalls(trace);
  const hasDeadline = calls.some((c) => /(deadline|next[_ ]?day|dia[_ ]?siguiente|tomorrow|mañana|urgent)/i.test(JSON.stringify(c.input)));
  if (!hasDeadline) return { name: "deadlineHandled", pass: false, note: "no deadline set and no clarification question" };
  return { name: "deadlineHandled", pass: true };
}

function checkNamedCarrierStatuses(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "namedCarrierStatuses", pass: false, note: "no quote_shipment call" };
  const carriers = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.carriers) ? j.carriers : []; } catch { return []; }
  });
  const needed = ["estafeta", "dhl", "fedex"];
  const valid = new Set(["ok", "blocked", "timeout", "no_service", "invalid_input", "error"]);
  const missing: string[] = [];
  for (const name of needed) {
    const r = carriers.find((x: any) => String(x?.carrier ?? "").toLowerCase().includes(name));
    if (!r) missing.push(name);
    else if (!valid.has(r.status)) missing.push(`${name}(bad-status)`);
    else if (r.status !== "ok" && Array.isArray(r.rates) && r.rates.length > 0) missing.push(`${name}(priced-but-${r.status})`);
  }
  return { name: "namedCarrierStatuses", pass: missing.length === 0, note: missing.length ? missing.join(",") : undefined };
}

function checkFourParcels(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "fourParcels", pass: false, note: "no quote_shipment call" };
  const matches = (p: any) => Number(p?.weight) === 10 && Number(p?.length) === 40 && Number(p?.width) === 30 && Number(p?.height) === 30;
  const ok = calls.some((c) => {
    const input: any = c.input ?? {};
    const parcels = input.parcels;
    if (!Array.isArray(parcels) || parcels.length < 1) return false;
    const totalQty = parcels.reduce((n: number, p: any) => n + Number(p?.quantity ?? 1), 0);
    if (totalQty !== 4) return false;
    return parcels.every(matches);
  });
  return { name: "fourParcels", pass: ok, note: ok ? undefined : "did not describe 4x(10kg,40x30x30) parcels (via quantity or separate entries)" };
}

function checkInsuranceOrWarning(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "insuranceOrWarning", pass: false, note: "no quote_shipment call" };
  const hasDeclared = calls.some((c) => /"declared_value_mxn"\s*:\s*25000/.test(JSON.stringify(c.input)));
  if (!hasDeclared) return { name: "insuranceOrWarning", pass: false, note: "declared_value_mxn != 25000" };
  const rateHits = calls.some((c) => {
    try {
      const j = JSON.parse(c.result);
      const carriers = Array.isArray(j?.carriers) ? j.carriers : [];
      return carriers.some((cc: any) => cc?.rates?.some((r: any) => r?.breakdown && /seguro|insurance/i.test(JSON.stringify(r.breakdown))));
    } catch { return false; }
  });
  const warnHits = calls.some((c) => {
    try {
      const j = JSON.parse(c.result);
      const warns: string[] = Array.isArray(j?.warnings) ? j.warnings : [];
      return warns.includes("insurance_not_provided");
    } catch { return false; }
  });
  return { name: "insuranceOrWarning", pass: rateHits || warnHits, note: (rateHits || warnHits) ? undefined : "no insurance cost or warning" };
}

function checkBadPostalFlagged(answer: string, trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  const signals = calls.some((c) => {
    try {
      const j = JSON.parse(c.result);
      const warns: string[] = Array.isArray(j?.warnings) ? j.warnings : [];
      if (warns.includes("suspicious_postal_code")) return true;
      const carriers = Array.isArray(j?.carriers) ? j.carriers : [];
      return carriers.some((cc: any) => cc?.status === "invalid_input" || /postal|cp|código/i.test(cc?.error ?? ""));
    } catch { return false; }
  });
  const answerFlags = /(99999|código postal|postal code|dudoso|suspicious|inválido|invalid)/i.test(answer) && extractAmounts(answer).length === 0;
  return { name: "badPostalFlagged", pass: signals || answerFlags, note: (signals || answerFlags) ? undefined : "no rejection or warning" };
}

function checkEvidenceOk(trace: TraceEvent): CheckResult {
  const calls = findQuoteCalls(trace);
  if (calls.length === 0) return { name: "evidenceOk", pass: true };
  const carriers = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.carriers) ? j.carriers : []; } catch { return []; }
  });
  const okCarriers = carriers.filter((r: any) => r?.status === "ok");
  if (okCarriers.length === 0) return { name: "evidenceOk", pass: true };
  const missing = okCarriers.filter((r: any) => {
    const ev = r?.evidence ?? {};
    const hasUrl = typeof ev.url === "string" && ev.url.length > 0;
    const hasEvidence = ev.screenshot || ev.raw_html_path;
    return !(hasUrl && hasEvidence);
  });
  return { name: "evidenceOk", pass: missing.length === 0, note: missing.length ? `${missing.length} ok without evidence` : undefined };
}

// Dispatcher per check name
function runCheck(name: string, c: Case, cfg: CaseConfig, answer: string, trace: TraceEvent): CheckResult {
  switch (name) {
    case "noUnbackedPrice": return checkNoUnbackedPrice(answer, trace);
    case "mustQuote": return checkMustQuote(answer, trace);
    case "noPrice": return checkNoPrice(answer);
    case "mustAsk": {
      const base = checkMustAsk(answer);
      if (!base.pass || !cfg.mustAskFor?.length) return base;
      // When mustAskFor is set, additionally require the specific items to appear.
      const extra = checkMustAskFor(answer, cfg.mustAskFor);
      return { name: "mustAsk", pass: extra.pass, note: extra.note };
    }
    case "noQuoteShipment": return checkNoQuoteShipment(trace);
    case "noCarrierContacted": return checkNoCarrierContacted(trace);
    case "keepsUserUnits": return checkKeepsUserUnits(trace);
    case "cheapestPriority": return checkCheapestPriority(trace);
    case "deadlineHandled": return checkDeadlineHandled(answer, trace);
    case "namedCarrierStatuses": return checkNamedCarrierStatuses(trace);
    case "fourParcels": return checkFourParcels(trace);
    case "insuranceOrWarning": return checkInsuranceOrWarning(trace);
    case "badPostalFlagged": return checkBadPostalFlagged(answer, trace);
    case "evidenceOk": return checkEvidenceOk(trace);
    case "warningsMentioned": return checkWarningsMentioned(answer, trace);
    default: return { name, pass: false, note: "unknown check" };
  }
}

function carrierStatusSummary(trace: TraceEvent): string {
  const calls = findQuoteCalls(trace);
  if (!calls.length) return "-";
  const carriers = calls.flatMap((c) => {
    try { const j = JSON.parse(c.result); return Array.isArray(j?.carriers) ? j.carriers : []; } catch { return []; }
  });
  if (!carriers.length) return "-";
  return carriers.map((r: any) => `${r.carrier ?? "?"}:${r.status ?? "?"}`).join(" ");
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

    const caseCfg: CaseConfig = checksCfg.cases?.[String(c.id)] ?? { checks: [] };
    const perCaseChecks: string[] = caseCfg.checks ?? [];
    const toRun = [...globalChecks, ...perCaseChecks];
    const results: CheckResult[] = toRun.map((name) => runCheck(name, c, caseCfg, answer, trace));
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

  try { const t = await import("./carriers/common.js"); await (t as any).closeBrowser?.(); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
