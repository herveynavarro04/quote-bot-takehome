export type Status = "ok" | "blocked" | "timeout" | "no_service" | "invalid_input" | "error";

export interface Rate {
  service: string;
  price_mxn: number;
  iva: "included" | "not_included" | "unspecified";
  speed_rank: number;
  next_day: boolean;
  breakdown?: Record<string, number>;
  // Only set when the site shows a lower price for buying the label online
  // (e.g. FedEx "Descuento por volumen" 20% off). The main `price_mxn` stays
  // the regular, non-discounted total.
  web_discount_price_mxn?: number;
  // Site's own delivery text, e.g. "LLEGA EL jue, nov 12, 10:30"
  delivery_text?: string;
}

export interface Evidence {
  url: string;
  screenshot: string;
  raw_html_path?: string;
  captured_at: string;
}

export interface CarrierResult {
  carrier: string;
  status: Status;
  rates: Rate[];
  error?: string;
  method?: "network" | "dom";
  doubtful?: boolean;
  warnings: string[];
  site_echo?: { origin?: string; destination?: string; billed_weight_kg?: number };
  evidence: Evidence;
  ms: number;
}

export interface NormalizedParcel {
  real_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volumetric_kg: number;
  billable_kg: number;
  quantity: number;
}

export interface NormalizedInput {
  origin_cp?: string;
  origin_city?: string;
  destination_cp?: string;
  destination_city?: string;
  parcels: NormalizedParcel[];
  type: "package" | "envelope";
  priority: "cheapest" | "fastest" | "deadline";
  deadline?: "next_day" | string;
  declared_value_mxn?: number;
  carriers?: string[];
  warnings: string[];
}

export interface CarrierConfig {
  name: string;
  volumetric_divisor: number;
  max_weight_kg: number;
  dim_min_cm: number;
  dim_max_cm: number;
  max_decimals: number;
}

export interface QuoteResult {
  status: "ok" | "needs_input";
  missing?: string[];
  message?: string;
  normalized?: NormalizedInput;
  carriers?: CarrierResult[];
  ranked?: Array<{ carrier: string; service: string; price_mxn: number; iva: string; next_day: boolean; speed_rank: number }>;
  per_parcel?: Array<{ parcel_index: number; carrier: string; service: string; price_mxn: number }>;
  warnings?: string[];
}
