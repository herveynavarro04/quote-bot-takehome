import fs from "node:fs";
import type { Page, Response } from "playwright";
import type { CarrierResult, NormalizedParcel, Rate } from "./types.js";
import { captureResponse, detectBlock, runAdapter } from "./common.js";
import { CARRIER_CONFIGS, validateForCarrier } from "../quote/normalize.js";

export const FEDEX_URL = "https://www.fedex.com/es-mx/online/rating.html";
const RATES_API_RE = /\/magr-bff\/magr\/public\/v3\/rates\/quotes/i;

export interface FedexArgs {
  origin_cp: string;
  destination_cp: string;
  parcel: NormalizedParcel;
  type: "package" | "envelope";
  declared_value_mxn?: number;
}

// Classify a service name into (next_day, speed_rank).
// Lower speed_rank = faster. We first try the site's own delivery datetime,
// but the service name gives a reliable fallback.
function classifyService(name: string): { speed_rank: number; next_day: boolean } {
  const n = name.toLowerCase();
  if (/\b8:30\b/.test(n)) return { speed_rank: 1, next_day: true };
  if (/\b10:30\b/.test(n)) return { speed_rank: 2, next_day: true };
  if (/d[ií]a\s*siguiente/.test(n)) return { speed_rank: 3, next_day: true };
  if (/econ[oó]mico/.test(n)) return { speed_rank: 5, next_day: false };
  return { speed_rank: 4, next_day: false };
}

async function dismissCookies(page: Page): Promise<void> {
  // Usercentrics banner lives in a shadow root. Playwright's getByRole pierces
  // open shadow roots; if it doesn't show up within 3 s we assume it's gone.
  try {
    await page.getByRole("button", { name: /Rechazar cookies opcionales|Reject optional cookies/i })
      .click({ timeout: 3_000 });
  } catch { /* banner wasn't there or already dismissed */ }
}

// Type the CP, wait for Google Places listbox, pick the Mexican match.
// Returns the chosen label (for site_echo) together with the full list of
// suggestion texts we saw. The caller inspects `suggestions.length` to tell
// a true "no match in Mexico" (invalid_input) from "listbox never populated"
// (likely block — bot wall killed the Places call).
async function pickMexicanSuggestion(
  page: Page,
  selector: string,
  cp: string,
): Promise<{ picked: string; suggestions: string[]; listboxVisible: boolean }> {
  await page.locator(selector).click();
  // pressSequentially-like: clear then type character by character — some
  // autocompletes don't fire on fill().
  await page.locator(selector).fill("");
  await page.locator(selector).pressSequentially(cp, { delay: 20 });

  const listbox = page.locator("ul[role='listbox'], [role='listbox']").first();
  let listboxVisible = false;
  try {
    await listbox.waitFor({ state: "visible", timeout: 8_000 });
    listboxVisible = true;
  } catch { /* listbox never appeared */ }

  const options = listbox.locator("[role='option'], li");
  const count = listboxVisible ? await options.count().catch(() => 0) : 0;
  const suggestions: string[] = [];
  let match = -1;
  for (let i = 0; i < count; i++) {
    const text = ((await options.nth(i).textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    suggestions.push(text);
    if (match === -1 && text.includes(cp) && /M[eé]xico/i.test(text)) match = i;
  }
  if (match === -1) {
    return { picked: "", suggestions, listboxVisible };
  }
  await options.nth(match).click();
  const picked = (await page.inputValue(selector).catch(() => "")) || suggestions[match];
  return { picked, suggestions, listboxVisible };
}

async function assertUnitsMetric(page: Page): Promise<void> {
  // Weight unit (kg)
  const weightSelect = page.locator("[data-e2e-id=selectMeasurement]").first();
  if (await weightSelect.count()) {
    const val = (await weightSelect.inputValue().catch(() => "")) || "";
    if (!/kg/i.test(val)) {
      const kgOption = await weightSelect.locator("option").filter({ hasText: /kg/i }).first().getAttribute("value").catch(() => null);
      if (kgOption != null) await weightSelect.selectOption(kgOption).catch(() => {});
    }
  }
  // Dimension unit (cm)
  const dimSelect = page.locator("[data-e2e-id=selectMetric]").first();
  if (await dimSelect.count()) {
    const val = (await dimSelect.inputValue().catch(() => "")) || "";
    if (!/cm/i.test(val)) {
      const cmOption = await dimSelect.locator("option").filter({ hasText: /cm/i }).first().getAttribute("value").catch(() => null);
      if (cmOption != null) await dimSelect.selectOption(cmOption).catch(() => {});
    }
  }
}

async function fillDimensions(page: Page, L: number, W: number, H: number): Promise<void> {
  // The three inputs live inside a group whose heading contains "Dimensiones".
  // IDs are render-order dependent, so locate by group + positional input.
  const group = page.locator("div, section, fieldset").filter({ hasText: /Dimensiones/i }).first();
  const inputs = group.locator("input[type='number'], input.mat-mdc-input-element, input.mdc-text-field__input").filter({
    hasNot: page.locator("[data-e2e-id=selectMetric]"),
  });
  const n = await inputs.count();
  if (n < 3) throw new Error(`Dimensions group found ${n} inputs, expected 3`);
  await inputs.nth(0).fill(String(L));
  await inputs.nth(1).fill(String(W));
  await inputs.nth(2).fill(String(H));
}

interface ParsedRate {
  service: string;
  prices: Array<{ rateType: string; totalNetCharge: number; totalTaxes?: number }>;
  billingWeight?: number;
  billingWeightUnit?: string;
  deliveryText?: string;
  deliveryDate?: string;
}

function parseRatesJson(json: any): ParsedRate[] {
  const details: any[] = json?.output?.rateReplyDetails ?? json?.rateReplyDetails ?? [];
  const out: ParsedRate[] = [];
  for (const d of details) {
    const service: string = d.serviceName || d.serviceType || d.name || "FedEx";
    const shipDetails: any[] = d.ratedShipmentDetails ?? d.ratedPackages ?? [];
    const prices = shipDetails.map((r) => ({
      rateType: String(r.rateType ?? r.rateZone ?? "UNKNOWN"),
      totalNetCharge: Number(r.totalNetCharge ?? r.totalNetChargeWithDutiesAndTaxes ?? r.totalBaseCharge ?? NaN),
      totalTaxes: typeof r.totalTaxes === "number" ? r.totalTaxes : undefined,
    })).filter((p) => Number.isFinite(p.totalNetCharge));

    const bw = shipDetails[0]?.shipmentRateDetail?.totalBillingWeight ?? shipDetails[0]?.totalBillingWeight ?? d.commit?.weight ?? d.billingWeight;
    const billingWeight = typeof bw?.value === "number" ? bw.value : (typeof bw === "number" ? bw : undefined);
    const billingWeightUnit = bw?.units;

    const deliveryDate: string | undefined = d.operationalDetail?.deliveryDate ?? d.commit?.dateDetail?.dayOfWeek ?? d.deliveryDate;
    const deliveryText: string | undefined = d.commit?.label ?? deliveryDate;

    out.push({ service, prices, billingWeight, billingWeightUnit, deliveryText, deliveryDate });
  }
  return out;
}

function extractIvaFromDom(html: string): "included" | "unspecified" {
  return /Total estimado|IVA incluido|precio final incluye/i.test(html) ? "included" : "unspecified";
}

function parseAmount(raw: string): number | null {
  const m = raw.replace(/\s|\$/g, "").match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+\.\d+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// DOM fallback: each service is a `.magr-c-rates` row; the expand button's
// accessible name ends with the shown price; the struck-through sibling is the regular price.
async function parseDomRates(page: Page): Promise<Array<{ service: string; shown?: number; struck?: number }>> {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".magr-c-rates, [class*='c-rates']"));
    const parseN = (s: string | null | undefined): number | undefined => {
      if (!s) return undefined;
      const m = s.replace(/[\s,$]/g, "").match(/\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : undefined;
    };
    return rows.map((row) => {
      const h = row as HTMLElement;
      const service = (h.querySelector(".magr-c-rates__service-name, [class*='service']") as HTMLElement | null)?.innerText?.trim() || "FedEx";
      const expand = h.querySelector("button[aria-label*='$'], button[aria-label*='precios']") as HTMLButtonElement | null;
      const shown = parseN(expand?.getAttribute("aria-label"));
      const struck = parseN((h.querySelector("del, s, .price-strikethrough, [class*='strike']") as HTMLElement | null)?.innerText);
      return { service, shown, struck };
    });
  });
}

export async function quoteFedex(args: FedexArgs): Promise<CarrierResult> {
  const cfg = CARRIER_CONFIGS.fedex;
  if (args.type === "envelope") {
    return {
      carrier: "fedex", status: "error", rates: [], error: "envelope not supported in adapter yet",
      warnings: [], evidence: { url: FEDEX_URL, screenshot: "", captured_at: new Date().toISOString() }, ms: 0,
    };
  }
  const limitErr = validateForCarrier(args.parcel, cfg);
  if (limitErr) {
    return {
      carrier: "fedex", status: "invalid_input", rates: [], error: limitErr,
      warnings: [], evidence: { url: FEDEX_URL, screenshot: "", captured_at: new Date().toISOString() }, ms: 0,
    };
  }

  return runAdapter({
    carrier: "fedex",
    url: FEDEX_URL,
    run: async (ctx) => {
      const nav = await ctx.page.goto(FEDEX_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const preBlock = await detectBlock(ctx.page, nav?.status());
      if (preBlock) { ctx.setStatus("blocked"); ctx.setError(preBlock); return { rates: [] }; }

      await dismissCookies(ctx.page);

      // Wait for the form to render. If the field never shows up, something
      // bigger than user input is wrong (Akamai soft-block without a title,
      // Angular didn't bootstrap, selector changed).
      const originField = ctx.page.locator("#fromGoogleAddress").first();
      try {
        await originField.waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        const lateBlock = await detectBlock(ctx.page);
        if (lateBlock) { ctx.setStatus("blocked"); ctx.setError(lateBlock); return { rates: [] }; }
        ctx.setStatus("error"); ctx.setError("form never rendered (#fromGoogleAddress not visible)");
        return { rates: [] };
      }

      // 1. Origin / destination via Places autocomplete (mandatory to pick a suggestion).
      // Invalid_input only when suggestions actually loaded and none matched the
      // CP; if the listbox never populated AND mid-flow network block is seen,
      // it's a bot wall — the shared watcher in runAdapter will promote the
      // final status to "blocked". Errors otherwise.
      let originEcho = "", destEcho = "";
      const classifyNoMatch = (which: "origen" | "destino", cp: string, listboxVisible: boolean, suggestions: string[]): void => {
        ctx.setDebug(`${which === "origen" ? "origin" : "destination"}_suggestions`, suggestions);
        const block = ctx.blockSeen();
        if (block) { ctx.setStatus("blocked"); ctx.setError(`Akamai bloqueó la validación del código postal (${which}): ${block}`); return; }
        if (!listboxVisible || suggestions.length === 0) {
          ctx.setStatus("error");
          ctx.setError(`FedEx no abrió el autocompletado de ${which} (sin red bloqueada visible)`);
          return;
        }
        ctx.setStatus("invalid_input");
        ctx.setError(`FedEx no reconoció el código postal ${cp} (${which}): ${suggestions.slice(0, 3).join(" | ")}`);
      };

      try {
        const r = await pickMexicanSuggestion(ctx.page, "#fromGoogleAddress", args.origin_cp);
        ctx.setDebug("origin_suggestions", r.suggestions);
        if (!r.picked) { classifyNoMatch("origen", args.origin_cp, r.listboxVisible, r.suggestions); return { rates: [] }; }
        originEcho = r.picked;
      } catch (e: any) {
        const block = ctx.blockSeen();
        if (block) { ctx.setStatus("blocked"); ctx.setError(`Akamai: ${block}`); return { rates: [] }; }
        ctx.setStatus("error"); ctx.setError(e?.message ?? "could not fill origin");
        return { rates: [] };
      }
      try {
        const r = await pickMexicanSuggestion(ctx.page, "#toGoogleAddress", args.destination_cp);
        ctx.setDebug("destination_suggestions", r.suggestions);
        if (!r.picked) { classifyNoMatch("destino", args.destination_cp, r.listboxVisible, r.suggestions); return { rates: [] }; }
        destEcho = r.picked;
      } catch (e: any) {
        const block = ctx.blockSeen();
        if (block) { ctx.setStatus("blocked"); ctx.setError(`Akamai: ${block}`); return { rates: [] }; }
        ctx.setStatus("error"); ctx.setError(e?.message ?? "could not fill destination");
        return { rates: [] };
      }

      // 2. Packaging → "Su embalaje" / "Your packaging".
      try {
        const packagingTrigger = ctx.page.locator("[data-e2e-id=packageTypeDropdown], mat-select[aria-label*='embalaje' i], mat-select[aria-label*='packaging' i]").first();
        if (await packagingTrigger.count()) {
          await packagingTrigger.click({ timeout: 5_000 });
          await ctx.page.getByRole("option", { name: /Su embalaje|Your packaging/i }).click({ timeout: 5_000 });
        }
      } catch { /* dropdown may already have the right value */ }

      // 3. Weight by label; dimensions by position inside the Dimensiones group.
      const weightField = ctx.page.getByLabel(/Peso del paquete/i);
      await weightField.waitFor({ state: "visible", timeout: 10_000 });
      await weightField.fill(String(Math.max(args.parcel.real_kg, args.parcel.billable_kg)));
      await fillDimensions(ctx.page, args.parcel.length_cm, args.parcel.width_cm, args.parcel.height_cm);

      // 4. Assert kg / cm units (default, but confirm).
      await assertUnitsMetric(ctx.page);

      // 5. Wait for "Mostrar tarifas" to become enabled.
      const submit = ctx.page.locator("#e2ePackageDetailsSubmitButtonRates");
      await submit.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      try {
        await ctx.page.waitForFunction(
          (sel) => { const b = document.querySelector(sel) as HTMLButtonElement | null; return !!b && !b.disabled; },
          "#e2ePackageDetailsSubmitButtonRates",
          { timeout: 15_000 },
        );
      } catch {
        ctx.setStatus("error"); ctx.setError("formulario inválido (submit nunca se habilitó)");
        return { rates: [] };
      }

      // 6. Start response capture BEFORE clicking.
      const respP = captureResponse(ctx.page, (r: Response) => RATES_API_RE.test(r.url()) && r.request().method() === "POST");
      await submit.click();
      let resp: Response | undefined;
      try { resp = await respP; } catch { resp = undefined; }

      const postBlock = await detectBlock(ctx.page, resp?.status());
      if (postBlock) { ctx.setStatus("blocked"); ctx.setError(postBlock); return { rates: [] }; }

      // 7. Primary extraction: JSON response.
      let parsed: ParsedRate[] = [];
      let method: "network" | "dom" | undefined;
      if (resp && resp.status() < 400) {
        try {
          const json = await resp.json();
          fs.writeFileSync(ctx.evidence.html.replace(/\.html$/, ".json"), JSON.stringify(json, null, 2));
          ctx.setRawHtmlPath(ctx.evidence.html.replace(/\.html$/, ".json"));
          parsed = parseRatesJson(json);
          if (parsed.length) method = "network";
        } catch {}
      }

      // 8. DOM fallback / price mapping.
      let domRows: Array<{ service: string; shown?: number; struck?: number }> = [];
      try {
        await ctx.page.locator(".magr-c-rates, [class*='c-rates']").first().waitFor({ state: "visible", timeout: 10_000 });
        domRows = await parseDomRates(ctx.page);
      } catch { /* no DOM rates */ }

      if (!parsed.length && !domRows.length) {
        ctx.setStatus("no_service"); ctx.setError("no rates found on page or in API");
        return { rates: [] };
      }

      const warnings: string[] = [];
      let ivaFlag: Rate["iva"] = "unspecified";
      try {
        const html = await ctx.page.content();
        ivaFlag = extractIvaFromDom(html);
      } catch {}

      const rates: Rate[] = [];

      if (parsed.length) {
        for (const p of parsed) {
          if (p.prices.length === 0) continue;
          // Price decision: regular = max totalNetCharge, discounted = min.
          // TODO: once we've logged the rateType → price mapping from a real
          // response, hardcode (e.g. LIST=regular, ACCOUNT=discount) and remove
          // this max/min heuristic. Logging rateTypes for later lookup:
          console.log(`[fedex] ${p.service} rate types:`, p.prices.map((x) => `${x.rateType}=${x.totalNetCharge}`).join(", "));
          const regular = p.prices.reduce((a, b) => (b.totalNetCharge > a.totalNetCharge ? b : a));
          const discount = p.prices.reduce((a, b) => (b.totalNetCharge < a.totalNetCharge ? b : a));

          const cls = classifyService(p.service);
          const breakdown: Record<string, number> = {};
          if (regular.totalTaxes != null) breakdown["IVA"] = regular.totalTaxes;

          const rate: Rate = {
            service: p.service,
            price_mxn: Number(regular.totalNetCharge.toFixed(2)),
            iva: ivaFlag === "unspecified" ? "included" : ivaFlag, // FedEx API always includes IVA in totalNetCharge
            speed_rank: cls.speed_rank,
            next_day: cls.next_day,
            breakdown: Object.keys(breakdown).length ? breakdown : undefined,
            delivery_text: p.deliveryText,
          };
          if (discount.totalNetCharge < regular.totalNetCharge) {
            rate.web_discount_price_mxn = Number(discount.totalNetCharge.toFixed(2));
          }
          // If regular == discount and the DOM shows a struck-through price, prefer that for regular.
          const dom = domRows.find((r) => r.service && p.service.toLowerCase().includes(r.service.toLowerCase()));
          if (dom?.struck != null && dom.struck > rate.price_mxn) {
            rate.price_mxn = dom.struck;
          }
          rates.push(rate);
        }
      } else {
        // Pure DOM fallback (no useful JSON): shown price is the main price.
        method = "dom";
        warnings.push("regular_price_not_shown");
        for (const row of domRows) {
          if (row.shown == null) continue;
          const cls = classifyService(row.service);
          rates.push({
            service: row.service,
            price_mxn: Number(row.shown.toFixed(2)),
            iva: ivaFlag,
            speed_rank: cls.speed_rank,
            next_day: cls.next_day,
          });
        }
      }

      if (!rates.length) {
        ctx.setStatus("no_service"); ctx.setError("extracted zero rates from response");
        return { rates: [] };
      }

      ctx.setMethod(method ?? "dom");
      ctx.addWarning("price_is_approximate");
      for (const w of warnings) ctx.addWarning(w);
      if (args.declared_value_mxn) ctx.addWarning("insurance_not_provided");

      // Billed weight sanity: use the first parsed rate's billingWeight.
      const bw = parsed.find((p) => p.billingWeight != null);
      if (bw?.billingWeight != null) {
        const expected = args.parcel.billable_kg;
        const value = /lb/i.test(bw.billingWeightUnit ?? "") ? bw.billingWeight * 0.45359237 : bw.billingWeight;
        const near = Math.abs(value - expected) < 0.05 || Math.abs(value - Math.ceil(expected)) < 0.05;
        if (!near) { ctx.setDoubtful(true); ctx.addWarning("weight_mismatch"); }
        ctx.setSiteEcho({ origin: originEcho, destination: destEcho, billed_weight_kg: Number(value.toFixed(2)) });
      } else {
        ctx.setSiteEcho({ origin: originEcho, destination: destEcho });
      }

      return { rates };
    },
  });
}
