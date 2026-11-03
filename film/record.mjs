/**
 * Records the Mandate demo film: a real browser driving the real console.
 * Each scene is marked at its first visible frame; narration is laid under
 * those marks afterwards.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/root/earn-ops/video-tools/");
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
const BASE = process.env.BASE ?? "http://127.0.0.1:8791";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: RAW, size: { width: 1600, height: 900 } },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

// Visible cursor and click rings so the recording reads as a live demo.
await page.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent = `
    #demo-cursor { position: fixed; width: 15px; height: 15px; border-radius: 50%;
      background: #4cc2ff; box-shadow: 0 0 0 3px #4cc2ff33, 0 0 16px #4cc2ff88;
      pointer-events: none; z-index: 2147483647; margin: -7.5px 0 0 -7.5px; }
    .demo-ring { position: fixed; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid #4cc2ff; pointer-events: none; z-index: 2147483646;
      margin: -6px 0 0 -6px; animation: demo-ring .55s ease-out forwards; }
    @keyframes demo-ring { from { transform: scale(.6); opacity: 1; } to { transform: scale(3.6); opacity: 0; } }
  `;
  const boot = () => {
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    document.body.appendChild(cursor);
    document.addEventListener("mousemove", (e) => {
      cursor.style.left = e.clientX + "px";
      cursor.style.top = e.clientY + "px";
    });
    document.addEventListener("mousedown", (e) => {
      const ring = document.createElement("div");
      ring.className = "demo-ring";
      ring.style.left = e.clientX + "px";
      ring.style.top = e.clientY + "px";
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
});

// Scene lengths come from the narration clips.
const DUR = { s1: 15.8, s2: 15.6, s3: 16.5, s4: 14.3, s5: 18.1, s6: 14.3, s7: 14.6 };
const marks = [];
const t0 = Date.now();
const mark = (name) => {
  const at = Date.now() - t0;
  marks.push({ name, at_ms: at });
  return at + DUR[name] * 1000;
};
const hold = async (end) => {
  const left = end - (Date.now() - t0);
  if (left > 0) await sleep(left);
};

const moveTo = async (selector, ms = 400) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
  await sleep(ms);
};

// Scene 1 — title
await page.goto(`file://${join(HERE, "title.html")}`, { waitUntil: "domcontentloaded" });
await page.mouse.move(800, 460);
let sceneEnd = mark("s1");
await sleep(600);
await moveTo(".mark", 300);
await hold(sceneEnd);

// Scene 2 — the console, the mandate, the ledger
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".ag-row");
await sleep(700);
sceneEnd = mark("s2");
await moveTo("#s-captured", 800);
await moveTo("#mandate", 1100);
await moveTo("#intents", 700);
await hold(sceneEnd);

// Scene 3 — inside the mandate: allow, order, capture
sceneEnd = mark("s3");
await page.fill("#amount", "1500");
await page.fill("#description", "API credits, 1M tokens");
await page.selectOption("#merchant", "cloudstore");
await page.selectOption("#category", "software");
await sleep(500);
await moveTo("#buy", 200);
await page.click("#buy");
await page.waitForFunction(() => document.getElementById("decision").textContent.includes("ALLOW"));
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await sleep(900);
await moveTo("#decision", 1200);
await page.locator("button[data-pay]").first().click();
await page.waitForFunction(() => document.getElementById("s-captured").textContent !== "$0.00");
await sleep(600);
await moveTo("#ledger", 600);
await hold(sceneEnd);

// Scene 4 — over the per-transaction cap: denied before PayPal
sceneEnd = mark("s4");
await page.selectOption("#merchant", "cloudstore");
await page.selectOption("#category", "hardware");
await page.fill("#amount", "8900");
await page.fill("#description", "1TB NVMe SSD");
await sleep(500);
await moveTo("#buy", 200);
await page.click("#buy");
await page.waitForFunction(() => document.getElementById("decision").textContent.includes("DENY"));
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await moveTo("#decision", 900);
await hold(sceneEnd);

// Scene 5 — above the threshold: a human approves, then it is paid
sceneEnd = mark("s5");
await page.selectOption("#merchant", "northwind-supply");
await page.selectOption("#category", "office");
await page.fill("#amount", "4200");
await page.fill("#description", "Black toner cartridge");
await sleep(500);
await moveTo("#buy", 200);
await page.click("#buy");
await page.waitForFunction(() => document.getElementById("decision").textContent.includes("ESCALATE"));
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await sleep(900);
await page.locator("button[data-approve]").first().click();
await page.waitForSelector("#modal.open");
await sleep(700);
await moveTo("#modal-token", 2600);
await moveTo("#modal-fulfill", 500);
await page.click("#modal-fulfill");
await page.waitForFunction(() => !document.getElementById("modal").classList.contains("open"));
await sleep(400);
await moveTo("#intents", 500);
await hold(sceneEnd);

// Scene 6 — the hash-chained audit trail
sceneEnd = mark("s6");
await page.locator("#audit").scrollIntoViewIfNeeded();
await page.mouse.move(760, 300, { steps: 10 });
await sleep(600);
await moveTo(".ag-center-cols-container .ag-row", 1400);
await hold(sceneEnd);

// Scene 7 — end card
await page.goto(`file://${join(HERE, "end.html")}`, { waitUntil: "domcontentloaded" });
sceneEnd = mark("s7");
await page.mouse.move(800, 450, { steps: 8 });
await hold(sceneEnd);

const video = page.video();
await context.close();
await browser.close();

const path = await video.path();
writeFileSync(join(HERE, "timings.json"), JSON.stringify({ video: path, marks, total_ms: Date.now() - t0 }, null, 2));
console.log("video:", path);
console.log(marks.map((m) => `${m.name} @ ${(m.at_ms / 1000).toFixed(2)}s`).join("\n"));
console.log("total", ((Date.now() - t0) / 1000).toFixed(2), "s");
