import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { CarrierResult, Evidence, Status } from "./types.js";

let sharedBrowser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });
  }
  return sharedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) { await sharedBrowser.close(); sharedBrowser = null; }
}

function dateFolder(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function evidencePaths(carrier: string): { dir: string; stamp: string; shot: string; html: string } {
  const dir = path.join("evidence", dateFolder());
  fs.mkdirSync(dir, { recursive: true });
  const stamp = ts();
  return {
    dir,
    stamp,
    shot: path.join(dir, `${stamp}-${carrier}.png`),
    html: path.join(dir, `${stamp}-${carrier}.html`),
  };
}

export const BLOCK_TITLE_RE = /(access denied|just a moment|attention required|request blocked|cloudflare|bot detect|unusual traffic)/i;
export const CAPTCHA_SELECTORS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='challenges.cloudflare.com']",
  "#px-captcha",
  "iframe[title*='challenge' i]",
];

// Akamai Bot Manager soft-blocks often return 200 with a plain body. Two
// signatures seen in the wild:
//   "You don't have permission to access … Reference #18.xxxxx"       (generic Akamai)
//   "We're sorry, we can't process your request … Incident Number:…"  (FedEx-flavored)
const AKAMAI_INCIDENT_RE = /(Reference\s*#|Incident\s*Number\s*:)/i;
const BLOCK_BODY_RE = /(access denied|you don[’']?t have permission|request has been blocked|unusual traffic from your network|can[’']?t process your request)/i;

export async function detectBlock(page: Page, lastResponseStatus?: number): Promise<string | null> {
  if (lastResponseStatus && [401, 403, 429].includes(lastResponseStatus)) {
    return `HTTP ${lastResponseStatus}`;
  }
  try {
    const title = await page.title();
    if (title && BLOCK_TITLE_RE.test(title)) return `block page title: ${title}`;
  } catch {}
  try {
    const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (bodyText) {
      if (AKAMAI_INCIDENT_RE.test(bodyText)) return "akamai block page (incident id present)";
      if (BLOCK_BODY_RE.test(bodyText)) return "block page body (permission/blocked wording)";
    }
  } catch {}
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const n = await page.locator(sel).count();
      if (n > 0) return `captcha detected: ${sel}`;
    } catch {}
  }
  return null;
}

export interface AdapterCtx {
  page: Page;
  context: BrowserContext;
  evidence: { shot: string; html: string; captured_at: string };
  setMethod: (m: "network" | "dom") => void;
  setRawHtmlPath: (p: string) => void;
  setDoubtful: (v: boolean) => void;
  setSiteEcho: (echo: NonNullable<CarrierResult["site_echo"]>) => void;
  setStatus: (s: Status) => void;
  setError: (msg: string) => void;
  addWarning: (w: string) => void;
}

export interface AdapterSpec {
  carrier: string;
  url: string;
  timeoutMs?: number;
  run: (ctx: AdapterCtx) => Promise<{ rates: CarrierResult["rates"] }>;
}

export async function runAdapter(spec: AdapterSpec): Promise<CarrierResult> {
  const started = Date.now();
  const paths = evidencePaths(spec.carrier);
  const captured_at = new Date().toISOString();

  let status: Status = "ok";
  let error: string | undefined;
  let method: "network" | "dom" | undefined;
  let doubtful = false;
  let rawHtmlPath: string | undefined;
  let siteEcho: CarrierResult["site_echo"] | undefined;
  const warnings: string[] = [];
  let rates: CarrierResult["rates"] = [];

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: "es-MX" });
  const page = await context.newPage();

  const timeoutMs = spec.timeoutMs ?? 45_000;
  const timeoutErr = new Error("adapter timeout");
  const timeoutP = new Promise<never>((_, rej) => setTimeout(() => rej(timeoutErr), timeoutMs));

  try {
    const ctx: AdapterCtx = {
      page,
      context,
      evidence: { shot: paths.shot, html: paths.html, captured_at },
      setMethod: (m) => { method = m; },
      setRawHtmlPath: (p) => { rawHtmlPath = p; },
      setDoubtful: (v) => { doubtful = v; },
      setSiteEcho: (e) => { siteEcho = e; },
      setStatus: (s) => { status = s; },
      setError: (m) => { error = m; },
      addWarning: (w) => { if (!warnings.includes(w)) warnings.push(w); },
    };
    const result = await Promise.race([spec.run(ctx), timeoutP]);
    rates = result.rates;
  } catch (e: any) {
    if (e === timeoutErr) {
      status = "timeout";
      error = `timed out after ${timeoutMs}ms`;
    } else {
      // Only overwrite status if adapter didn't already classify it.
      if (status === "ok") status = "error";
      error = e?.message ?? String(e);
    }
  } finally {
    try { await page.screenshot({ path: paths.shot, fullPage: true }); } catch {}
    try { await context.close(); } catch {}
  }

  const evidence: Evidence = {
    url: spec.url,
    screenshot: paths.shot,
    raw_html_path: rawHtmlPath,
    captured_at,
  };

  return {
    carrier: spec.carrier,
    status,
    rates: status === "ok" ? rates : [],
    error,
    method,
    doubtful: doubtful || undefined,
    warnings,
    site_echo: siteEcho,
    evidence,
    ms: Date.now() - started,
  };
}

// Capture POST/XHR responses that match a predicate. Returns a function to await the first match.
export function captureResponse(page: Page, match: (r: Response) => boolean): Promise<Response> {
  return page.waitForResponse(match, { timeout: 40_000 });
}
