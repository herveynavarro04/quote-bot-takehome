import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";

let browser: Browser | null = null;
let page: Page | null = null;

async function getPage(): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });
  }
  if (!page) {
    page = await browser.newPage();
  }
  return page;
}

export async function closeBrowser() {
  // TODO: call this somewhere
  await browser?.close();
}

export const tools: Anthropic.Tool[] = [
  {
    name: "open_page",
    description: "Open a URL in the browser.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an element by CSS selector.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "fill",
    description: "Type a value into an input by CSS selector.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" } },
      required: ["selector", "value"],
    },
  },
  {
    name: "read_page",
    description: "Returns the HTML of the current page.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current page.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function executeTool(name: string, input: any): Promise<string> {
  try {
    const p = await getPage();
    switch (name) {
      case "open_page": {
        // new tab every time so pages don't interfere with each other
        page = await browser!.newPage();
        await page.goto(input.url);
        await page.waitForTimeout(2000);
        return "ok";
      }
      case "click": {
        await p.click(input.selector, { timeout: 5000 });
        await p.waitForTimeout(2000);
        return "ok";
      }
      case "fill": {
        await p.fill(input.selector, String(input.value), { timeout: 5000 });
        return "ok";
      }
      case "read_page": {
        const html = await p.content();
        return html.slice(0, 100_000);
      }
      case "screenshot": {
        fs.mkdirSync("screenshots", { recursive: true });
        const file = `screenshots/${Date.now()}.png`;
        await p.screenshot({ path: file });
        return `saved screenshot to ${file}`;
      }
      default:
        return "ok";
    }
  } catch (e) {
    console.log("tool error", e);
    return "ok";
  }
}
