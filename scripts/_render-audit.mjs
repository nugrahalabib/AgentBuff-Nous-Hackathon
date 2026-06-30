// Real-render audit of the landing page via headless Chromium (Playwright).
// Renders at desktop width, full-page screenshot, collects console errors,
// failed/4xx requests (catches broken images), broken <img>, and DOM facts.
// Run: node scripts/_render-audit.mjs [url]
import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:617/";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const consoleErrors = [];
const failed = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
page.on("requestfailed", (r) => failed.push(`FAILED ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { const s = r.status(); if (s >= 400) failed.push(`${s} ${r.url()}`); });

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
} catch (e) {
  console.log("GOTO note:", e.message);
}
await page.waitForTimeout(2000);

// Scroll through the whole page to trigger lazy/below-fold images (marquee,
// footer, carousels) so the broken-image check reflects reality, not lazy state.
await page.evaluate(async () => {
  for (let y = 0; y <= document.body.scrollHeight; y += 700) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 250));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(3000);

const brokenImgs = await page.evaluate(() =>
  Array.from(document.images)
    .filter((i) => !i.complete || i.naturalWidth === 0)
    .map((i) => i.currentSrc || i.src),
);

const facts = await page.evaluate(() => {
  const ctas = Array.from(document.querySelectorAll("a, button"))
    .map((e) => ({ t: (e.innerText || "").trim().replace(/\s+/g, " "), href: e.getAttribute("href") }))
    .filter((x) => x.t);
  return {
    title: document.title,
    h1: document.querySelector("h1")?.innerText?.trim(),
    h1Count: document.querySelectorAll("h1").length,
    sectionCount: document.querySelectorAll("section").length,
    imgCount: document.images.length,
    hasDemoModalZ: !!document.querySelector('[class*="z-[100]"]'),
    deadHrefHash: Array.from(document.querySelectorAll('a[href="#"], a:not([href]), button:not([type])')).length,
    ctas: ctas.slice(0, 40),
    bodyScrollH: document.body.scrollHeight,
  };
});

await page.screenshot({ path: "scripts/_landing-full.png", fullPage: true });

console.log("=== TITLE:", facts.title);
console.log("=== H1:", facts.h1, "| h1 count:", facts.h1Count, "| sections:", facts.sectionCount, "| imgs:", facts.imgCount, "| pageH:", facts.bodyScrollH);
console.log("=== demo modal present?:", facts.hasDemoModalZ);
console.log("=== CONSOLE ERRORS (" + consoleErrors.length + "):", JSON.stringify([...new Set(consoleErrors)], null, 1));
console.log("=== FAILED / 4xx (" + failed.length + "):", JSON.stringify([...new Set(failed)], null, 1));
console.log("=== BROKEN IMAGES (" + brokenImgs.length + "):", JSON.stringify(brokenImgs, null, 1));
console.log("=== CTAs (text -> href):");
for (const c of facts.ctas) console.log("   " + JSON.stringify(c));

await browser.close();
