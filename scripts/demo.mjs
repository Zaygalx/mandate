#!/usr/bin/env node
/**
 * End-to-end demo against an in-process server and the mock PayPal driver.
 *  node scripts/demo.mjs            (mock, no credentials)
 *  PAYPAL_MODE=sandbox node scripts/demo.mjs   (real sandbox, needs credentials)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.mjs";
import { money } from "../src/policy.mjs";

const dir = mkdtempSync(join(tmpdir(), "mandate-demo-"));
const { server } = buildApp({ dbPath: join(dir, "demo.db"), mode: process.env.PAYPAL_MODE ?? "mock" });

await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const line = (s) => console.log(s);
const rule = () => line("─".repeat(78));

line("");
line("MANDATE DEMO — an AI agent tries to buy things with a company card");
line(`driver: ${process.env.PAYPAL_MODE ?? "mock"}   console: ${base}`);
rule();

const agent = "procurement-agent";
const buy = (merchant, category, amount_cents, description) =>
  post("/api/intents", { agent_id: agent, merchant, category, amount_cents, description });

// 1. Inside the mandate.
let r = await buy("cloudstore", "software", 1500, "API credits, 1M tokens");
line(`1. agent buys API credits for ${money(1500)} at cloudstore`);
line(`   policy: ${r.body.decision.outcome.toUpperCase()} (${r.body.decision.code})`);
if (r.body.decision.outcome === "allow") {
  const f = await post(`/api/intents/${r.body.intent.id}/fulfill`, {});
  line(`   fulfilled: ${f.body.intent.status}, capture ${f.body.intent.capture_id}`);
}
rule();

// 2. Over the per-transaction cap.
r = await buy("cloudstore", "hardware", 8900, "1TB NVMe SSD");
line(`2. agent tries a ${money(8900)} SSD`);
line(`   policy: ${r.body.decision.outcome.toUpperCase()} (${r.body.decision.code})`);
line(`   ${r.body.decision.reason}`);
rule();

// 3. Merchant not on the allowlist.
r = await buy("acme-furniture", "furniture", 24900, "Ergonomic task chair");
line(`3. agent tries a ${money(24900)} chair from an unapproved merchant`);
line(`   policy: ${r.body.decision.outcome.toUpperCase()} (${r.body.decision.code})`);
line(`   ${r.body.decision.reason}`);
rule();

// 4. Above the approval threshold: a human decides.
r = await buy("northwind-supply", "office", 4200, "Black toner cartridge");
line(`4. agent needs a ${money(4200)} toner cartridge`);
line(`   policy: ${r.body.decision.outcome.toUpperCase()} (${r.body.decision.code})`);
const intentId = r.body.intent.id;
const approval = await post(`/api/intents/${intentId}/approve`, { approved_by: "hassan" });
line(`   human approves; single-use token issued, expires ${approval.body.expires_at}`);
const replay = await post(`/api/intents/${intentId}/fulfill`, { token: approval.body.token });
line(`   agent fulfils: ${replay.body.intent.status}, capture ${replay.body.intent.capture_id}`);
const second = await post(`/api/intents/${intentId}/fulfill`, { token: approval.body.token });
line(`   token replayed: HTTP ${second.status} (${second.body.error ?? "accepted — BUG"})`);
rule();

// 5. Refund.
const refund = await post(`/api/intents/${intentId}/refund`, {});
line(`5. refund issued: ${refund.body.intent.status}`);
rule();

const state = (await (await fetch(base + "/api/state")).json());
line(`captured ${money(state.totals.captured_cents)} · refunded ${money(state.totals.refunded_cents)} · denied ${state.totals.denied} · pending ${state.totals.awaiting_approval}`);
line(`audit chain: ${state.integrity.ok ? `verified (${state.integrity.length} entries)` : "BROKEN at " + state.integrity.brokenAt}`);
line("");
line("Every decision, order, capture and refund above is in the ledger and the");
line("hash-chained audit trail shown in the console.");
line("");

server.close();
