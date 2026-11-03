/**
 * Deterministic spend policy. Every payment an agent attempts is evaluated here
 * before any PayPal call is made. The policy is intentionally boring: explicit
 * caps, explicit allowlists, explicit escalation. No model is consulted.
 */

export const RULES = {
  NO_MANDATE: "NO_MANDATE",
  INACTIVE: "INACTIVE",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  MERCHANT_NOT_ALLOWED: "MERCHANT_NOT_ALLOWED",
  CATEGORY_NOT_ALLOWED: "CATEGORY_NOT_ALLOWED",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  PER_TX_CAP: "PER_TX_CAP",
  DAILY_CAP: "DAILY_CAP",
  VELOCITY: "VELOCITY",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  WITHIN_LIMITS: "WITHIN_LIMITS",
};

const OUTCOME = { ALLOW: "allow", ESCALATE: "escalate", DENY: "deny" };

/**
 * @param {object} args
 * @param {object|null} args.mandate hydrated mandate or null
 * @param {object} args.intent {merchant, category, amount_cents, currency}
 * @param {number} args.spent_today_cents captured spend for the agent today
 * @param {number} args.intents_last_hour attempts in the last rolling hour
 * @returns {{outcome: string, code: string, reason: string}}
 */
export function evaluate({ mandate, intent, spent_today_cents = 0, intents_last_hour = 0 }) {
  const amount = Number(intent.amount_cents);

  if (!mandate) {
    return deny(RULES.NO_MANDATE, "No active mandate for this agent. Create one before any spend.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return deny(RULES.INVALID_AMOUNT, "Amount must be a positive integer number of cents.");
  }
  if (!mandate.active) {
    return deny(RULES.INACTIVE, `Mandate ${mandate.id} is inactive.`);
  }
  if ((intent.currency ?? "USD") !== mandate.currency) {
    return deny(
      RULES.CURRENCY_MISMATCH,
      `Intent currency ${intent.currency ?? "USD"} does not match mandate currency ${mandate.currency}.`
    );
  }
  if (!mandate.merchant_allowlist.includes(intent.merchant)) {
    return deny(
      RULES.MERCHANT_NOT_ALLOWED,
      `Merchant "${intent.merchant}" is not on the allowlist (${mandate.merchant_allowlist.join(", ") || "empty"}).`
    );
  }
  if (
    mandate.category_allowlist.length > 0 &&
    !mandate.category_allowlist.includes(intent.category)
  ) {
    return deny(
      RULES.CATEGORY_NOT_ALLOWED,
      `Category "${intent.category}" is not permitted (${mandate.category_allowlist.join(", ")}).`
    );
  }
  if (amount > mandate.per_tx_cap_cents) {
    return deny(
      RULES.PER_TX_CAP,
      `Amount ${money(amount)} exceeds the per-transaction cap ${money(mandate.per_tx_cap_cents)}.`
    );
  }
  if (spent_today_cents + amount > mandate.daily_cap_cents) {
    return deny(
      RULES.DAILY_CAP,
      `This purchase would take today's spend to ${money(spent_today_cents + amount)}, over the daily cap ${money(
        mandate.daily_cap_cents
      )}.`
    );
  }
  if (intents_last_hour >= mandate.velocity_per_hour) {
    return deny(
      RULES.VELOCITY,
      `Velocity limit reached: ${intents_last_hour} attempts in the last hour (limit ${mandate.velocity_per_hour}).`
    );
  }
  if (amount > mandate.approval_threshold_cents) {
    return {
      outcome: OUTCOME.ESCALATE,
      code: RULES.APPROVAL_REQUIRED,
      reason: `${money(amount)} is above the ${money(
        mandate.approval_threshold_cents
      )} auto-approval threshold. A human must approve this one.`,
    };
  }
  return {
    outcome: OUTCOME.ALLOW,
    code: RULES.WITHIN_LIMITS,
    reason: `${money(amount)} is inside the mandate, below the approval threshold.`,
  };
}

function deny(code, reason) {
  return { outcome: OUTCOME.DENY, code, reason };
}

export function money(cents, currency = "USD") {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const value = (abs / 100).toFixed(2);
  return currency === "USD" ? `$${sign}${value}` : `${sign}${value} ${currency}`;
}

export { OUTCOME };
