import type { CarrierResult, NormalizedInput, NormalizedParcel, QuoteResult, Rate } from "../carriers/types.js";
import { QuoteShipmentInput, type QuoteShipmentInputT } from "./schema.js";
import { CARRIER_CONFIGS, findMissing, normalizeInput } from "./normalize.js";
import { rank } from "./rank.js";
import { quoteEstafeta } from "../carriers/estafeta.js";

export interface QuoteRunOptions {
  presetsResolver?: (city: string) => string | undefined; // hook for future preset CPs
}

// Registry — add adapters here. "fastest" / order doesn't matter: they run in parallel.
const ADAPTERS: Record<string, (input: NormalizedInput, parcel: NormalizedParcel) => Promise<CarrierResult>> = {
  estafeta: (input, parcel) => quoteEstafeta({
    origin_cp: input.origin_cp!,
    destination_cp: input.destination_cp!,
    parcel,
    type: input.type,
    declared_value_mxn: input.declared_value_mxn,
  }),
};

function implementedCarriers(): string[] {
  return Object.keys(ADAPTERS);
}

function notImplementedResult(name: string): CarrierResult {
  return {
    carrier: name,
    status: "error",
    rates: [],
    error: "carrier not implemented yet",
    warnings: ["carrier_not_quoted"],
    evidence: { url: "", screenshot: "", captured_at: new Date().toISOString() },
    ms: 0,
  };
}

// Aggregate per-parcel results into one line per service.
// A service counts only if every parcel line has a rate for it.
function aggregateForCarrier(name: string, perParcel: CarrierResult[], parcels: NormalizedParcel[]): CarrierResult {
  const nonOk = perParcel.find((r) => r.status !== "ok");
  if (nonOk) {
    return {
      ...nonOk,
      carrier: name,
      rates: [],
    };
  }

  // find service intersection
  const sets = perParcel.map((p) => new Set(p.rates.map((r) => r.service)));
  const intersect = [...sets[0]].filter((s) => sets.every((set) => set.has(s)));

  const merged: Rate[] = intersect.map((service) => {
    let total = 0;
    let totalDiscount: number | undefined;
    let speed = 0;
    let next_day = false;
    let iva: Rate["iva"] = "included";
    let delivery_text: string | undefined;
    for (let i = 0; i < perParcel.length; i++) {
      const r = perParcel[i].rates.find((x) => x.service === service)!;
      const q = parcels[i].quantity ?? 1;
      total += r.price_mxn * q;
      if (r.web_discount_price_mxn != null) {
        totalDiscount = (totalDiscount ?? 0) + r.web_discount_price_mxn * q;
      }
      speed = r.speed_rank;
      next_day = r.next_day;
      if (r.iva !== "included") iva = r.iva;
      delivery_text = delivery_text ?? r.delivery_text;
    }
    return {
      service,
      price_mxn: Number(total.toFixed(2)),
      iva,
      speed_rank: speed,
      next_day,
      web_discount_price_mxn: totalDiscount != null ? Number(totalDiscount.toFixed(2)) : undefined,
      delivery_text,
    };
  });

  // Merge warnings/evidence from first non-empty
  const first = perParcel[0];
  const warnings = Array.from(new Set(perParcel.flatMap((p) => p.warnings)));
  return {
    carrier: name,
    status: "ok",
    rates: merged,
    method: first.method,
    doubtful: perParcel.some((p) => p.doubtful) || undefined,
    warnings,
    site_echo: first.site_echo,
    evidence: first.evidence,
    ms: perParcel.reduce((a, p) => a + p.ms, 0),
  };
}

export async function quoteShipment(raw: unknown, _options: QuoteRunOptions = {}): Promise<QuoteResult> {
  // Validate shape
  const parsed = QuoteShipmentInput.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "needs_input",
      missing: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      message: "The input did not match the expected schema. Please re-ask for the listed fields.",
    };
  }
  const input: QuoteShipmentInputT = parsed.data;

  // Missing-fields check
  const missing = findMissing(input);
  if (missing.length > 0) {
    return {
      status: "needs_input",
      missing,
      message: "Missing data to quote. Ask the user for every item in `missing` at once.",
    };
  }

  // Pick carriers
  const requested = input.carriers && input.carriers.length > 0
    ? input.carriers.map((c) => c.toLowerCase())
    : implementedCarriers();

  // Use estafeta's divisor as the "display" divisor for normalization output.
  // Each adapter re-normalizes per its own carrier config inside its call if needed.
  const divisor = CARRIER_CONFIGS.estafeta.volumetric_divisor;
  const normalized = normalizeInput(input, divisor);

  // Run carriers in parallel.
  const settled = await Promise.allSettled(requested.map(async (name) => {
    const adapter = ADAPTERS[name];
    if (!adapter) return notImplementedResult(name);

    // Quote per unique parcel type. Identical parcels (quantity > 1) → one call.
    const perParcel: CarrierResult[] = [];
    for (const parcel of normalized.parcels) {
      try {
        const r = await adapter(normalized, parcel);
        perParcel.push(r);
      } catch (e: any) {
        perParcel.push({
          carrier: name,
          status: "error",
          rates: [],
          error: e?.message ?? String(e),
          warnings: [],
          evidence: { url: "", screenshot: "", captured_at: new Date().toISOString() },
          ms: 0,
        });
      }
    }
    return aggregateForCarrier(name, perParcel, normalized.parcels);
  }));

  const carriers: CarrierResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return {
      carrier: requested[i],
      status: "error",
      rates: [],
      error: s.reason?.message ?? String(s.reason),
      warnings: [],
      evidence: { url: "", screenshot: "", captured_at: new Date().toISOString() },
      ms: 0,
    };
  });

  const { ranked, warnings: rankWarnings } = rank(carriers, normalized);
  const warnings = Array.from(new Set([
    ...normalized.warnings,
    ...carriers.flatMap((c) => c.warnings),
    ...rankWarnings,
  ]));

  return {
    status: "ok",
    normalized,
    carriers,
    ranked,
    warnings,
  };
}
