import type { QuoteResult } from "./carriers/types.js";

const MONEY_RE = /(?:\$\s?[\d.,]+(?:\.\d+)?|\b\d[\d.,]*\s*(?:MXN|mxn|pesos?)\b)/g;

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/[\s,$]/g, "").replace(/MXN|mxn|pesos?/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface GuardrailReport {
  pass: boolean;
  unbacked: string[];
  allowed_amounts: number[];
}

export function extractAmounts(text: string): { raw: string; value: number }[] {
  const matches = text.match(MONEY_RE) ?? [];
  const out: { raw: string; value: number }[] = [];
  for (const m of matches) {
    const v = toNumber(m);
    if (v != null) out.push({ raw: m, value: v });
  }
  return out;
}

export function allowedAmounts(result: QuoteResult): number[] {
  if (result.status !== "ok") return [];
  const vals = new Set<number>();
  for (const c of result.carriers ?? []) {
    for (const r of c.rates) {
      vals.add(Number(r.price_mxn.toFixed(2)));
      if (r.breakdown) for (const v of Object.values(r.breakdown)) vals.add(Number(v.toFixed(2)));
    }
  }
  for (const r of result.ranked ?? []) vals.add(Number(r.price_mxn.toFixed(2)));
  return [...vals];
}

export function checkAnswer(answer: string, result: QuoteResult): GuardrailReport {
  const allowed = allowedAmounts(result);
  const amounts = extractAmounts(answer);
  const unbacked: string[] = [];
  for (const a of amounts) {
    const match = allowed.some((v) => Math.abs(v - a.value) <= 0.01);
    if (!match) unbacked.push(a.raw);
  }
  return { pass: unbacked.length === 0, unbacked, allowed_amounts: allowed };
}

// Deterministic fallback when the model repeatedly produces unbacked prices.
export function buildTemplateAnswer(result: QuoteResult): string {
  if (result.status === "needs_input") {
    return `Para cotizar necesito: ${(result.missing ?? []).join(", ")}.`;
  }
  const lines: string[] = [];
  const warn = result.warnings ?? [];
  const ranked = result.ranked ?? [];
  if (ranked.length === 0) {
    lines.push("No se pudo obtener una cotización verificable.");
  } else {
    const r = ranked[0];
    lines.push(`Recomendación: ${r.carrier} ${r.service} por $${r.price_mxn.toFixed(2)} MXN (IVA: ${r.iva}).`);
  }
  const notOk = (result.carriers ?? []).filter((c) => c.status !== "ok");
  for (const c of notOk) lines.push(`• ${c.carrier}: ${c.status}${c.error ? ` (${c.error})` : ""}`);
  if (warn.length) lines.push(`Advertencias: ${warn.join(", ")}.`);
  return lines.join("\n");
}
