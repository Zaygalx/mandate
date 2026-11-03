import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  addTransaction,
  appendAudit,
  createIntent,
  findMandateForAgent,
  getIntent,
  getMandate,
  intentsLastHour,
  listAudit,
  listIntents,
  listMandates,
  listTransactions,
  spentTodayCents,
  updateIntent,
  verifyAuditChain,
} from "./db.mjs";
import { evaluate, money } from "./policy.mjs";

const APPROVAL_TTL_MS = 15 * 60 * 1000;

export function createService({ db, paypal }) {
  function requestIntent(input) {
    const mandate = input.mandate_id
      ? getMandate(db, input.mandate_id)
      : findMandateForAgent(db, input.agent_id);

    const decision = evaluate({
      mandate,
      intent: input,
      spent_today_cents: mandate ? spentTodayCents(db, input.agent_id) : 0,
      intents_last_hour: mandate ? intentsLastHour(db, input.agent_id) : 0,
    });

    const status =
      decision.outcome === "deny" ? "denied" : decision.outcome === "escalate" ? "awaiting_approval" : "approved";

    const intent = createIntent(db, {
      mandate_id: mandate?.id ?? null,
      agent_id: input.agent_id,
      merchant: input.merchant,
      category: input.category,
      amount_cents: Number(input.amount_cents),
      currency: input.currency ?? "USD",
      description: input.description ?? "",
      status,
      reason_code: decision.code,
      reason: decision.reason,
    });

    appendAudit(db, {
      actor: `agent:${input.agent_id}`,
      action: "purchase.requested",
      subject: intent.id,
      detail: {
        merchant: intent.merchant,
        amount_cents: intent.amount_cents,
        outcome: decision.outcome,
        code: decision.code,
      },
    });

    return { intent, decision };
  }

  function approveIntent(id, approvedBy = "owner") {
    const intent = getIntent(db, id);
    if (!intent) throw notFound(`Intent ${id} not found`);
    if (intent.status !== "awaiting_approval") {
      throw badRequest(`Intent ${id} is ${intent.status}, not awaiting approval`);
    }
    const token = randomBytes(24).toString("hex");
    const approvalId = `apr_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    db.prepare(
      "INSERT INTO approvals (id, intent_id, token_hash, approved_by, expires_at, created_at) VALUES (?,?,?,?,?,?)"
    ).run(approvalId, id, sha256(token), approvedBy, expiresAt, new Date().toISOString());
    updateIntent(db, id, { approval_id: approvalId });
    appendAudit(db, {
      actor: `human:${approvedBy}`,
      action: "purchase.approved",
      subject: id,
      detail: { amount_cents: intent.amount_cents, merchant: intent.merchant, expires_at: expiresAt },
    });
    return { intent: getIntent(db, id), token, expires_at: expiresAt };
  }

  async function fulfillIntent(id, token) {
    let intent = getIntent(db, id);
    if (!intent) throw notFound(`Intent ${id} not found`);

    if (intent.status === "awaiting_approval") {
      if (!token) throw badRequest("This intent needs human approval. Pass the approval token.");
      const approval = db
        .prepare("SELECT * FROM approvals WHERE intent_id = ? AND token_hash = ? ORDER BY created_at DESC LIMIT 1")
        .get(id, sha256(token));
      if (!approval) throw forbidden("Approval token does not match this intent");
      if (approval.used_at) throw forbidden("Approval token already used");
      if (new Date(approval.expires_at).getTime() < Date.now()) throw forbidden("Approval token expired");
      db.prepare("UPDATE approvals SET used_at = ? WHERE id = ?").run(new Date().toISOString(), approval.id);
      intent = updateIntent(db, id, { status: "approved", approval_id: approval.id });
      appendAudit(db, { actor: "system", action: "approval.consumed", subject: id, detail: { approval_id: approval.id } });
    }

    if (intent.status !== "approved") {
      throw badRequest(`Intent ${id} is ${intent.status}; only approved intents can be fulfilled`);
    }

    if (!intent.order_id) {
      const order = await paypal.createOrder({
        intent: intent.id,
        amount_cents: intent.amount_cents,
        currency: intent.currency,
        merchant: intent.merchant,
        description: intent.description || `${intent.merchant} purchase`,
      });
      intent = updateIntent(db, id, { order_id: order.id });
      addTransaction(db, {
        intent_id: id,
        kind: "order",
        provider_id: order.id,
        amount_cents: intent.amount_cents,
        currency: intent.currency,
        status: order.status,
        raw: order.raw,
      });
      appendAudit(db, { actor: "system", action: "paypal.order.created", subject: id, detail: { order_id: order.id } });
    }

    const capture = await paypal.captureOrder(intent.order_id);
    addTransaction(db, {
      intent_id: id,
      kind: "capture",
      provider_id: capture.id,
      amount_cents: capture.amount_cents,
      currency: capture.currency,
      status: capture.status,
      raw: capture.raw,
    });
    intent = updateIntent(db, id, { status: "captured", capture_id: capture.id });
    appendAudit(db, {
      actor: "system",
      action: "paypal.capture.completed",
      subject: id,
      detail: { capture_id: capture.id, amount_cents: capture.amount_cents },
    });
    return intent;
  }

  async function refundIntent(id, amountCents) {
    const intent = getIntent(db, id);
    if (!intent) throw notFound(`Intent ${id} not found`);
    if (!intent.capture_id) throw badRequest(`Intent ${id} has no capture to refund`);
    const refund = await paypal.refundCapture(intent.capture_id, amountCents);
    addTransaction(db, {
      intent_id: id,
      kind: "refund",
      provider_id: refund.id,
      amount_cents: refund.amount_cents,
      currency: refund.currency,
      status: refund.status,
      raw: refund.raw,
    });
    const updated = updateIntent(db, id, { status: "refunded" });
    appendAudit(db, {
      actor: "system",
      action: "paypal.refund.completed",
      subject: id,
      detail: { refund_id: refund.id, amount_cents: refund.amount_cents },
    });
    return updated;
  }

  function state() {
    const intents = listIntents(db);
    const transactions = listTransactions(db);
    const captured = intents.filter((i) => i.status === "captured");
    const refunded = intents.filter((i) => i.status === "refunded");
    return {
      mandates: listMandates(db),
      intents,
      transactions,
      audit: listAudit(db, 100),
      integrity: verifyAuditChain(db),
      totals: {
        captured_cents: captured.reduce((n, i) => n + i.amount_cents, 0),
        refunded_cents: refunded.reduce((n, i) => n + i.amount_cents, 0),
        awaiting_approval: intents.filter((i) => i.status === "awaiting_approval").length,
        denied: intents.filter((i) => i.status === "denied").length,
      },
      driver: paypal.driver,
    };
  }

  return { requestIntent, approveIntent, fulfillIntent, refundIntent, state, money };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (m) => new HttpError(400, m);
const forbidden = (m) => new HttpError(403, m);
const notFound = (m) => new HttpError(404, m);
export { HttpError };
