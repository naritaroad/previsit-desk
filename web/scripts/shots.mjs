// Screenshots of the gallery (design review): node scripts/shots.mjs [--base http://localhost:5181] [--only clinic,chat]
//   [--widths 1440,1024,390] [--themes light,dark] [--out ../docs/design/v2-shots] [--path /clinic]
// Needs a running `vite` in a non-production mode. Prints layout problems it can see: horizontal overflow, console
// errors, clipped text in buttons.

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const base = arg("base", "http://localhost:5181");
const out = arg("out", fileURLToPath(new URL("../../docs/design/v2-shots", import.meta.url)));
const widths = arg("widths", "1440,1024,390").split(",").map(Number);
const themes = arg("themes", "light,dark").split(",");
const scenes = ["kit", "public", "trust", "patient", "chat", "wizard", "clinic", "review", "pharmacy", "dispense", "admin"];
const only = arg("only", scenes.join(",")).split(",");
const full = !process.argv.includes("--fold");
const text = arg("text", "100");
const locale = arg("locale", "zh-TW");
mkdirSync(out, { recursive: true });

// The installed browser may be older than the one this Playwright would download.
const cache = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
let executablePath;
try {
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))[0];
  if (dir) executablePath = join(cache, dir, "chrome-win64", "chrome.exe");
} catch {
  /* use the default */
}
const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch({ channel: "chrome" }));
let problems = 0;
for (const theme of themes) {
  for (const width of widths) {
    const height = width < 500 ? 844 : 900;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width < 500, isMobile: width < 500, colorScheme: theme, locale });
    await ctx.addInitScript(
      ([t, s, l]) => {
        localStorage.setItem("pv-theme", t);
        localStorage.setItem("pv-text", s);
        localStorage.setItem("pv-locale", l);
      },
      [theme, text, locale],
    );
    for (const scene of only) {
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebSocket|ERR_/.test(m.text()) && errors.push(m.text().slice(0, 220)));
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 220)));
      const path = scene.startsWith("/") ? scene : scene === "kit" ? "/dev/kit" : `/dev/kit/scene/${scene}`;
      await page.goto(base + path, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main h1", { timeout: 20000 }).catch(() => errors.push("no h1"));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(900);
      // Full-page captures do not scroll: walk the page so lazy photographs load.
      await page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        scrollTo(0, 0);
        await Promise.all([...document.images].map((i) => i.complete || new Promise((r) => i.addEventListener("load", r, { once: true }))));
        await new Promise((r) => setTimeout(r, 450));
      });
      const issues = await page.evaluate(() => {
        const list = [];
        const de = document.documentElement;
        if (de.scrollWidth > innerWidth + 1) list.push(`page overflows: ${de.scrollWidth} > ${innerWidth}`);
        for (const el of document.querySelectorAll("main *")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > innerWidth + 2 && !el.closest(".dt-wrap,.ruled-table-wrap,.tabs-list,.board,.toc-nav,.sr-only,table.sr-only,.segmented")) {
            list.push(`past the edge: ${el.tagName}.${String(el.className.baseVal ?? el.className).slice(0, 40)} ${Math.round(r.right)}`);
            if (list.length > 5) break;
          }
        }
        for (const b of document.querySelectorAll(".btn,.tag,.tab")) if (b.scrollWidth > b.clientWidth + 2 && b.clientWidth) list.push(`clipped: ${b.textContent.slice(0, 20)}`);
        return list.slice(0, 8);
      });
      const name = `${scene.replace(/^\//, "").replaceAll("/", "-")}-${width}-${theme}${text === "100" ? "" : `-t${text}`}${locale === "zh-TW" ? "" : `-${locale}`}.png`;
      await page.screenshot({ path: join(out, name), fullPage: full && ["kit", "public", "trust"].includes(scene) });
      for (const p of [...errors, ...issues]) console.log(`${name}: ${p}`);
      problems += errors.length + issues.length;
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems ? `${problems} thing(s) to look at` : "no layout problems seen");
