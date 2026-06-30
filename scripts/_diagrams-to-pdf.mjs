// Throwaway: render Docs/diagrams/agentbuff-user-flows.html → PDF (A4) using
// Playwright + the system Chrome. The @page CSS in the HTML drives size/margin.
//   node scripts/_diagrams-to-pdf.mjs
import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const htmlPath = path.resolve("Docs/diagrams/agentbuff-user-flows.html");
const outPath = path.resolve("Docs/diagrams/agentbuff-user-flows.pdf");

async function render(launchOpts, label) {
  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
    await page.pdf({
      path: outPath,
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log(`PDF written via ${label}:`, outPath);
  } finally {
    await browser.close();
  }
}

try {
  await render({ channel: "chrome", headless: true }, "system Chrome");
} catch (e) {
  console.warn("system Chrome failed, trying bundled chromium:", e.message);
  await render({ headless: true }, "bundled chromium");
}
process.exit(0);
