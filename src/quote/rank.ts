import type { CarrierResult, NormalizedInput } from "../carriers/types.js";

export interface RankedRate {
  carrier: string;
  service: string;
  price_mxn: number;
  iva: string;
  next_day: boolean;
  speed_rank: number;
  web_discount_price_mxn?: number;
  delivery_text?: string;
}

export interface RankingOutput {
  ranked: RankedRate[];
  warnings: string[];
}

export function rank(carriers: CarrierResult[], input: NormalizedInput): RankingOutput {
  const warnings: string[] = [];
  const flat: RankedRate[] = [];
  for (const c of carriers) {
    if (c.status !== "ok") continue;
    for (const r of c.rates) {
      flat.push({
        carrier: c.carrier,
        service: r.service,
        price_mxn: r.price_mxn,
        iva: r.iva,
        next_day: r.next_day,
        speed_rank: r.speed_rank,
        web_discount_price_mxn: r.web_discount_price_mxn,
        delivery_text: r.delivery_text,
      });
    }
  }

  let filtered = flat;
  if (input.priority === "deadline" && input.deadline === "next_day") {
    filtered = flat.filter((r) => r.next_day);
    if (filtered.length === 0) warnings.push("no_service_meets_deadline");
  }

  const ranked = [...filtered].sort((a, b) => {
    if (input.priority === "fastest") {
      if (a.speed_rank !== b.speed_rank) return a.speed_rank - b.speed_rank;
      return a.price_mxn - b.price_mxn;
    }
    return a.price_mxn - b.price_mxn;
  });

  return { ranked, warnings };
}
