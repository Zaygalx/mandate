#!/usr/bin/env node
/**
 * Mandate MCP server (stdio transport, newline-delimited JSON-RPC 2.0).
 *
 * Any MCP-capable agent (Claude Desktop, Cursor, Hermes, a custom loop) can
 * discover these tools and attempt purchases. Every attempt passes through the
 * same deterministic policy engine the HTTP console uses; nothing bypasses it.
 *
 * stdout is reserved for protocol frames. All diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { openDatabase } from "./db.mjs";
import { createPayPal } from "./paypal.mjs";
import { createService } from "./service.mjs";
import { CATALOG } from "./server.mjs";

const log = (...args) => console.error("[mandate-mcp]", ...args);

const db = openDatabase(process.env.MANDATE_DB ?? "mandate.db");
const service = createService({ db, paypal: createPayPal({ mode: process.env.PAYPAL_MODE ?? "mock" }) });

const TOOLS = [
  {
    name: "get_spend_mandate",
    description:
      "Return the active spend mandate for an agent: per-transaction cap, daily cap, approval threshold, allowed merchants and categories. Call this before buying anything.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
    },
  },
  {
    name: "search_catalog",
    description: "Search the demo merchant catalog for a product to buy. Returns sku, merchant, category and price in cents.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "purchase",
    description:
      "Attempt a purchase under the agent's mandate. Returns status approved (already paid), awaiting_approval (a human must approve in the console, then call fulfill_purchase with the token) or denied (policy refused, no payment made).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        merchant: { type: "string" },
        category: { type: "string" },
        amount_cents: { type: "integer", minimum: 1 },
        description: { type: "string" },
      },
      required: ["agent_id", "merchant", "category", "amount_cents"],
    },
  },
  {
    name: "fulfill_purchase",
    description:
      "Complete a purchase that was escalated for human approval. Requires the approval token shown to the human in the console.",
    inputSchema: {
      type: "object",
      properties: {
        intent_id: { type: "string" },
        approval_token: { type: "string" },
      },
      required: ["intent_id", "approval_token"],
    },
  },
  {
    name: "refund_purchase",
    description: "Refund a captured purchase in full, or partially with amount_cents.",
    inputSchema: {
      type: "object",
      properties: { intent_id: { type: "string" }, amount_cents: { type: "integer" } },
      required: ["intent_id"],
    },
  },
  {
    name: "spending_summary",
    description: "Summarise captured spend, refunds, pending approvals and denied attempts for an agent.",
    inputSchema: { type: "object", properties: { agent_id: { type: "string" } } },
  },
];

const handlers = {
  async get_spend_mandate({ agent_id }) {
    const mandates = service.state().mandates.filter((m) => m.agent_id === agent_id && m.active);
    if (!mandates.length) return { content: [{ type: "text", text: `No active mandate for ${agent_id}.` }], isError: true };
    return textResult(mandates[0]);
  },

  async search_catalog({ query = "" }) {
    const q = query.toLowerCase();
    const products = CATALOG.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.merchant.includes(q) || p.category.includes(q)
    );
    return textResult({ products });
  },

  async purchase(input) {
    const { intent, decision } = service.requestIntent(input);
    if (decision.outcome === "deny") {
      return textResult({
        status: "denied",
        intent_id: intent.id,
        code: decision.code,
        reason: decision.reason,
        paid: false,
      });
    }
    if (decision.outcome === "escalate") {
      return textResult({
        status: "awaiting_approval",
        intent_id: intent.id,
        code: decision.code,
        reason: decision.reason,
        next: "A human must approve this in the console, then call fulfill_purchase with the token.",
        paid: false,
      });
    }
    const fulfilled = await service.fulfillIntent(intent.id);
    return textResult({
      status: fulfilled.status,
      intent_id: fulfilled.id,
      order_id: fulfilled.order_id,
      capture_id: fulfilled.capture_id,
      amount_cents: fulfilled.amount_cents,
      paid: fulfilled.status === "captured",
    });
  },

  async fulfill_purchase({ intent_id, approval_token }) {
    const intent = await service.fulfillIntent(intent_id, approval_token);
    return textResult({ status: intent.status, intent_id: intent.id, capture_id: intent.capture_id, paid: true });
  },

  async refund_purchase({ intent_id, amount_cents }) {
    const intent = await service.refundIntent(intent_id, amount_cents);
    return textResult({ status: intent.status, intent_id: intent.id });
  },

  async spending_summary({ agent_id }) {
    const state = service.state();
    const mine = state.intents.filter((i) => !agent_id || i.agent_id === agent_id);
    const sum = (status) => mine.filter((i) => i.status === status).reduce((n, i) => n + i.amount_cents, 0);
    return textResult({
      captured_cents: sum("captured"),
      refunded_cents: sum("refunded"),
      awaiting_approval: mine.filter((i) => i.status === "awaiting_approval").length,
      denied: mine.filter((i) => i.status === "denied").length,
      integrity: state.integrity,
    });
  },
};

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("invalid JSON frame");
    return;
  }
  const { id, method, params } = msg;

  let toolName = null;
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mandate", version: "1.0.0" },
        },
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

    if (method === "tools/call") {
      toolName = params?.name;
      const handler = handlers[toolName];
      if (!handler) {
        return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${toolName}` } });
      }
      const result = await handler(params.arguments ?? {});
      return send({ jsonrpc: "2.0", id, result });
    }

    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    log(toolName ?? method, "error", err.message);
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true },
      });
    }
  }
});

log("ready; tools:", TOOLS.map((t) => t.name).join(", "));
