import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, createMandate } from "../src/db.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mandate-mcp-test-"));
const dbPath = join(dir, "mcp.db");

const db = openDatabase(dbPath);
createMandate(db, {
  agent_id: "test-agent",
  name: "MCP test mandate",
  per_tx_cap_cents: 2000,
  daily_cap_cents: 5000,
  approval_threshold_cents: 1000,
  velocity_per_hour: 5,
  merchant_allowlist: ["cloudstore"],
  category_allowlist: ["software"],
});

const child = spawn(process.execPath, [join(ROOT, "src/mcp.mjs")], {
  env: { ...process.env, MANDATE_DB: dbPath, PAYPAL_MODE: "mock" },
  stdio: ["pipe", "pipe", "pipe"],
});
after(() => child.kill());

const pending = new Map();
let nextId = 1;

child.stdout.on("data", (buf) => {
  for (const line of buf.toString().split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.on("data", () => {});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const call = async (name, args = {}) => {
  const msg = await rpc("tools/call", { name, arguments: args });
  assert.ok(msg.result, `missing result for ${name}: ${JSON.stringify(msg)}`);
  return JSON.parse(msg.result.content[0].text);
};

test("MCP handshake exposes the spend tools", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.equal(init.result.serverInfo.name, "mandate");
  assert.ok(init.result.capabilities.tools);

  const list = await rpc("tools/list");
  const names = list.result.tools.map((t) => t.name);
  for (const expected of ["get_spend_mandate", "purchase", "fulfill_purchase", "refund_purchase", "spending_summary"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test("agent reads its mandate and sees the real limits", async () => {
  const mandate = await call("get_spend_mandate", { agent_id: "test-agent" });
  assert.equal(mandate.per_tx_cap_cents, 2000);
  assert.equal(mandate.approval_threshold_cents, 1000);
  assert.deepEqual(mandate.merchant_allowlist, ["cloudstore"]);
});

test("purchase inside the mandate is paid immediately", async () => {
  const result = await call("purchase", {
    agent_id: "test-agent",
    merchant: "cloudstore",
    category: "software",
    amount_cents: 500,
    description: "API credits",
  });
  assert.equal(result.status, "captured");
  assert.equal(result.paid, true);
  assert.match(result.capture_id, /^MOCK-CAPTURE-/);
});

test("purchase above the threshold returns awaiting_approval, not a payment", async () => {
  const result = await call("purchase", {
    agent_id: "test-agent",
    merchant: "cloudstore",
    category: "software",
    amount_cents: 1500,
    description: "GPU hour",
  });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.paid, false);
  assert.equal(result.code, "APPROVAL_REQUIRED");
});

test("purchase outside the allowlist is denied without a payment", async () => {
  const result = await call("purchase", {
    agent_id: "test-agent",
    merchant: "acme-furniture",
    category: "furniture",
    amount_cents: 100,
    description: "chair",
  });
  assert.equal(result.status, "denied");
  assert.equal(result.paid, false);
  assert.equal(result.code, "MERCHANT_NOT_ALLOWED");
});

test("spending summary reflects the ledger", async () => {
  const summary = await call("spending_summary", { agent_id: "test-agent" });
  assert.equal(summary.captured_cents, 500);
  assert.equal(summary.awaiting_approval, 1);
  assert.equal(summary.denied, 1);
  assert.equal(summary.integrity.ok, true);
});
