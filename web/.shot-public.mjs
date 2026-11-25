// Screenshots of the public pages: node .shot-public.mjs <out> <widths> <themes> <locale> <path...>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const [out, widths, themes, locale, ...paths] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
for (const theme of themes.split(",")) for (const w of widths.split(",").map(Number)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, hasTouch: w < 500, isMobile: w < 500, colorScheme: theme, locale });
  await ctx.addInitScript(([t, l]) => { localStorage.setItem("pv-theme", t); localStorage.setItem("pv-locale", l); }, [theme, locale]);
  for (const p of paths) {
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 300)));
    await page.goto("http://localhost:5201" + p, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main h1", { timeout: 20000 }).catch(() => errs.push("no h1"));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    // wake lazy pictures
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
    await page.waitForTimeout(700);
    const issues = await page.evaluate(() => {
      const list = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) list.push(`overflow ${document.documentElement.scrollWidth}`);
      for (const el of document.querySelectorAll("main *")) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 2 && !el.closest(".ruled-table-wrap,.sr-only,pre,svg")) { list.push(`edge ${el.tagName}.${String(el.className.baseVal ?? el.className).slice(0, 50)} ${Math.round(r.right)}`); if (list.length > 4) break; }
      }
      return list;
    });
    const name = `public-${(p.replace(/[?#].*/, "").replace(/^\//, "").replaceAll("/", "-") || "home")}-${w}-${theme}${locale === "en" ? "-en" : ""}.png`;
    await page.screenshot({ path: `${out}/${name}`, fullPage: true });
    console.log(name, ...errs, ...issues);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
