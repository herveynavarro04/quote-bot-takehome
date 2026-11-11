import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { CarrierResult, Evidence, Status } from "./types.js";

let sharedBrowser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: process.env.HEADFUL !== "1",
      // DHL's CDN closes the HTTP/2 stream on fresh Playwright sessions
      // (ERR_HTTP2_PROTOCOL_ERROR every time). Negotiating HTTP/1.1 via ALPN
      // sidesteps it. This is a protocol fallback, not stealth or fingerprint
      // spoofing — HTTP/1.1 was the only transport until 2015.
      args: ["--disable-http2"],
    });
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
  setDebug: (key: string, value: unknown) => void;
  // Mid-flow block check — adapters can call this after sensitive steps
  // (postal-code lookup, submit) to decide early. Returns the block reason
  // observed so far, or null.
  blockSeen: () => string | null;
  // Tell runAdapter that the adapter already saved a screenshot at
  // evidence.shot and the finally block should NOT overwrite it. Use when
  // the live page is broken and finally's own screenshot would either leave
  // a 0-byte file or capture an unrelated state.
  markEvidenceSaved: () => void;
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
  const debug: Record<string, unknown> = {};
  let rates: CarrierResult["rates"] = [];
  let evidenceSaved = false;

  // Mid-flow block watcher. We listen to every response the page makes and
  // flag the first 401/403/429. Adapters can poll via ctx.blockSeen() between
  // steps; runAdapter also promotes a trailing-block result at the end.
  let networkBlock: string | null = null;
  const seenBlockedUrls: string[] = [];

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: "es-MX" });
  const page = await context.newPage();

  page.on("response", (resp) => {
    const code = resp.status();
    if ([401, 403, 429].includes(code)) {
      if (!networkBlock) networkBlock = `HTTP ${code} on ${new URL(resp.url()).hostname}`;
      if (seenBlockedUrls.length < 5) seenBlockedUrls.push(`${code} ${resp.url()}`);
    }
  });

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
      setDebug: (k, v) => { debug[k] = v; },
      blockSeen: () => networkBlock,
      markEvidenceSaved: () => { evidenceSaved = true; },
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
    // Every cleanup step gets its own hard timeout — a wedged page would
    // otherwise let the adapter run way past its budget.
    const withBudget = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
      });
    };
    // Skip this screenshot if the adapter already saved one (e.g. a synthetic
    // block evidence page). A failing screenshot here would truncate the file
    // to 0 bytes and wipe the real evidence.
    if (!evidenceSaved) {
      await withBudget(page.screenshot({ path: paths.shot, fullPage: true }), 5_000);
    }
    if ((status as Status) !== "blocked") {
      const bodyBlock = await withBudget(detectBlock(page), 3_000);
      if (bodyBlock) networkBlock = networkBlock ?? bodyBlock;
    }
    await withBudget(context.close(), 5_000);
  }

  // Promote to blocked when the watcher saw a block and the adapter didn't
  // settle on blocked itself. We clobber invalid_input in particular: a bot
  // wall during postal-code validation is not the user's fault.
  if (networkBlock && (status as Status) !== "blocked") {
    status = "blocked";
    error = networkBlock;
    if (seenBlockedUrls.length) debug.blocked_urls = seenBlockedUrls;
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
    debug: Object.keys(debug).length ? debug : undefined,
  };
}

// Capture POST/XHR responses that match a predicate. Returns a function to await the first match.
export function captureResponse(page: Page, match: (r: Response) => boolean): Promise<Response> {
  return page.waitForResponse(match, { timeout: 40_000 });
}
