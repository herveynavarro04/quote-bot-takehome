# QuoteBot: shipping quote agent (Handle SWE take-home)

## The situation

**Tienda Nopal** is a small online store in Monterrey that sells handmade home goods. They ship ~200 packages a month all over Mexico. Every time, Mariana (the owner) or her assistant opens three or four carrier websites, types the same postal codes and box sizes, and copies prices into a spreadsheet. None of those websites offers them an API.

Things Mariana has told us:
- "Most of my boxes are one of three sizes, and half my orders go to CDMX, Guadalajara or Mérida."
- "Customers ask me on WhatsApp how much shipping costs before they buy. I need an answer in a minute, not ten."
- "Sometimes cheapest isn't best. If it's a gift, it has to arrive on time."
- "My accountant asks whether the price includes IVA and I never know."
- "Last month a price I quoted was wrong and I paid the difference."

A previous contractor built **QuoteBot**: a chat assistant with a small web page. It takes a request in plain language ("how much to send a 3 kg box from Monterrey to Mérida?"), drives the carrier websites with a browser, and answers with a price.

It works sometimes. Mariana doesn't trust it and doesn't enjoy using it. Your job is to turn QuoteBot into something she'd open every day: **reliable underneath, and genuinely useful on top.**

## What's in this repo

| Path | What it is |
|---|---|
| `src/agent.ts` | The agent loop (Claude, tool use) |
| `src/tools.ts` | Browser tools built on Playwright: `open_page`, `click`, `fill`, `read_page`, `screenshot` |
| `src/prompt.ts` | The system prompt, as the contractor left it |
| `src/server.ts`, `public/index.html` | The web chat: `npm run dev`, then open http://localhost:3000 |
| `public/start.html` | Start page: this brief as a 2-minute animation, plus setup checks. Shown on your first visit, and any time at `/start` |
| `src/cli.ts` | Chat in your terminal: `npm run chat` |
| `src/run-case.ts` | Run one request from `cases/cases.json`: `npm run case -- 3` |
| `cases/cases.json` | 10 requests written the way real users write them, each with what a correct answer looks like (`expect`) |

Setup (Node 20 or newer):

```bash
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=...   # we send you a key with a spending cap
npm run dev                    # open http://localhost:3000: a start page first, then the chat
```

To watch the browser, set `HEADFUL=1` (macOS/Linux: `HEADFUL=1 npm run dev`; Windows PowerShell: `$env:HEADFUL=1; npm run dev`).

Any language, framework or library is fine. Keep the code, rewrite it, or start over: your call, as long as you can explain why.

### About the API key

The key has a spending cap, and the starter is wasteful: it can spend a few dollars on a single case that gets stuck. Don't run all 10 cases on the starter. Run **3 cases of your choice** on it as your "before", and spend the rest of the key on your own version. If you run out, email us and we'll top it up; running out is never held against you.

## The carriers

These are real, public websites. They differ in how hard they are to work with, and that's on purpose. We chose them and we're fine with the low-volume, quote-only use described below.

| Carrier | Quote page | What to expect |
|---|---|---|
| Estafeta | https://www.estafeta.com/cotizar-envio | No login. Form rendered with JavaScript. |
| FedEx México | https://www.fedex.com/es-mx/online/rating.html | Heavy, slow page. May ask for more than you expect. |
| Redpack | https://www.redpack.com.mx/es/cotizador/ | Has bot protection. |
| DHL México | https://www.dhl.com/mx-es/home/envio/cotizacion-envio.html | Often blocks automated browsers. |
| UPS México | https://www.ups.com/mx/es/support/shipping-support/shipping-costs-rates.page | Unknown. Find out. |

**Your agent must try at least 3 carriers and report honestly whatever each one does.** Sites behave differently depending on your network: one may block you and not someone else. If nothing blocks you, say so in your notes, and show how your agent would report a block (for example by pointing it at a page that fails).

## Rules

1. **Don't defeat bot protection.** No captcha solving, no stealth plugins, no fingerprint spoofing, no rotating proxies. When a site blocks you, the right result is an agent that notices, says so plainly, and carries on with the other carriers. Two things are fine: calling the same public request the page itself makes, and a site's invisible check passing on its own while you use a normal browser.
2. **Be a polite client.** Low volume, no hammering. You'll run each case a handful of times, not hundreds.
3. **Don't book or pay for anything.** Quote only.
4. **Never make up a price.** A price the agent can't back with evidence from the website is worse than no price.
5. **AI tools are welcome.** Use Claude Code, Cursor or whatever you normally use. We care about your judgment, so be ready to explain every line you submit.

## What we want

**1. Make it trustworthy.**
- **Real prices, with evidence** for each one: a screenshot, the text it read, or the network response. Mariana should be able to check any price.
- **Honest about what it couldn't do.** If a carrier blocked it, timed out or doesn't serve a route, she hears that clearly.
- **Measured.** A small, repeatable way to score QuoteBot against the `expect` field in `cases/cases.json`: pass/fail, time and cost per case. Report "before" (the starter, 3 cases) and "after" (your version, at least 5 cases).

**2. Make it a product she wants to use.**
- The UI is as plain as the contractor left it. Fix the **one or two things** that would hurt Mariana most: what she sees while it works, how options are compared, what happens when something fails.
- **One small feature** (about 45 minutes) you think is worth the most to her, based on what she told us above. Tell us why you picked it over the alternatives. If you run out of time, a clear write-up of the feature you'd build is acceptable.

You won't do everything in the time. Choosing what to do first, and what to leave for later, is part of the exercise, and we grade against the time box: a clear "next" list counts.

## Time

**About 3–4 hours of focused work.** Please stop there. We'd rather see three things done well and a clear list of what you'd do next than everything done halfway.

## What to send us

1. Your repo (shared with the GitHub user we name in the email), or a zip.
2. `NOTES.md`, one page or less:
   - What you found wrong, in the order you'd fix it, and why that order.
   - What you changed, and what you deliberately didn't.
   - Your before/after numbers.
   - The feature you added (or would add), who it's for, and the 2–3 others you considered and why you didn't build them.
   - How you used AI tools, and one suggestion from them you rejected.
   - A few screenshots of the UI.
3. One saved trace of a run where a carrier failed or blocked the agent.

## How we score it

We share this up front so nothing is hidden. Each area is scored 0–4, then weighted:

| Area | Weight | What good looks like |
|---|---|---|
| Correctness and honesty | 20 | Prices are real and backed by evidence; failures are reported, never covered up |
| Browser and agent engineering | 20 | Reliable waits and extraction; sensible choices between letting the model click and writing deterministic code; a short, consistent prompt with business logic in code |
| Product sense (conversation) | 10 | The right questions to the user, fair comparisons, clear messages when things go wrong |
| Product improvements | 25 | UI changes and a feature that make QuoteBot clearly more useful for Mariana, with reasons for what you chose |
| Evidence | 15 | A measurement you'd trust, and before/after numbers |
| Judgment | 10 | A sensible order of priorities and an honest account of trade-offs |

One hard rule: if your submitted agent is designed to report a price it didn't read from a site, or to get around bot protection, we won't move forward. A one-off model slip that your own traces caught and your notes flag is not that.

## After you submit

A 60-minute call with two engineers:
- You walk us through 2–3 decisions.
- We change something (a new carrier or a new kind of request) and work on it together, AI tools allowed.
- We talk about what it would take to run this for real for 200 packages a month.

Questions while you work? Email the engineer named in your invite. We answer within one business day, and asking is never held against you.
