import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, RULES, OUTCOME } from "../src/policy.mjs";

const mandate = {
  id: "man_test",
  agent_id: "procurement-agent",
  currency: "USD",
  per_tx_cap_cents: 5000,
  daily_cap_cents: 15000,
  approval_threshold_cents: 2000,
  velocity_per_hour: 12,
  merchant_allowlist: ["northwind-supply", "cloudstore"],
  category_allowlist: ["office", "software"],
  active: true,
};

const intent = { merchant: "cloudstore", category: "software", amount_cents: 1500, currency: "USD" };

test("allows a purchase inside every limit", () => {
  const d = evaluate({ mandate, intent });
  assert.equal(d.outcome, OUTCOME.ALLOW);
  assert.equal(d.code, RULES.WITHIN_LIMITS);
});

test("denies without a mandate", () => {
  const d = evaluate({ mandate: null, intent });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.NO_MANDATE);
});

test("denies an inactive mandate", () => {
  const d = evaluate({ mandate: { ...mandate, active: false }, intent });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.INACTIVE);
});

test("denies a merchant outside the allowlist", () => {
  const d = evaluate({ mandate, intent: { ...intent, merchant: "acme-furniture" } });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.MERCHANT_NOT_ALLOWED);
});

test("denies a category outside the allowlist", () => {
  const d = evaluate({ mandate, intent: { ...intent, category: "furniture" } });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.CATEGORY_NOT_ALLOWED);
});

test("denies above the per transaction cap", () => {
  const d = evaluate({ mandate, intent: { ...intent, amount_cents: 5001 } });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.PER_TX_CAP);
});

test("allows exactly the per transaction cap", () => {
  const d = evaluate({ mandate, intent: { ...intent, amount_cents: 5000 } });
  assert.notEqual(d.code, RULES.PER_TX_CAP);
});

test("denies when the daily cap would be exceeded", () => {
  const d = evaluate({ mandate, intent: { ...intent, amount_cents: 1500 }, spent_today_cents: 14000 });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.DAILY_CAP);
});

test("denies at the velocity limit", () => {
  const d = evaluate({ mandate, intent, intents_last_hour: 12 });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.VELOCITY);
});

test("escalates above the approval threshold but inside the cap", () => {
  const d = evaluate({ mandate, intent: { ...intent, amount_cents: 2001 } });
  assert.equal(d.outcome, OUTCOME.ESCALATE);
  assert.equal(d.code, RULES.APPROVAL_REQUIRED);
});

test("does not escalate at the threshold itself", () => {
  const d = evaluate({ mandate, intent: { ...intent, amount_cents: 2000 } });
  assert.equal(d.outcome, OUTCOME.ALLOW);
});

test("rejects non-integer and non-positive amounts", () => {
  for (const amount_cents of [0, -5, 10.5, Number.NaN]) {
    const d = evaluate({ mandate, intent: { ...intent, amount_cents } });
    assert.equal(d.outcome, OUTCOME.DENY);
    assert.equal(d.code, RULES.INVALID_AMOUNT);
  }
});

test("rejects a currency mismatch", () => {
  const d = evaluate({ mandate, intent: { ...intent, currency: "EUR" } });
  assert.equal(d.outcome, OUTCOME.DENY);
  assert.equal(d.code, RULES.CURRENCY_MISMATCH);
});
