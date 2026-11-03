/**
 * PayPal adapter with two drivers:
 *  - mock: deterministic, offline, used by tests, the demo and any judge without
 *    sandbox credentials.
 *  - sandbox: the real PayPal Orders v2 / Payments v2 API with OAuth2 client
 *    credentials. Selected with PAYPAL_MODE=sandbox.
 *
 * The rest of the system never sees the difference: both drivers return the same
 * normalised shape {id, status, amount_cents, currency, raw}.
 */
import { randomUUID } from "node:crypto";

const SANDBOX_BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

export function createPayPal({ mode = process.env.PAYPAL_MODE ?? "mock" } = {}) {
  return mode === "sandbox" ? new SandboxPayPal() : new MockPayPal();
}

export class MockPayPal {
  driver = "mock";
  #orders = new Map();
  #captures = new Map();

  async createOrder({ intent, amount_cents, currency, merchant, description }) {
    const id = `MOCK-ORDER-${randomUUID().slice(0, 8).toUpperCase()}`;
    const order = {
      id,
      status: "CREATED",
      amount_cents,
      currency,
      payee: merchant,
      description,
      intent_id: intent,
      raw: { id, status: "CREATED", payee: merchant },
    };
    this.#orders.set(id, order);
    return order;
  }

  async captureOrder(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) throw new Error(`Unknown mock order ${orderId}`);
    const captureId = `MOCK-CAPTURE-${randomUUID().slice(0, 8).toUpperCase()}`;
    const capture = { id: captureId, order_id: orderId, status: "COMPLETED", amount_cents: order.amount_cents, currency: order.currency };
    this.#captures.set(captureId, capture);
    order.status = "COMPLETED";
    return { ...capture, raw: { id: captureId, status: "COMPLETED", amount: order.amount_cents } };
  }

  async refundCapture(captureId, amountCents) {
    const capture = this.#captures.get(captureId);
    if (!capture) throw new Error(`Unknown mock capture ${captureId}`);
    const id = `MOCK-REFUND-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      id,
      capture_id: captureId,
      status: "COMPLETED",
      amount_cents: amountCents ?? capture.amount_cents,
      currency: capture.currency,
      raw: { id, status: "COMPLETED" },
    };
  }
}

export class SandboxPayPal {
  driver = "sandbox";
  #token = null;
  #tokenExpires = 0;

  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_SECRET } = {}) {
    if (!clientId || !secret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_SECRET are required when PAYPAL_MODE=sandbox");
    }
    this.clientId = clientId;
    this.secret = secret;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpires - 60_000) return this.#token;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString("base64");
    const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal token failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    this.#token = body.access_token;
    this.#tokenExpires = Date.now() + (body.expires_in ?? 3000) * 1000;
    return this.#token;
  }

  async #call(path, init = {}) {
    const token = await this.#accessToken();
    const res = await fetch(`${SANDBOX_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`PayPal ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async createOrder({ intent, amount_cents, currency, description }) {
    const body = await this.#call("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: intent,
            description: description.slice(0, 127),
            amount: { currency_code: currency, value: (amount_cents / 100).toFixed(2) },
          },
        ],
        application_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
      }),
    });
    return {
      id: body.id,
      status: body.status,
      amount_cents,
      currency,
      raw: body,
    };
  }

  async captureOrder(orderId) {
    const body = await this.#call(`/v2/checkout/orders/${orderId}/capture`, { method: "POST" });
    const capture = body.purchase_units?.[0]?.payments?.captures?.[0] ?? {};
    return {
      id: capture.id,
      order_id: orderId,
      status: capture.status ?? body.status,
      amount_cents: toCents(capture.amount?.value),
      currency: capture.amount?.currency_code ?? "USD",
      raw: body,
    };
  }

  async refundCapture(captureId, amountCents) {
    const body = await this.#call(`/v2/payments/captures/${captureId}/refund`, {
      method: "POST",
      body: JSON.stringify(amountCents ? { amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" } } : {}),
    });
    return {
      id: body.id,
      capture_id: captureId,
      status: body.status,
      amount_cents: toCents(body.amount?.value),
      currency: body.amount?.currency_code ?? "USD",
      raw: body,
    };
  }

  async verifyWebhook(headers, event) {
    const body = await this.#call("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: event,
      }),
    });
    return body.verification_status === "SUCCESS";
  }
}

function toCents(value) {
  if (!value) return 0;
  return Math.round(Number.parseFloat(value) * 100);
}
