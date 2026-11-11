// Renders the WhatsApp popup against a mock QuoteResult and saves a screenshot.
// Standalone: does not require the dev server or an API key.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const waJs = fs.readFileSync(path.join(root, "public/whatsapp.js"), "utf8");

// Inline the module so file:// loads with no server.
const inlined = indexHtml.replace(
  '<script type="module">\nimport { buildWhatsAppMessage, getValidOptions, carrierLabel as waCarrierLabel } from "/whatsapp.js";\nwindow.__wa = { buildWhatsAppMessage, getValidOptions, waCarrierLabel };\n</script>',
  `<script type="module">\n${waJs}\nwindow.__wa = { buildWhatsAppMessage, getValidOptions, waCarrierLabel: carrierLabel };\n</script>`
);

const quote = {
  status: "ok",
  normalized: {
    origin_cp: "44100", destination_cp: "06600",
    parcels: [{ real_kg: 2, length_cm: 20, width_cm: 15, height_cm: 10, volumetric_kg: 1, billable_kg: 2, quantity: 1 }],
    type: "package", priority: "cheapest", warnings: [],
  },
  carriers: [
    { carrier: "fedex", status: "ok", rates: [{ service: "Express Saver", price_mxn: 389.5, iva: "included", speed_rank: 2, next_day: false, delivery_text: "LLEGA EL vie, nov 13" }], warnings: ["price_is_approximate"], evidence: { url: "", screenshot: "", captured_at: "" }, ms: 0, site_echo: { destination: "Benito Juárez, CDMX (CP 06600)" } },
    { carrier: "estafeta", status: "ok", rates: [{ service: "Terrestre", price_mxn: 275.0, iva: "included", speed_rank: 3, next_day: false }], warnings: [], evidence: { url: "", screenshot: "", captured_at: "" }, ms: 0 },
    { carrier: "dhl", status: "blocked", rates: [], warnings: [], evidence: { url: "", screenshot: "", captured_at: "" }, ms: 0 },
  ],
  ranked: [
    { carrier: "estafeta", service: "Terrestre", price_mxn: 275.0, iva: "included", next_day: false, speed_rank: 3 },
    { carrier: "fedex", service: "Express Saver", price_mxn: 389.5, iva: "included", next_day: false, speed_rank: 2, delivery_text: "LLEGA EL vie, nov 13" },
  ],
  warnings: [],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
await page.setContent(inlined, { waitUntil: "load" });

// Inject a rendered quote into the chat and open the modal.
await page.evaluate((q) => {
  const chat = document.getElementById("chat");
  // The chat IIFE already ran, but renderQuote is scoped inside. Fire the public path.
  // Fake a bot message by dispatching the same code path indirectly: simulate server response.
  // Easiest: call addBot via a tiny hook. Instead, just dispatch the module directly.
  // We re-import buildWhatsAppMessage via window.__wa and render a minimal card ourselves,
  // then call the exposed opener if present. The IIFE exposes nothing — easiest path:
  // manually craft a message bubble so the WA button appears via the IIFE's renderQuote.
  // Trick: call the global submit path by injecting a fake response.
  const fakeFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (url === "/api/chat") {
      return { ok: true, json: async () => ({ answer: "", quote: q }) };
    }
    return fakeFetch(url, opts);
  };
  const input = document.getElementById("msg");
  input.value = "cotiza 2kg 44100 a 06600";
  document.getElementById("form").requestSubmit();
}, quote);

await page.waitForSelector(".wa-btn", { timeout: 5000 });
await page.click(".wa-btn");
await page.waitForSelector(".modal", { timeout: 5000 });
await page.waitForTimeout(150);

const out = path.join(root, "notes/img/whatsapp.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: true });
console.log("saved", out);
await browser.close();
