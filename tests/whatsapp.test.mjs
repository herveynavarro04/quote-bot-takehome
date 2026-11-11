import assert from "node:assert/strict";
import { buildWhatsAppMessage, getValidOptions } from "../public/whatsapp.js";

const NOW = new Date("2026-11-11T15:34:00");

function okCarrier(name, rates, extra = {}) {
  return {
    carrier: name,
    status: "ok",
    rates,
    warnings: extra.warnings || [],
    doubtful: extra.doubtful || false,
    site_echo: extra.site_echo,
    evidence: { url: "", screenshot: "", captured_at: "" },
    ms: 0,
  };
}

function baseQuote(overrides = {}) {
  return {
    status: "ok",
    normalized: {
      origin_cp: "44100", destination_cp: "06600",
      parcels: [{ real_kg: 2, length_cm: 20, width_cm: 15, height_cm: 10, volumetric_kg: 1, billable_kg: 2, quantity: 1 }],
      type: "package", priority: "cheapest", warnings: [],
    },
    carriers: [
      okCarrier("fedex", [{ service: "Express Saver", price_mxn: 389.5, iva: "included", speed_rank: 2, next_day: false, delivery_text: "LLEGA EL vie, nov 13" }]),
      okCarrier("estafeta", [{ service: "Terrestre", price_mxn: 275.0, iva: "included", speed_rank: 3, next_day: false }]),
    ],
    ranked: [
      { carrier: "estafeta", service: "Terrestre", price_mxn: 275.0, iva: "included", next_day: false, speed_rank: 3 },
      { carrier: "fedex", service: "Express Saver", price_mxn: 389.5, iva: "included", next_day: false, speed_rank: 2, delivery_text: "LLEGA EL vie, nov 13" },
    ],
    warnings: [],
    ...overrides,
  };
}

// 1) single option
{
  const q = baseQuote();
  const opts = getValidOptions(q);
  const msg = buildWhatsAppMessage(q, [opts[0].id], NOW);
  assert.match(msg, /¡Hola!.*CP 06600.*paquete de 2 kg.*sale en:/s);
  assert.match(msg, /• Estafeta Terrestre: \$275\.00/);
  assert.match(msg, /Precios con IVA, cotizados hoy a las \d\d:\d\d\./);
  assert.ok(!/variar ligeramente/.test(msg));
  assert.ok(!/FedEx/.test(msg));
}

// 2) two options — includes delivery line for FedEx
{
  const q = baseQuote();
  const opts = getValidOptions(q);
  const msg = buildWhatsAppMessage(q, opts.map(o => o.id), NOW);
  assert.match(msg, /• Estafeta Terrestre: \$275\.00/);
  assert.match(msg, /• FedEx Express Saver: \$389\.50, llega el vie, nov 13/);
}

// 3) approximate warning appears in footer
{
  const q = baseQuote();
  q.carriers[0].warnings = ["price_is_approximate"]; // fedex
  const opts = getValidOptions(q);
  // pick only the fedex option
  const fedexId = opts.find(o => o.carrier === "fedex").id;
  const msg = buildWhatsAppMessage(q, [fedexId], NOW);
  assert.match(msg, /El precio puede variar ligeramente al generar la guía\./);
}

// 4) multi-parcel subject
{
  const q = baseQuote({
    normalized: {
      ...baseQuote().normalized,
      parcels: [{ real_kg: 2, length_cm: 20, width_cm: 15, height_cm: 10, volumetric_kg: 1, billable_kg: 2, quantity: 4 }],
    },
  });
  const opts = getValidOptions(q);
  const msg = buildWhatsAppMessage(q, [opts[0].id], NOW);
  assert.match(msg, /tus 4 paquetes/);
}

// 5) failed carrier can never be included even if its id is passed
{
  const q = baseQuote();
  q.carriers[0].status = "blocked";     // fedex blocked
  q.carriers[0].rates = [];
  // keep ranked to simulate a stale id being passed
  const msg = buildWhatsAppMessage(q, ["fedex:Express Saver", "estafeta:Terrestre"], NOW);
  assert.ok(!/FedEx/.test(msg), "fedex must not appear in output");
  assert.match(msg, /• Estafeta Terrestre: \$275\.00/);
  // getValidOptions should also skip it
  const opts = getValidOptions(q);
  assert.ok(opts.every(o => o.carrier !== "fedex"));
}

// 6) doubtful rate cannot be included even if explicitly selected
{
  const q = baseQuote();
  q.carriers[1].doubtful = true; // estafeta doubtful
  const msg = buildWhatsAppMessage(q, ["estafeta:Terrestre"], NOW);
  assert.equal(msg, "", "no selectable options → empty message");
}

// 7) site_echo destination preferred over CP
{
  const q = baseQuote();
  q.carriers[1].site_echo = { destination: "Juárez, CDMX (CP 06600)" };
  const opts = getValidOptions(q);
  const msg = buildWhatsAppMessage(q, [opts[0].id], NOW);
  assert.match(msg, /El envío a Juárez, CDMX \(CP 06600\)/);
}

console.log("whatsapp.test: all passed");
