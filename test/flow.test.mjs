import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.mjs";
import { verifyAuditChain } from "../src/db.mjs";

let server, base, db;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-test-"));
  const app = buildApp({ dbPath: join(dir, "test.db"), mode: "mock" });
  db = app.db;
  server = app.server;
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const get = async (path) => (await (await fetch(base + path)).json()).body ?? (await (await fetch(base + path)).json());

test("denies a merchant outside the allowlist without calling PayPal", async () => {
  const r = await post("/api/intents", {
    agent_id: "procurement-agent",
    merchant: "acme-furniture",
    category: "furniture",
    amount_cents: 24900,
    description: "chair",
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.decision.outcome, "deny");
  assert.equal(r.body.decision.code, "MERCHANT_NOT_ALLOWED");
  assert.equal(r.body.intent.status, "denied");
  const txns = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE intent_id = ?").get(r.body.intent.id);
  assert.equal(txns.n, 0);
});

test("allows, orders and captures a purchase inside the mandate", async () => {
  const r = await post("/api/intents", {
    agent_id: "procurement-agent",
    merchant: "cloudstore",
    category: "software",
    amount_cents: 1500,
    description: "API credits",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.decision.outcome, "allow");

  const f = await post(`/api/intents/${r.body.intent.id}/fulfill`, {});
  assert.equal(f.status, 200);
  assert.equal(f.body.intent.status, "captured");
  assert.match(f.body.intent.order_id, /^MOCK-ORDER-/);
  assert.match(f.body.intent.capture_id, /^MOCK-CAPTURE-/);

  const txns = db.prepare("SELECT kind FROM transactions WHERE intent_id = ? ORDER BY created_at").all(r.body.intent.id);
  assert.deepEqual(txns.map((t) => t.kind), ["order", "capture"]);
});

test("escalates above the threshold, requires approval, and burns the token", async () => {
  const r = await post("/api/intents", {
    agent_id: "procurement-agent",
    merchant: "northwind-supply",
    category: "office",
    amount_cents: 4200,
    description: "toner",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.decision.outcome, "escalate");
  assert.equal(r.body.intent.status, "awaiting_approval");

  // Fulfilling without a token is refused.
  const noToken = await post(`/api/intents/${r.body.intent.id}/fulfill`, {});
  assert.equal(noToken.status, 400);

  // Wrong token is refused.
  const wrong = await post(`/api/intents/${r.body.intent.id}/fulfill`, { token: "0".repeat(48) });
  assert.equal(wrong.status, 403);

  const approval = await post(`/api/intents/${r.body.intent.id}/approve`, { approved_by: "hassan" });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.token.length, 48);

  const ok = await post(`/api/intents/${r.body.intent.id}/fulfill`, { token: approval.body.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.intent.status, "captured");

  const replay = await post(`/api/intents/${r.body.intent.id}/fulfill`, { token: approval.body.token });
  assert.equal(replay.status, 400);
  assert.match(replay.body.error, /captured|only approved/);
  const approvals = db
    .prepare("SELECT used_at FROM approvals WHERE intent_id = ?")
    .all(r.body.intent.id);
  assert.ok(approvals.length === 1 && approvals[0].used_at, "approval token must be marked used");
});

test("refunds a captured payment and records it in the ledger", async () => {
  const list = await (await fetch(base + "/api/state")).json();
  const target = list.intents.find((i) => i.status === "captured" && i.amount_cents === 4200);
  assert.ok(target, "expected the escalated purchase to be captured");

  const r = await post(`/api/intents/${target.id}/refund`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.intent.status, "refunded");

  const state = await (await fetch(base + "/api/state")).json();
  assert.equal(state.totals.refunded_cents, 4200);
  assert.ok(state.transactions.some((t) => t.kind === "refund" && t.intent_id === target.id));
});

test("audit chain verifies and detects tampering", async () => {
  assert.equal(verifyAuditChain(db).ok, true);
  db.prepare("UPDATE audit SET detail = '{\"tampered\":true}' WHERE id = 1").run();
  const broken = verifyAuditChain(db);
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);
});

test("state reports totals, integrity and the driver", async () => {
  const state = await (await fetch(base + "/api/state")).json();
  assert.equal(state.driver, "mock");
  assert.ok(state.mandates.length >= 1);
  assert.ok(state.totals.captured_cents >= 1500);
  assert.ok(state.audit.length > 0);
});
