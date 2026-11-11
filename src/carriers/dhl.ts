import fs from "node:fs";
import type { Page, Response } from "playwright";
import type { CarrierResult, NormalizedParcel, Rate } from "./types.js";
import { captureResponse, detectBlock, runAdapter, type AdapterCtx } from "./common.js";
import { CARRIER_CONFIGS, validateForCarrier } from "../quote/normalize.js";

export const DHL_URL = "https://www.dhl.com/mx-es/home/envio/cotizacion-envio.html";
const DHL_QUOTE_API_RE = /\/fragments\/cj-v2\/gaq\/api\/quote/i;

// Save an immediate PNG next to the regular evidence path so a mid-flow bail
// has something to show even if the finally-block screenshot is of a stale /
// about:blank state. Returns the path saved (or empty on failure).
async function snapshot(ctx: AdapterCtx, suffix: string): Promise<string> {
  const base = ctx.evidence.shot.replace(/\.png$/, "");
  const path = `${base}-${suffix}.png`;
  try {
    await ctx.page.screenshot({ path, fullPage: true, timeout: 5_000 });
    return path;
  } catch {
    return "";
  }
}

// Render a self-contained diagnostic HTML into the adapter's context and
// screenshot it. Needed when the real DHL goto failed at the network layer —
// in that state, page.screenshot() silently produces nothing and setContent()
// on the broken page can also throw because its execution context is dead.
// Strategy A: reset the existing page to about:blank (a fresh document), then
// setContent + screenshot. Strategy B: open a brand-new page in the same
// context (bypasses the broken one entirely). Whichever wins is recorded in
// debug.evidence_strategy, and ctx.markEvidenceSaved() tells runAdapter not
// to overwrite the file with its own trailing screenshot.
async function renderBlockEvidence(ctx: AdapterCtx, title: string, detail: string): Promise<void> {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>DHL — evidencia de bloqueo</title>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0; padding: 32px; background: #fafafa; }
  .card { max-width: 820px; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px 28px; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  h1 { color: #d40511; margin: 0 0 6px; font-size: 22px; }
  .sub { color: #6b6b6b; font-size: 13px; margin-bottom: 20px; word-break: break-all; }
  pre { background: #f6f7f9; border: 1px solid #e4e4e7; border-radius: 8px; padding: 14px; white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #333; overflow-x: hidden; }
  .note { margin-top: 18px; color: #4a4a4a; font-size: 13px; line-height: 1.55; }
  .label { font-weight: 600; color: #333; letter-spacing: .02em; text-transform: uppercase; font-size: 11px; margin: 16px 0 6px; }
</style>
</head><body>
  <div class="card">
    <h1>DHL — ${escapeHtml(title)}</h1>
    <div class="sub">${escapeHtml(new Date().toISOString())}</div>
    <div class="label">Detalle técnico</div>
    <pre>${escapeHtml(detail)}</pre>
    <div class="note">
      El adaptador generó esta captura cuando la navegación a <code>www.dhl.com</code> falló a nivel de red
      desde Chromium headless. Estafeta carga sin problema desde el mismo navegador, por lo que el fallo no
      es un problema de red local: lo clasificamos como bloqueo por detección de bot.
      Un navegador real en la misma máquina sí carga el sitio.
    </div>
  </div>
</body></html>`;

  const path = ctx.evidence.shot;

  // Strategy A: force a clean document in the existing page, then write/shoot.
  try {
    await ctx.page.goto("about:blank", { timeout: 4_000 });
    await ctx.page.setContent(html, { waitUntil: "domcontentloaded", timeout: 4_000 });
    await ctx.page.screenshot({ path, fullPage: true, timeout: 5_000 });
    ctx.setDebug("evidence_strategy", "reset_existing_page");
    ctx.markEvidenceSaved();
    return;
  } catch (e: any) {
    ctx.setDebug("evidence_strategy_a_error", String(e?.message ?? e).split("\n")[0]);
  }

  // Strategy B: open a brand-new page in the same context. Reliable when the
  // original page's frame is beyond repair.
  try {
    const fresh = await ctx.context.newPage();
    await fresh.setContent(html, { waitUntil: "domcontentloaded", timeout: 4_000 });
    await fresh.screenshot({ path, fullPage: true, timeout: 5_000 });
    await fresh.close().catch(() => {});
    ctx.setDebug("evidence_strategy", "new_page_in_context");
    ctx.markEvidenceSaved();
    return;
  } catch (e: any) {
    ctx.setDebug("evidence_strategy_b_error", String(e?.message ?? e).split("\n")[0]);
  }

  // If both strategies fail, leave markEvidenceSaved off — the runAdapter's
  // finally will at least try its own screenshot. Nothing more we can do here
  // without bundling a PNG encoder.
  ctx.setDebug("evidence_strategy", "none");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Decide whether a failure is Akamai-driven (set status=blocked) or a real
// error. Runs a body-level detectBlock and also records whatever we saw in
// the DOM for the trace.
async function classifyFailure(ctx: AdapterCtx, defaultError: string, where: string): Promise<void> {
  const shot = await snapshot(ctx, where);
  if (shot) ctx.setDebug(`screenshot_${where}`, shot);

  // 1. Mid-flow HTTP block (401/403/429 on any response so far).
  const netBlock = ctx.blockSeen();
  if (netBlock) {
    ctx.setStatus("blocked");
    ctx.setError(`Akamai bloqueó a DHL (${where}): ${netBlock}`);
    return;
  }
  // 2. Body-level block page (200-but-forbidden Akamai/incident pages).
  const bodyBlock = await detectBlock(ctx.page).catch(() => null);
  if (bodyBlock) {
    ctx.setStatus("blocked");
    ctx.setError(`Akamai bloqueó a DHL (${where}): ${bodyBlock}`);
    return;
  }
  // 3. No block signal — real error.
  ctx.setStatus("error");
  ctx.setError(defaultError);
}

export interface DhlArgs {
  origin_cp: string;
  destination_cp: string;
  parcel: NormalizedParcel;
  type: "package" | "envelope";
  declared_value_mxn?: number;
}

// Three offer cards = one product, three handover methods. Labels per spec.
function labelForHandover(kind: "dropoff" | "online" | "phone"): string {
  if (kind === "dropoff") return "DHL Express – entregando en punto DHL";
  if (kind === "online") return "DHL Express – recolección agendada en línea";
  return "DHL Express – recolección por teléfono";
}

async function dismissCookies(page: Page): Promise<void> {
  // Prefer "necessary only"; accept-all is fine too. Silent if no banner.
  const names = [/Solo absolutamente necesario/i, /strictly necessary only/i, /Rechazar/i, /Aceptar todo/i, /Accept all/i];
  for (const name of names) {
    try {
      const btn = page.getByRole("button", { name }).first();
      await btn.waitFor({ state: "visible", timeout: 1_500 });
      await btn.click({ timeout: 2_000 });
      return;
    } catch { /* try next */ }
  }
}

// Open the quote wizard. The landing page needs two interactions before
// any form field is present: an "Envío" drawer and an "Obtenga una cotización" link.
async function openQuoteForm(page: Page): Promise<void> {
  try {
    const envio = page.getByRole("button", { name: /^Env[ií]o/ }).first();
    await envio.waitFor({ state: "visible", timeout: 8_000 });
    await envio.click();
  } catch { /* already open, or layout changed */ }
  try {
    const link = page.getByRole("link", { name: /Obtenga una cotizaci[oó]n/i }).first();
    await link.waitFor({ state: "visible", timeout: 8_000 });
    await link.click();
  } catch { /* already on the form */ }
}

async function selectCountryMexico(page: Page, groupName: "De" | "Para"): Promise<void> {
  const group = page.getByRole("group", { name: groupName, exact: groupName === "De" });
  const countryCombo = group.getByRole("combobox", { name: /Pa[ií]s o territorio/i });
  const current = (await countryCombo.inputValue().catch(() => "")) || "";
  if (/m[eé]xico|mexico/i.test(current)) return;
  await countryCombo.click();
  await countryCombo.fill("mex");
  // Pick the first Mexico option in the open listbox.
  const option = page.getByRole("option", { name: /M[eé]xico \/ Mexico|^M[eé]xico$/i }).first();
  try {
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
  } catch {
    // Codegen's fallback: generic text match
    await page.getByText(/M[eé]xico \/ Mexico/).first().click({ timeout: 3_000 });
  }
}

interface PickResult { picked: string; suggestions: string[]; listboxVisible: boolean }

async function fillCpAndPick(
  page: Page,
  side: "origin" | "destination",
  cp: string,
): Promise<PickResult> {
  // DHL labels the From side as "De" (exact) and the To side as "Para".
  const groupName = side === "origin" ? "De" : "Para";
  const group = page.getByRole("group", { name: groupName, exact: groupName === "De" });
  const cpCombo = group.getByRole("combobox", { name: /C[oó]digo postal/i });

  await cpCombo.scrollIntoViewIfNeeded();
  await cpCombo.click();
  await cpCombo.fill("");
  await cpCombo.pressSequentially(cp, { delay: 20 });

  // Dropdown entries use data-testid like
  //   originDestinationStep-autocomplete-<side>.postalCode-dropdown-<index>
  const dropdownRe = new RegExp(`originDestinationStep-autocomplete-${side}\\.postalCode-dropdown-\\d+`);
  const dropdown = page.locator(`[data-testid^="originDestinationStep-autocomplete-${side}.postalCode-dropdown-"]`);

  let listboxVisible = false;
  try {
    await dropdown.first().waitFor({ state: "visible", timeout: 7_000 });
    listboxVisible = true;
  } catch { /* no suggestions */ }

  const suggestions: string[] = [];
  let match = -1;
  if (listboxVisible) {
    const count = await dropdown.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const text = ((await dropdown.nth(i).textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ");
      if (!text) continue;
      suggestions.push(text);
      if (match === -1 && text.includes(cp)) match = i;
    }
  }
  if (match === -1) return { picked: "", suggestions, listboxVisible };
  await dropdown.nth(match).click();
  // small settle delay so Angular state updates
  await page.waitForTimeout(200);
  const picked = (await cpCombo.inputValue().catch(() => "")) || suggestions[match];
  return { picked, suggestions, listboxVisible };
}

interface ParsedOffer {
  raw: any;
  service: string;
  price_without_iva?: number;
  iva_amount?: number;
  total: number;
  iva: Rate["iva"];
  delivery_text?: string;
  next_day: boolean;
  billed_weight_kg?: number;
  handover_kind: "dropoff" | "online" | "phone" | "unknown";
}

function toNumber(v: any): number | undefined {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseChargeableWeight(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const m = url.match(/CHARGEABLE_WEIGHT=([\d.]+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

const DROPOFF_KEYS = ["DROPOFF", "DROP_OFF", "COUNTER", "DHL_POINT", "SERVICE_POINT", "DROP", "PUNTO"];
const ONLINE_KEYS = ["SCHEDULED_PICKUP", "ONLINE_PICKUP", "ONLINE", "SCHEDULED", "AGENDADA"];
const PHONE_KEYS = ["PHONE_PICKUP", "PHONE", "CALL", "TELEPHONE", "TELEFONO"];

function detectHandoverKind(offer: any): "dropoff" | "online" | "phone" | "unknown" {
  const haystack = JSON.stringify(offer ?? {}).toUpperCase();
  for (const k of DROPOFF_KEYS) if (haystack.includes(k)) return "dropoff";
  for (const k of PHONE_KEYS) if (haystack.includes(k)) return "phone";
  for (const k of ONLINE_KEYS) if (haystack.includes(k)) return "online";
  return "unknown";
}

function parseOffers(json: any): ParsedOffer[] {
  const offers: any[] = json?.offers ?? json?.data?.offers ?? [];
  const parsed: ParsedOffer[] = [];
  for (const o of offers) {
    const priceAmt = toNumber(o?.price?.amount ?? o?.price?.value ?? o?.price);
    const taxAmt = toNumber(o?.billingTaxAmount ?? o?.tax?.amount ?? o?.taxAmount);
    if (priceAmt == null) continue;
    const total = priceAmt + (taxAmt ?? 0);
    const deliveryText: string | undefined = o?.estimatedDeliveryTime ?? o?.deliveryDate ?? o?.commit?.label;
    const bookingHref: string | undefined = o?.bookingLink ?? o?.bookNowUrl ?? o?.ctaUrl;
    const billed = parseChargeableWeight(bookingHref) ?? toNumber(o?.chargeableWeight ?? o?.billingWeight?.value);
    const kind = detectHandoverKind(o);
    parsed.push({
      raw: o,
      service: labelForHandover(kind === "unknown" ? "dropoff" : kind),
      price_without_iva: priceAmt,
      iva_amount: taxAmt,
      total,
      iva: taxAmt != null ? "included" : "not_included",
      delivery_text: deliveryText,
      next_day: /mañana|tomorrow|next business|d[ií]a siguiente/i.test(deliveryText ?? "") || true,
      billed_weight_kg: billed,
      handover_kind: kind,
    });
  }
  // Fallback label-by-price when we can't tell handover from fields.
  const unknowns = parsed.filter((p) => p.handover_kind === "unknown");
  if (unknowns.length === parsed.length && parsed.length >= 2) {
    const sorted = [...parsed].sort((a, b) => a.total - b.total);
    const labels: Array<"dropoff" | "online" | "phone"> = ["dropoff", "online", "phone"];
    sorted.forEach((p, i) => {
      const kind = labels[Math.min(i, labels.length - 1)];
      p.handover_kind = kind;
      p.service = labelForHandover(kind);
    });
  }
  return parsed;
}

// DOM fallback: scrape the offer cards. Cost text looks like "MXN 2,527.33*",
// delivery text "Entrega estimada: jue, 12 de nov de ...".
async function parseDomOffers(page: Page): Promise<ParsedOffer[]> {
  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='offer-card-']"));
    const results: Array<Omit<any, never>> = [];
    for (const card of cards) {
      const text = card.innerText;
      const priceMatch = text.match(/MXN\s*([\d,]+(?:\.\d+)?)/i);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : NaN;
      const deliveryMatch = text.match(/Entrega estimada:\s*([^\n]+)/i);
      const delivery = deliveryMatch ? deliveryMatch[1].trim() : undefined;
      const handoverMatch = text.match(/Entrega en un punto|recolecci[oó]n agendada|recolecci[oó]n por tel[eé]fono/i);
      let handover = "unknown";
      if (handoverMatch) {
        const h = handoverMatch[0].toLowerCase();
        if (/punto/.test(h)) handover = "dropoff";
        else if (/agendada/.test(h)) handover = "online";
        else if (/tel[eé]fono/.test(h)) handover = "phone";
      }
      if (Number.isFinite(price)) {
        results.push({ price, delivery, handover, id: card.getAttribute("data-testid") });
      }
    }
    return results;
  }).then((rows: any[]) => rows.map((r) => ({
    raw: r,
    service: labelForHandover(r.handover === "unknown" ? "dropoff" : r.handover),
    price_without_iva: undefined,
    iva_amount: undefined,
    total: r.price,
    iva: "not_included" as const,
    delivery_text: r.delivery,
    next_day: true,
    billed_weight_kg: undefined,
    handover_kind: r.handover,
  })));
}

export async function quoteDhl(args: DhlArgs): Promise<CarrierResult> {
  const cfg = CARRIER_CONFIGS.dhl;
  if (args.type === "envelope") {
    return {
      carrier: "dhl", status: "error", rates: [], error: "envelope not supported in adapter yet",
      warnings: [], evidence: { url: DHL_URL, screenshot: "", captured_at: new Date().toISOString() }, ms: 0,
    };
  }
  const limitErr = validateForCarrier(args.parcel, cfg);
  if (limitErr) {
    return {
      carrier: "dhl", status: "invalid_input", rates: [], error: limitErr,
      warnings: [], evidence: { url: DHL_URL, screenshot: "", captured_at: new Date().toISOString() }, ms: 0,
    };
  }

  return runAdapter({
    carrier: "dhl",
    // DHL on HTTP/1.1 (we disabled H2 globally for the shared browser) loads
    // notably slower than Estafeta or FedEx. Give it a longer budget.
    timeoutMs: 60_000,
    url: DHL_URL,
    run: async (ctx) => {
      // "commit" returns as soon as the response is committed to the network
      // stack — much faster than waiting for DOMContentLoaded on a long page
      // behind Akamai. A real browser loads this URL in ~2 s. If the first
      // attempt doesn't commit in 20 s, retries won't help — it's bot-block
      // at the network layer.
      let nav: Awaited<ReturnType<typeof ctx.page.goto>> | undefined;
      // Network/stall patterns indicating the CDN is refusing our connection.
      // Covers both raw Chromium codes AND Playwright-wrapped "Timeout Nms exceeded"
      // messages. From the same browser Estafeta loads fine; DHL alone failing
      // means Akamai is refusing the handshake, not a routing outage.
      const NETWORK_BLOCK_RE = /Timeout\s+\d+ms\s+exceeded|ERR_TIMED_OUT|ERR_ABORTED|ERR_CONNECTION_(?:RESET|REFUSED|CLOSED|ABORTED)|ERR_SSL_|ERR_HTTP2_PROTOCOL_ERROR|ERR_FAILED|frame was detached/i;
      try {
        nav = await ctx.page.goto(DHL_URL, { waitUntil: "commit", timeout: 20_000 });
      } catch (e: any) {
        const err1 = String(e?.message ?? e).split("\n")[0];
        ctx.setDebug("goto_first_error", err1);
        if (NETWORK_BLOCK_RE.test(err1)) {
          ctx.setStatus("blocked");
          const msg = `DHL rechazó la conexión desde Chromium headless (${err1}) — bloqueo a nivel de red por bot detection`;
          ctx.setError(msg);
          // page.screenshot() on a page with no committed document saves nothing.
          // Render a synthetic diagnostic HTML into this context and screenshot it
          // so the UI's evidence link has a real image to serve.
          await renderBlockEvidence(ctx, "Bloqueo por detección de bot", msg);
          return { rates: [] };
        }
        // Any other error reaches the generic classifier (body-level Akamai
        // check + mid-flow 403 check + screenshot).
        await classifyFailure(ctx, `DHL no abrió la página: ${err1}`, "goto");
        return { rates: [] };
      }
      // Soft wait — any failure here is fine, we'll still check for the form below.
      try { await ctx.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }); } catch {}

      const preBlock = await detectBlock(ctx.page, nav?.status());
      if (preBlock) { ctx.setStatus("blocked"); ctx.setError(preBlock); return { rates: [] }; }

      await dismissCookies(ctx.page);
      await openQuoteForm(ctx.page);

      // Business segment (default on MX page, defensive check).
      try {
        await ctx.page.getByTestId("originDestinationStep-radio-segment-business").check({ timeout: 3_000 });
      } catch { /* already set */ }

      // Origin side ("De") defaults to México — do NOT touch the country combobox
      // (doing so re-opens the picker and sometimes resets the whole step).
      // Just fill the origin CP.
      const origin = await fillCpAndPick(ctx.page, "origin", args.origin_cp);
      ctx.setDebug("origin_suggestions", origin.suggestions);
      if (!origin.picked) {
        if (!origin.listboxVisible || origin.suggestions.length === 0) {
          await classifyFailure(ctx, "DHL no abrió el autocompletado del código postal de origen", "origin_dropdown");
          return { rates: [] };
        }
        ctx.setStatus("invalid_input"); ctx.setError(`DHL no reconoció el código postal ${args.origin_cp}`);
        return { rates: [] };
      }

      // Destination side ("Para"): set country to México first (it defaults to the
      // US on this page), then fill the CP.
      try { await selectCountryMexico(ctx.page, "Para"); } catch { /* default already */ }
      const dest = await fillCpAndPick(ctx.page, "destination", args.destination_cp);
      ctx.setDebug("destination_suggestions", dest.suggestions);
      if (!dest.picked) {
        if (!dest.listboxVisible || dest.suggestions.length === 0) {
          await classifyFailure(ctx, "DHL no abrió el autocompletado del código postal de destino", "destination_dropdown");
          return { rates: [] };
        }
        ctx.setStatus("invalid_input"); ctx.setError(`DHL no reconoció el código postal ${args.destination_cp}`);
        return { rates: [] };
      }

      // Open the package step. Codegen shows two clicks: first one sometimes
      // just closes a lingering dropdown, second actually advances. Clicking
      // the main content first dismisses any open popover.
      try { await ctx.page.locator("#wcag-main-content").click({ timeout: 2_000 }); } catch {}
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const next = ctx.page.getByRole("button", { name: /Describe tu env[ií]o|Describa su embarque/i }).first();
          await next.scrollIntoViewIfNeeded();
          await next.click({ timeout: 6_000 });
        } catch { /* might already be advanced */ }
      }

      // Package type. The radio input is hidden; the real click target is the
      // "Paquetes" label (codegen does label.click first, then check(testid)).
      try {
        await ctx.page.locator("label").filter({ hasText: /^Paquetes?$/i }).first().click({ timeout: 4_000 });
      } catch { /* label might not exist; fall through to the radio */ }
      try {
        await ctx.page.getByTestId("packageStep-radio-packageType-package").check({ timeout: 3_000, force: true });
      } catch { /* already selected or unavailable */ }

      // Weight + dimensions by role/label (never the generated #weight-0 ids).
      const toFixed = (n: number) => Number(n.toFixed(2)).toString();
      const weight = ctx.page.getByRole("textbox", { name: /^Peso/i }).first();
      await weight.scrollIntoViewIfNeeded();
      await weight.fill(toFixed(Math.max(args.parcel.real_kg, args.parcel.billable_kg)));
      await ctx.page.getByRole("textbox", { name: /^Largo/i }).first().fill(toFixed(args.parcel.length_cm));
      await ctx.page.getByRole("textbox", { name: /^Ancho/i }).first().fill(toFixed(args.parcel.width_cm));
      await ctx.page.getByRole("textbox", { name: /^Altura/i }).first().fill(toFixed(args.parcel.height_cm));

      // Read back — DHL sometimes swaps size presets on weight change.
      const readBack = {
        weight: await weight.inputValue().catch(() => ""),
        length: await ctx.page.getByRole("textbox", { name: /^Largo/i }).first().inputValue().catch(() => ""),
        width: await ctx.page.getByRole("textbox", { name: /^Ancho/i }).first().inputValue().catch(() => ""),
        height: await ctx.page.getByRole("textbox", { name: /^Altura/i }).first().inputValue().catch(() => ""),
      };
      ctx.setDebug("dhl_readback", readBack);

      // Give the form a beat to re-validate after the last field was filled;
      // DHL's validator debounces, and clicking too fast finds the button still
      // disabled. Then wait explicitly for the submit button to become enabled.
      await ctx.page.waitForTimeout(500);
      const submit = ctx.page.getByRole("button", { name: /Obtener una cotizaci[oó]n/i }).first();
      await submit.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await submit.waitFor({ state: "visible", timeout: 10_000 });
        // Poll the disabled attribute until it clears. Covers both <button disabled>
        // and aria-disabled / DHL's class-based disabled variants.
        await ctx.page.waitForFunction(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const b = btns.find((x) => /Obtener una cotizaci[oó]n/i.test(x.innerText || ""));
          if (!b) return false;
          const disabledAttr = b.hasAttribute("disabled");
          const ariaDisabled = b.getAttribute("aria-disabled") === "true";
          return !disabledAttr && !ariaDisabled;
        }, undefined, { timeout: 20_000 });
      } catch (e: any) {
        await classifyFailure(
          ctx,
          `DHL: 'Obtener una cotización' nunca se habilitó (formulario inválido). ${String(e?.message ?? e).split("\n")[0]}`,
          "submit_disabled",
        );
        return { rates: [] };
      }

      // Arm response capture BEFORE clicking so we don't race the GET.
      const respP = captureResponse(ctx.page, (r: Response) => DHL_QUOTE_API_RE.test(r.url()) && r.request().method() === "GET");
      try {
        await submit.click({ timeout: 10_000 });
      } catch (e: any) {
        await classifyFailure(ctx, e?.message ?? "could not click 'Obtener una cotización'", "submit_click");
        return { rates: [] };
      }

      let resp: Response | undefined;
      try { resp = await respP; } catch { resp = undefined; }

      const postBlock = await detectBlock(ctx.page, resp?.status());
      if (postBlock) { ctx.setStatus("blocked"); ctx.setError(postBlock); return { rates: [] }; }

      // Wait for a result card to appear before we scrape.
      try {
        await ctx.page.locator("[data-testid='offer-card-0']").waitFor({ state: "visible", timeout: 15_000 });
      } catch { /* API may have failed; parseOffers will decide */ }

      let parsed: ParsedOffer[] = [];
      let method: "network" | "dom" | undefined;
      if (resp && resp.status() < 400) {
        try {
          const json = await resp.json();
          const jsonPath = ctx.evidence.html.replace(/\.html$/, ".json");
          fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
          ctx.setRawHtmlPath(jsonPath);
          ctx.setDebug("dhl_api_url", resp.url());
          parsed = parseOffers(json);
          if (parsed.length) method = "network";
        } catch {}
      }

      if (!parsed.length) {
        try {
          parsed = await parseDomOffers(ctx.page);
          if (parsed.length) method = "dom";
        } catch {}
      }

      if (!parsed.length) {
        // By this point the whole form worked; empty offers is a real
        // "no service" for the route, not a bot block.
        ctx.setStatus("no_service"); ctx.setError("no offers found in API or DOM");
        return { rates: [] };
      }

      const rates: Rate[] = parsed.map((p) => {
        const breakdown: Record<string, number> = {};
        if (p.price_without_iva != null) breakdown["Precio sin IVA"] = Number(p.price_without_iva.toFixed(2));
        if (p.iva_amount != null) breakdown["IVA"] = Number(p.iva_amount.toFixed(2));
        return {
          service: p.service,
          price_mxn: Number(p.total.toFixed(2)),
          iva: p.iva,
          speed_rank: 1,
          next_day: p.next_day,
          breakdown: Object.keys(breakdown).length ? breakdown : undefined,
          delivery_text: p.delivery_text,
        };
      });

      ctx.setMethod(method ?? "dom");
      ctx.addWarning("price_is_approximate");
      if (parsed.some((p) => p.iva_amount == null)) ctx.addWarning("iva_unspecified");
      if (args.declared_value_mxn) ctx.addWarning("insurance_not_provided");

      const billed = parsed.find((p) => p.billed_weight_kg != null)?.billed_weight_kg;
      if (billed != null) {
        const expected = args.parcel.billable_kg;
        const near = Math.abs(billed - expected) < 0.05 || Math.abs(billed - Math.ceil(expected)) < 0.05;
        if (!near) { ctx.setDoubtful(true); ctx.addWarning("weight_mismatch"); }
        ctx.setSiteEcho({ origin: origin.picked, destination: dest.picked, billed_weight_kg: Number(billed.toFixed(2)) });
      } else {
        ctx.setSiteEcho({ origin: origin.picked, destination: dest.picked });
      }

      return { rates };
    },
  });
}
