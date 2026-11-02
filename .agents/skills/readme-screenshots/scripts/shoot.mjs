// usage: CHROME=<chromium binary> node shoot.mjs <dir that contains playwright-core> <base url> <output dir>
import { createRequire } from "node:module";
const require = createRequire(process.argv[2] + "/");
const { chromium } = require("playwright-core");
const [,, , base, out] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME });
async function shot(name, hash, scheme, full, height, crop) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: height ?? 800 }, colorScheme: scheme, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  await page.goto(base + hash, { waitUntil: "networkidle" });
  await page.waitForSelector("text=ライブ", { timeout: 15000 });
  await page.waitForTimeout(1500);
  let clip;
  if (crop) {
    const y = await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "マシン")?.getBoundingClientRect().top + window.scrollY);
    clip = { x: 0, y: 0, width: 1280, height: Math.round(y - 20) };
  }
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full, clip });
  await ctx.close();
}
await shot("lab", "/", "light", true, 800, true);
await shot("lab-dark", "/", "dark", true, 800, true);
await shot("usage", "/#/usage", "light", true);
await shot("agents", "/#/agents", "light", false, 620);
await browser.close();
