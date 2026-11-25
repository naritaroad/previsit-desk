// README banners and social preview: node scripts/render-banner.mjs [--only banner-light,social-preview]
// Draws docs/assets/banner/banner.html in Edge with the product's own fonts and tokens (needs `npm ci` in web/).
// The strip's dates are worked out from data/seed/refill_rules.csv the way backend/src/refill.rs does it, and the run
// stops if the sample prescription breaks a rule.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const { chromium } = createRequire(new URL("web/package.json", root))("@playwright/test");
const out = new URL("docs/assets/banner/", root);

// ---- the sample prescription (fictional) ----
const RX = { issued: "2026-10-01", fills: ["2026-10-01", "2026-10-31"], today: "2026-11-25" };

const csv = readFileSync(new URL("data/seed/refill_rules.csv", root), "utf8");
const rule = (key) => {
  const n = Number(csv.split(/\r?\n/).find((l) => l.startsWith(`${key},`))?.split(",")[1]);
  if (!Number.isInteger(n)) throw new Error(`refill_rules.csv: no number for ${key}`);
  return n;
};
const perFill = rule("max_days_per_fill");
const total = rule("max_total_days");
const early = rule("early_window_days");
const count = Math.min(rule("max_fills"), total / perFill);

const DAY = 86_400_000;
const add = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const between = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const must = (ok, why) => {
  if (!ok) throw new Error(`sample prescription: ${why}`);
};

const lastDay = add(RX.issued, total - 1); // last_valid_day() in backend/src/refill.rs
const supplyEnd = (fill) => add(fill, perFill);
const windowAfter = (fill) => ({ from: add(supplyEnd(fill), -early), to: lastDay });
must(RX.fills.length < count, "the next fill must still be open");
must(RX.fills[0] === RX.issued, "the first fill is on the day of issue");
RX.fills.slice(1).forEach((f, i) => {
  must(f >= windowAfter(RX.fills[i]).from && f <= supplyEnd(RX.fills[i]), `fill ${i + 2} on ${f} is early or leaves a gap`);
});
const last = RX.fills.at(-1);
const win = windowAfter(last);
must(RX.today >= win.from && RX.today <= supplyEnd(last), "today must be in the open window, before the supply ends");

const cells = [];
for (let n = 1; n <= count; n++) {
  const filled = RX.fills[n - 1] ?? null;
  const prev = cells.at(-1)?.to ?? RX.issued;
  const from = filled && filled > prev ? filled : prev;
  cells.push({ n, filled, next: n === RX.fills.length + 1, from, to: add(from, perFill) });
}
const span = between(RX.issued, cells.at(-1).to);
const pos = (d) => between(RX.issued, d) / span;
const strip = {
  cells: cells.map((c) => ({ ...c, from: pos(c.from), to: pos(c.to) })),
  window: { from: pos(win.from), to: pos(add(win.to, 1)) }, // through the end of the last day
  today: pos(RX.today),
  labels: { today: md(RX.today), from: md(win.from), to: md(win.to) },
};

const next = RX.fills.length + 1;

// ---- copy ----
const zh = {
  lang: "zh-TW",
  name: "診前助理",
  sub: "PreVisit Desk",
  copies: [["patient", "病人"], ["clinic", "醫師"], ["pharmacy", "藥局"], ["admin", "管理"]],
  title: ["看診前，", "先把話說完整。"],
  lede: ["AI 整理病史，程式守住規則，", "醫師與藥師做決定。"],
  quotes: ["「", "」"],
  fields: [
    { label: "主訴", value: "咳嗽" },
    { label: "何時開始", value: "三天，" },
    { label: "病程", value: "晚上比較厲害" },
    { label: "伴隨症狀", value: "還沒問到", missing: true },
  ],
  refill: `慢箋第 ${next} 次領藥`,
  cellOpen: "可領藥",
  stamp: "已領",
  today: "今天",
  window: "領藥期間",
  to: "～",
};
const en = {
  lang: "en",
  name: "PreVisit Desk",
  sub: "診前助理",
  copies: [["patient", "Patient"], ["clinic", "Doctor"], ["pharmacy", "Pharmacy"], ["admin", "Admin"]],
  title: ["Say all of it", "before the visit."],
  lede: ["AI takes the history,", "code keeps the rules,", "doctors and pharmacists decide."],
  quotes: ["“", "”"],
  fields: [
    { label: "Concern", value: "Cough," },
    { label: "Onset", value: "3 days," },
    { label: "Course", value: "worse at night" },
    { label: "Associated", value: "Not asked yet", missing: true },
  ],
  refill: `Refill ${next} of ${count}`,
  cellOpen: "Collect now",
  stamp: "FILLED",
  today: "Today",
  window: "Collect",
  to: " to ",
};

const JOBS = [
  { name: "banner-light", copy: zh, theme: "light" },
  { name: "banner-dark", copy: zh, theme: "dark" },
  { name: "banner-en-light", copy: en, theme: "light" },
  { name: "banner-en-dark", copy: en, theme: "dark" },
  { name: "social-preview", copy: { ...zh, english: en.title.join(" ") }, theme: "light", variant: "social", height: 800, scale: 0.8 },
];
const LIMIT = 600 * 1024;
const flag = process.argv.indexOf("--only");
const only = flag === -1 ? null : process.argv[flag + 1].split(",");

/** Runs in the page: wrong faces, anything off the sheet, clipped cells, and neighbours that touch. */
function faultsIn() {
  const faults = [];
  for (const family of ["Noto Sans TC Variable", "Noto Serif TC Variable"]) {
    if (![...document.fonts].some((f) => f.family.replace(/["']/g, "") === family && f.status === "loaded")) faults.push(`${family} did not load`);
  }
  const textBox = (e) => {
    const range = document.createRange();
    range.selectNodeContents(e);
    return range.getBoundingClientRect();
  };
  const box = (s) => {
    const e = document.querySelector(s);
    if (!e || !e.getBoundingClientRect().width) return null;
    return /^(h1|\.lede|\.big|\.axis|\.name)$/.test(s) ? textBox(e) : e.getBoundingClientRect();
  };
  for (const e of document.querySelectorAll("body *")) {
    const b = e.getBoundingClientRect();
    if (b.width && (b.left < 0 || b.top < 0 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1)) faults.push(`off the sheet: ${e.tagName} ${e.textContent.slice(0, 20)}`);
  }
  const sheet = box(".form.refill");
  for (const s of [".axis", ".today span"]) if (box(s).right > sheet.right + 1) faults.push(`${s} passes the right margin`);
  for (const e of document.querySelectorAll(".say dd, .say dt")) {
    const t = textBox(e);
    const b = e.getBoundingClientRect();
    if (t.width && (t.right > b.right - 4 || t.left < b.left)) faults.push(`clipped: ${e.textContent}`);
  }
  for (const e of document.querySelectorAll(".say > div")) if (e.getBoundingClientRect().right > sheet.right) faults.push(`wider than the form: ${e.textContent}`);
  const apart = [["h1", ".form.say"], ["h1", ".big"], [".lede", ".cells"], [".big", ".today span"], [".name", ".copies"], [".cell:nth-child(2) .stamp", ".today"], [".cell:nth-child(2) b", ".cell:nth-child(2) .stamp"]];
  for (const [p, q] of apart) {
    const a = box(p);
    const b = box(q);
    if (a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) faults.push(`${p} touches ${q}`);
  }
  return faults;
}

/** Runs in the page: re-encodes the screenshot, so no image library is needed. */
async function toWebp(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/webp", 0.92).split(",")[1];
}

const browser = await chromium.launch({ channel: "msedge", args: ["--disable-lcd-text"] });
try {
  for (const { name, copy, theme, variant = "banner", width = 1600, height = 640, scale = 2 } of JOBS) {
    if (only && !only.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    page.on("pageerror", (e) => console.error(name, e.message));
    await page.addInitScript((b) => (window.BANNER = b), { copy, theme, variant, strip });
    await page.goto(new URL("banner.html", out).href);
    await page.evaluate(() => document.fonts.ready);
    const faults = await page.evaluate(faultsIn);
    if (faults.length) {
      process.exitCode = 1;
      console.error(`${name}: ${faults.join("; ")}`);
    }
    const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
    const files = { png };
    if (variant === "banner") files.webp = Buffer.from(await page.evaluate(toWebp, `data:image/png;base64,${png.toString("base64")}`), "base64");
    for (const [ext, data] of Object.entries(files)) {
      writeFileSync(new URL(`${name}.${ext}`, out), data);
      console.log(`${name}.${ext}  ${Math.round(data.length / 1024)} KB`);
      if (data.length > LIMIT) {
        process.exitCode = 1;
        console.error(`${name}.${ext} is over 600 KB`);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
