import type { Page } from "playwright";
import type { CarrierResult, NormalizedParcel, Rate } from "./types.js";
import { captureResponse, detectBlock, runAdapter } from "./common.js";
import { CARRIER_CONFIGS, validateForCarrier } from "../quote/normalize.js";

export const ESTAFETA_URL = "https://cotizadorsitecorecms.azurewebsites.net/Cotizador/";
export const ESTAFETA_FALLBACK_URL = "https://www.estafeta.com/cotizar-envio";

const SERVICE_META: Record<string, { speed_rank: number; next_day: boolean; label: string }> = {
  "12:30":        { speed_rank: 1, next_day: true,  label: "12:30" },
  "Dia Sig.":     { speed_rank: 2, next_day: true,  label: "Dia Sig." },
  "Día Sig.":     { speed_rank: 2, next_day: true,  label: "Dia Sig." },
  "2 Dias":       { speed_rank: 3, next_day: false, label: "2 Dias" },
  "2 Días":       { speed_rank: 3, next_day: false, label: "2 Dias" },
  "Terrestre":    { speed_rank: 4, next_day: false, label: "Terrestre" },
};

const ROW_LABELS = [
  "Peso kg",
  "Costo de Guía",
  "Cargo por Combustible",
  "Costo de Sobrepeso",
  "Reexpedición",
  "Manejo Especial",
  "Seguro Opcional",
  "Total",
];

function parseAmount(raw: string): number | null {
  const m = raw.replace(/\s|\$/g, "").match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => NAMED_ENTITIES[m] ?? m);
}

// Match money-shaped numbers: require a decimal point or thousands grouping so
// bare integers that come from stray markup don't masquerade as prices.
const MONEY_NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+/g;

// Parse the Estafeta result page HTML. Returns rates keyed by service column.
export function parseEstafetaHtml(html: string): { rates: Rate[]; billedKg?: number; origin?: string; destination?: string; ivaIncluded: boolean } {
  const ivaIncluded = /Los precios incluyen I\.?V\.?A/i.test(html);

  const originM = html.match(/CP\s*(\d{5})[^<]*?([A-ZÁÉÍÓÚÑ\s,]+)/i);
  const origin = originM ? `${originM[1]} ${originM[2].trim()}` : undefined;
  const destM = html.match(/CP\s*(\d{5})[^<]*?([A-ZÁÉÍÓÚÑ\s,]+)/gi);
  const destination = destM && destM.length > 1 ? destM[1] : undefined;

  // Normalize whitespace for row/column parsing. Stripping tags lets us work with simple text slices.
  // HTML entities (e.g. &#243; = 'ó') must be decoded *before* we scan for prices — otherwise
  // "Reexpedici&#243;n" turns into the literal "243" and poisons the money regex.
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();

  const servicesPresent = Object.keys(SERVICE_META).filter((s) => text.includes(s));
  const uniqueServices: string[] = [];
  const seen = new Set<string>();
  for (const s of servicesPresent) {
    const lbl = SERVICE_META[s].label;
    if (!seen.has(lbl)) { seen.add(lbl); uniqueServices.push(lbl); }
  }

  // For each row label, grab the trailing numbers in the order they appear.
  const perRow: Record<string, number[]> = {};
  for (const label of ROW_LABELS) {
    const idx = text.indexOf(label);
    if (idx === -1) continue;
    const nextLabelIdx = ROW_LABELS
      .filter((l) => l !== label)
      .map((l) => text.indexOf(l, idx + label.length))
      .filter((i) => i > idx)
      .sort((a, b) => a - b)[0] ?? text.length;
    const slice = text.slice(idx + label.length, nextLabelIdx);
    const nums = slice.match(MONEY_NUMBER_RE) ?? [];
    perRow[label] = nums.map((s) => Number(s.replace(/,/g, ""))).filter((n) => Number.isFinite(n));
  }

  const totals = perRow["Total"] ?? [];
  const rates: Rate[] = [];
  uniqueServices.forEach((svc, i) => {
    const price = totals[i];
    if (price == null) return;
    const meta = SERVICE_META[svc] ?? SERVICE_META[svc as keyof typeof SERVICE_META];
    if (!meta) return;
    const breakdown: Record<string, number> = {};
    for (const label of ["Costo de Guía", "Cargo por Combustible", "Costo de Sobrepeso", "Reexpedición"]) {
      const v = (perRow[label] ?? [])[i];
      if (v != null) breakdown[label] = v;
    }
    rates.push({
      service: meta.label,
      price_mxn: price,
      iva: ivaIncluded ? "included" : "unspecified",
      speed_rank: meta.speed_rank,
      next_day: meta.next_day,
      breakdown: Object.keys(breakdown).length ? breakdown : undefined,
    });
  });

  const billedKg = (perRow["Peso kg"] ?? [])[0];

  return { rates, billedKg, origin, destination, ivaIncluded };
}

function multiplyRates(rates: Rate[], factor: number): Rate[] {
  if (factor === 1) return rates;
  return rates.map((r) => ({
    ...r,
    price_mxn: Number((r.price_mxn * factor).toFixed(2)),
    breakdown: r.breakdown
      ? Object.fromEntries(Object.entries(r.breakdown).map(([k, v]) => [k, Number((v * factor).toFixed(2))]))
      : undefined,
  }));
}

async function fillAndSubmit(page: Page, origin: string, destination: string, parcel: NormalizedParcel, type: "package" | "envelope") {
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#zipCodeOri").waitFor({ state: "visible", timeout: 15_000 });
  await page.fill("#zipCodeOri", origin);
  await page.fill("#zipCodeDes", destination);

  if (type === "package") {
    // The form defaults to envelope; must explicitly select package.
    const pkgRadio = page.locator("#package");
    if (await pkgRadio.count()) await pkgRadio.check({ force: true }).catch(async () => {
      await pkgRadio.click({ force: true });
    });
    const toFixed = (n: number) => Number(n.toFixed(3)).toString();
    await page.fill("#weightPackage", toFixed(Math.max(parcel.real_kg, parcel.billable_kg)));
    await page.fill("#highPackage", toFixed(parcel.height_cm));
    await page.fill("#longPackage", toFixed(parcel.length_cm));
    await page.fill("#widthPackage", toFixed(parcel.width_cm));
  }

  const submit = page.getByRole("link", { name: /^Enviar$/ });
  const respP = captureResponse(page, (r) => r.request().method() === "POST" && /cotizadorsitecorecms/i.test(r.url()));
  await submit.click();
  let resp;
  try { resp = await respP; } catch { resp = undefined; }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return resp;
}

export interface EstafetaArgs {
  origin_cp: string;
  destination_cp: string;
  parcel: NormalizedParcel;
  type: "package" | "envelope";
  declared_value_mxn?: number;
}

export async function quoteEstafeta(args: EstafetaArgs): Promise<CarrierResult> {
  const cfg = CARRIER_CONFIGS.estafeta;
  const limitErr = args.type === "package" ? validateForCarrier(args.parcel, cfg) : null;
  if (limitErr) {
    return {
      carrier: "estafeta",
      status: "invalid_input",
      rates: [],
      error: limitErr,
      warnings: [],
      evidence: { url: ESTAFETA_URL, screenshot: "", captured_at: new Date().toISOString() },
      ms: 0,
    };
  }

  return runAdapter({
    carrier: "estafeta",
    url: ESTAFETA_URL,
    run: async (ctx) => {
      const nav = await ctx.page.goto(ESTAFETA_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const preBlock = await detectBlock(ctx.page, nav?.status());
      if (preBlock) { ctx.setStatus("blocked"); ctx.setError(preBlock); return { rates: [] }; }

      const resp = await fillAndSubmit(ctx.page, args.origin_cp, args.destination_cp, args.parcel, args.type);

      const postBlock = await detectBlock(ctx.page, resp?.status());
      if (postBlock) { ctx.setStatus("blocked"); ctx.setError(postBlock); return { rates: [] }; }

      // Method A: raw network response HTML
      let networkRates: Rate[] = [];
      let billedKg: number | undefined;
      let origin: string | undefined;
      let destination: string | undefined;
      let ivaIncluded = false;
      let rawHtml: string | undefined;

      if (resp) {
        try {
          const body = await resp.text();
          rawHtml = body;
          const parsed = parseEstafetaHtml(body);
          networkRates = parsed.rates;
          billedKg = parsed.billedKg;
          origin = parsed.origin;
          destination = parsed.destination;
          ivaIncluded = parsed.ivaIncluded;
        } catch {}
      }

      // Method B: DOM fallback
      let domRates: Rate[] = [];
      try {
        await ctx.page.locator(".innerServicioResultado, table").first().waitFor({ state: "visible", timeout: 10_000 });
      } catch {}
      try {
        const domHtml = await ctx.page.content();
        const parsedDom = parseEstafetaHtml(domHtml);
        domRates = parsedDom.rates;
        if (!billedKg) billedKg = parsedDom.billedKg;
        if (!origin) origin = parsedDom.origin;
        if (!destination) destination = parsedDom.destination;
        if (!ivaIncluded) ivaIncluded = parsedDom.ivaIncluded;
      } catch {}

      // Site-side validation errors: e.g. unknown CP shows a message and no rates
      if (networkRates.length === 0 && domRates.length === 0) {
        const errText = await ctx.page.locator("text=/código postal|codigo postal|no (es|está) válido|no se (pudo|puede)/i").first().textContent().catch(() => null);
        if (errText) { ctx.setStatus("invalid_input"); ctx.setError(errText.trim()); return { rates: [] }; }
        ctx.setStatus("no_service"); ctx.setError("no rates found on page");
        return { rates: [] };
      }

      let chosen: Rate[];
      let method: "network" | "dom";
      if (networkRates.length > 0) {
        method = "network";
        chosen = networkRates;
        if (domRates.length > 0) {
          const disagree = chosen.some((r) => {
            const d = domRates.find((x) => x.service === r.service);
            return d && Math.abs(d.price_mxn - r.price_mxn) > 0.01;
          });
          if (disagree) ctx.setDoubtful(true);
        }
      } else {
        method = "dom";
        chosen = domRates;
      }
      ctx.setMethod(method);

      // Approximate price warning (site labels Total as "Cotización Aproximada")
      ctx.addWarning("price_is_approximate");
      if (!ivaIncluded) ctx.addWarning("iva_unspecified");

      // Multiply for quantity
      const q = args.parcel.quantity;
      const final = multiplyRates(chosen, q);

      // Weight sanity: compare billed vs computed billable (±1 or ceiling)
      if (billedKg != null) {
        const expected = args.parcel.billable_kg;
        const near = Math.abs(billedKg - expected) < 0.01 || Math.abs(billedKg - Math.ceil(expected)) < 0.01;
        if (!near) { ctx.setDoubtful(true); ctx.addWarning("weight_mismatch"); }
        ctx.setSiteEcho({ origin, destination, billed_weight_kg: billedKg });
      } else {
        ctx.setSiteEcho({ origin, destination });
      }

      if (args.declared_value_mxn) ctx.addWarning("insurance_not_provided");

      return { rates: final };
    },
  });
}
