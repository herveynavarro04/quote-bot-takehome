import type { CarrierConfig, NormalizedInput, NormalizedParcel } from "../carriers/types.js";
import type { ParcelT, QuoteShipmentInputT } from "./schema.js";

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;

export const CARRIER_CONFIGS: Record<string, CarrierConfig> = {
  estafeta: { name: "estafeta", volumetric_divisor: 5000, max_weight_kg: 70, dim_min_cm: 1, dim_max_cm: 1000, max_decimals: 3 },
  // FedEx: dimDivisor 139 in³/lb == 5000 cm³/kg (verified against the rates page).
  fedex:    { name: "fedex",    volumetric_divisor: 5000, max_weight_kg: 68, dim_min_cm: 1, dim_max_cm: 302,  max_decimals: 2 },
  // DHL Express: divisor NOT stated by the MX cotizador. Using the industry
  // 5000 cm³/kg as a placeholder — the billed_weight check (CHARGEABLE_WEIGHT
  // in the booking link) is what we actually trust. UNVERIFIED.
  dhl:      { name: "dhl",      volumetric_divisor: 5000, max_weight_kg: 70, dim_min_cm: 1, dim_max_cm: 300,  max_decimals: 2 },
};

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function toKg(weight: number, unit: "kg" | "lb"): number {
  return unit === "kg" ? weight : weight * LB_TO_KG;
}

function toCm(d: number, unit: "cm" | "in"): number {
  return unit === "cm" ? d : d * IN_TO_CM;
}

export function normalizeParcel(p: ParcelT, divisor: number): NormalizedParcel {
  const real_kg = round(toKg(p.weight, p.weight_unit), 3);
  const length_cm = round(toCm(p.length, p.dim_unit), 3);
  const width_cm = round(toCm(p.width, p.dim_unit), 3);
  const height_cm = round(toCm(p.height, p.dim_unit), 3);
  const volumetric_kg = round((length_cm * width_cm * height_cm) / divisor, 3);
  const billable_kg = round(Math.max(real_kg, volumetric_kg), 3);
  return { real_kg, length_cm, width_cm, height_cm, volumetric_kg, billable_kg, quantity: p.quantity ?? 1 };
}

export function isValidCp(cp: string | undefined): boolean {
  return typeof cp === "string" && /^\d{5}$/.test(cp);
}

// Returns the list of missing fields; callers turn it into a needs_input result.
export function findMissing(input: QuoteShipmentInputT): string[] {
  const missing: string[] = [];
  if (!input.origin_cp) {
    if (input.origin_city) missing.push("origin_cp (user gave a city, not a CP)");
    else missing.push("origin_cp");
  } else if (!isValidCp(input.origin_cp)) {
    missing.push(`origin_cp (not a 5-digit code: '${input.origin_cp}')`);
  }
  if (!input.destination_cp) {
    if (input.destination_city) missing.push("destination_cp (user gave a city, not a CP)");
    else missing.push("destination_cp");
  } else if (!isValidCp(input.destination_cp)) {
    missing.push(`destination_cp (not a 5-digit code: '${input.destination_cp}')`);
  }
  if (!input.parcels || input.parcels.length === 0) {
    missing.push("parcels");
  } else if (input.type === "package") {
    input.parcels.forEach((p, i) => {
      if (!p.weight) missing.push(`parcels[${i}].weight`);
      if (!p.length) missing.push(`parcels[${i}].length`);
      if (!p.width) missing.push(`parcels[${i}].width`);
      if (!p.height) missing.push(`parcels[${i}].height`);
    });
  } else {
    input.parcels.forEach((p, i) => {
      if (!p.weight) missing.push(`parcels[${i}].weight`);
    });
  }
  return missing;
}

export function normalizeInput(input: QuoteShipmentInputT, divisor: number): NormalizedInput {
  const warnings: string[] = [];
  const parcels = input.parcels.map((p) => normalizeParcel(p, divisor));

  // Suspicious CPs (format ok but obviously placeholder-like)
  for (const cp of [input.origin_cp, input.destination_cp]) {
    if (cp && /^(99999|00000|12345)$/.test(cp)) warnings.push("suspicious_postal_code");
  }
  if (input.declared_value_mxn) warnings.push("insurance_not_provided");

  return {
    origin_cp: input.origin_cp,
    origin_city: input.origin_city,
    destination_cp: input.destination_cp,
    destination_city: input.destination_city,
    parcels,
    type: input.type,
    priority: input.priority ?? "cheapest",
    deadline: input.deadline,
    declared_value_mxn: input.declared_value_mxn,
    carriers: input.carriers,
    warnings,
  };
}

// Returns an error message if the parcel violates a carrier's site limits; null if ok.
export function validateForCarrier(p: NormalizedParcel, cfg: CarrierConfig): string | null {
  if (p.real_kg > cfg.max_weight_kg) return `over ${cfg.max_weight_kg} kg per parcel: ${cfg.name}'s site doesn't quote it`;
  for (const d of [p.length_cm, p.width_cm, p.height_cm]) {
    if (d < cfg.dim_min_cm || d > cfg.dim_max_cm) return `dimension ${d} cm outside ${cfg.name}'s accepted range (${cfg.dim_min_cm}-${cfg.dim_max_cm} cm)`;
  }
  return null;
}
