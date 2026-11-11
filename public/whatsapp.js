// Builds a plain-text WhatsApp reply from a QuoteResult.
// Numbers never come from an LLM — only from the quote object.

const CARRIER_LABELS = { estafeta: "Estafeta", dhl: "DHL", fedex: "FedEx", redpack: "Redpack", ups: "UPS" };

export function carrierLabel(c) {
  return CARRIER_LABELS[String(c || "").toLowerCase()] || c || "—";
}

export function rateId(r) {
  return `${String(r.carrier || "").toLowerCase()}:${r.service}`;
}

function fmtMoneyMx(n) {
  return "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTimeMx(d) {
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Returns a flat list of selectable options derived from quote.ranked.
// Filters anything whose carrier is not status==="ok" so blocked/failed carriers
// never appear in the popup. Doubtful rates are returned with a flag so the UI
// can show them disabled ("verificar primero").
export function getValidOptions(quote) {
  if (!quote || quote.status !== "ok") return [];
  const ranked = Array.isArray(quote.ranked) ? quote.ranked : [];
  const carriers = Array.isArray(quote.carriers) ? quote.carriers : [];
  const byName = new Map(carriers.map((c) => [String(c.carrier || "").toLowerCase(), c]));
  const out = [];
  for (const r of ranked) {
    const c = byName.get(String(r.carrier || "").toLowerCase());
    if (!c || c.status !== "ok") continue;
    out.push({
      id: rateId(r),
      carrier: r.carrier,
      service: r.service,
      price_mxn: r.price_mxn,
      iva: r.iva,
      next_day: !!r.next_day,
      delivery_text: r.delivery_text || "",
      doubtful: !!c.doubtful,
      warnings: Array.isArray(c.warnings) ? c.warnings.slice() : [],
      site_echo: c.site_echo || null,
    });
  }
  return out;
}

function destinationLabel(quote) {
  const carriers = Array.isArray(quote.carriers) ? quote.carriers : [];
  for (const c of carriers) {
    if (c.status !== "ok") continue;
    const echo = c.site_echo && c.site_echo.destination;
    if (echo && String(echo).trim()) return String(echo).trim();
  }
  const normalized = quote.normalized || {};
  if (normalized.destination_cp) return "CP " + normalized.destination_cp;
  return "tu destino";
}

function subjectLabel(normalized) {
  const parcels = (normalized && normalized.parcels) || [];
  const totalQty = parcels.reduce((n, p) => n + (p.quantity || 1), 0);
  if (totalQty > 1) return `tus ${totalQty} paquetes`;
  const p = parcels[0];
  if (!p || p.real_kg == null) return "tu paquete";
  return `tu paquete de ${p.real_kg} kg`;
}

function deliveryLine(opt) {
  if (opt.next_day) return "llega mañana";
  const t = (opt.delivery_text || "").trim();
  if (!t) return "";
  // make the site's string friendlier; don't invent dates
  return t.replace(/^LLEGA\s+EL\s+/i, "llega el ").replace(/^LLEGA\s+/i, "llega ").replace(/\s+/g, " ").trim();
}

// quote: QuoteResult; selectedRateIds: string[]; now: Date.
// Returns the full WhatsApp-friendly message as a plain string.
export function buildWhatsAppMessage(quote, selectedRateIds, now) {
  const all = getValidOptions(quote);
  const byId = new Map(all.map((o) => [o.id, o]));
  const picked = [];
  for (const id of selectedRateIds || []) {
    const o = byId.get(id);
    if (!o) continue;              // not an ok rate — ignored
    if (o.doubtful) continue;      // cannot be offered to a customer
    picked.push(o);
    if (picked.length === 2) break;
  }
  if (picked.length === 0) return "";

  const normalized = quote.normalized || {};
  const dest = destinationLabel(quote);
  const subject = subjectLabel(normalized);
  const time = fmtTimeMx(now instanceof Date ? now : new Date());

  const lines = [`¡Hola! El envío a ${dest} de ${subject} sale en:`];
  for (const o of picked) {
    const price = fmtMoneyMx(o.price_mxn);
    const dl = deliveryLine(o);
    const base = `• ${carrierLabel(o.carrier)} ${o.service}: ${price}`;
    lines.push(dl ? `${base}, ${dl}` : base);
  }

  let footer = `Precios con IVA, cotizados hoy a las ${time}.`;
  const warnsOf = (o) => new Set(o.warnings || []);
  const anyApprox = picked.some((o) => warnsOf(o).has("price_is_approximate"));
  if (anyApprox) footer += " El precio puede variar ligeramente al generar la guía.";
  const anyDimAssumed = picked.some((o) => warnsOf(o).has("dimensions_assumed"));
  if (anyDimAssumed) footer += " (Cotizado sin medidas exactas; si la caja es grande puede cambiar.)";
  lines.push(footer);

  return lines.join("\n");
}
