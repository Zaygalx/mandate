import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, createMandate, findMandateForAgent, appendAudit } from "./db.mjs";
import { createPayPal } from "./paypal.mjs";
import { createService, HttpError } from "./service.mjs";
import { evaluate } from "./policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.MANDATE_DB ?? join(ROOT, "mandate.db");

export const CATALOG = [
  { sku: "PAPER-A4-500", name: "A4 paper, 500 sheets", merchant: "northwind-supply", category: "office", amount_cents: 799 },
  { sku: "TONER-BLK", name: "Black toner cartridge", merchant: "northwind-supply", category: "office", amount_cents: 4200 },
  { sku: "SSD-1TB", name: "1TB NVMe SSD", merchant: "cloudstore", category: "hardware", amount_cents: 8900 },
  { sku: "API-CREDITS", name: "API credits, 1M tokens", merchant: "cloudstore", category: "software", amount_cents: 1500 },
  { sku: "DESK-CHAIR", name: "Ergonomic task chair", merchant: "acme-furniture", category: "furniture", amount_cents: 24900 },
  { sku: "COFFEE-1KG", name: "Coffee beans, 1kg", merchant: "northwind-supply", category: "office", amount_cents: 2400 },
  { sku: "DOMAIN-1Y", name: "Domain renewal, 1 year", merchant: "cloudstore", category: "software", amount_cents: 1200 },
  { sku: "GPU-HOUR", name: "GPU hour, A10", merchant: "cloudstore", category: "compute", amount_cents: 110 },
];

export function buildApp({ dbPath = DB_PATH, mode = process.env.PAYPAL_MODE ?? "mock", seed = true } = {}) {
  const db = openDatabase(dbPath);
  const paypal = createPayPal({ mode });
  const service = createService({ db, paypal });

  if (seed && db.prepare("SELECT COUNT(*) AS n FROM mandates").get().n === 0) {
    createMandate(db, {
      agent_id: "procurement-agent",
      name: "Procurement agent, Q4",
      currency: "USD",
      per_tx_cap_cents: 5000,
      daily_cap_cents: 15000,
      approval_threshold_cents: 2000,
      velocity_per_hour: 12,
      merchant_allowlist: ["northwind-supply", "cloudstore"],
      category_allowlist: ["office", "software", "hardware"],
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, { db, service });
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      json(res, status, { error: err.message ?? "internal error" });
    }
  });

  return { server, db, service, paypal };
}

async function handleApi(req, res, url, { db, service }) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, service.state());
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const rows = CATALOG.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.merchant.includes(q) || p.category.includes(q)
    );
    return json(res, 200, { products: rows });
  }
  if (req.method === "GET" && url.pathname === "/api/mandates") {
    return json(res, 200, { mandates: service.state().mandates });
  }
  if (req.method === "POST" && url.pathname === "/api/mandates") {
    const body = await readJson(req);
    const mandate = createMandate(db, body);
    appendAudit(db, { actor: "owner", action: "mandate.created", subject: mandate.id, detail: { via: "http" } });
    return json(res, 201, { mandate });
  }
  if (req.method === "POST" && url.pathname === "/api/intents") {
    const body = await readJson(req);
    const { intent, decision } = service.requestIntent(body);
    return json(res, decision.outcome === "deny" ? 422 : 201, { intent, decision });
  }
  if (req.method === "POST" && parts[1] === "intents" && parts[3] === "approve") {
    const body = await readJson(req);
    return json(res, 200, service.approveIntent(parts[2], body.approved_by ?? "owner"));
  }
  if (req.method === "POST" && parts[1] === "intents" && parts[3] === "fulfill") {
    const body = await readJson(req);
    return json(res, 200, { intent: await service.fulfillIntent(parts[2], body.token) });
  }
  if (req.method === "POST" && parts[1] === "intents" && parts[3] === "refund") {
    const body = await readJson(req);
    return json(res, 200, { intent: await service.refundIntent(parts[2], body.amount_cents) });
  }
  if (req.method === "POST" && url.pathname === "/api/simulate") {
    const body = await readJson(req);
    const mandate = body.mandate_id
      ? service.state().mandates.find((m) => m.id === body.mandate_id)
      : findMandateForAgent(db, body.agent_id ?? "procurement-agent");
    const decision = evaluate({
      mandate,
      intent: { merchant: body.merchant, category: body.category, amount_cents: Number(body.amount_cents) },
      spent_today_cents: Number(body.spent_today_cents ?? 0),
      intents_last_hour: Number(body.intents_last_hour ?? 0),
    });
    return json(res, 200, { decision });
  }
  return json(res, 404, { error: "not found" });
}

async function serveStatic(res, pathname) {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(PUBLIC, safe === "/" ? "index.html" : safe);
  if (!existsSync(file)) file = join(PUBLIC, "index.html");
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": contentType(extname(file)) });
  res.end(body);
}

function contentType(ext) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[ext] ?? "application/octet-stream"
  );
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = buildApp();
  server.listen(PORT, () => {
    console.log(`Mandate console on http://localhost:${PORT} (PayPal driver: ${process.env.PAYPAL_MODE ?? "mock"})`);
  });
}
