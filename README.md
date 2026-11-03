# Mandate

**Spend controls, human approvals and an audit-grade ledger for AI agents that pay with PayPal.**

An agent with a card is a liability. An agent with a *mandate* is a colleague.

Mandate is a small, dependency-free Node service that sits between an AI agent and the PayPal Orders API. The agent proposes a purchase; deterministic policy decides whether it is allowed, refused, or escalated to a human; every decision, order, capture, refund and approval lands in a hash-chained audit trail.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (Agentic Commerce track).

```
                 ┌──────────────────┐        ┌───────────────────┐
  agent (MCP) ──▶│  policy engine   │───────▶│  PayPal Orders v2 │
  console    ──▶ │  6 deterministic │        │  capture / refund │
                 │  rules + human   │        └───────────────────┘
                 │  approval tokens │                  │
                 └────────┬─────────┘                  │
                          ▼                            ▼
                 ┌──────────────────────────────────────────┐
                 │ ledger + hash-chained audit (SQLite)      │
                 └──────────────────────────────────────────┘
```

## Why this exists

Agentic commerce has a trust problem in both directions. Merchants do not want an LLM hallucinating a $4,000 purchase, and buyers do not want an agent that can be prompt-injected into draining an account. The usual answer, "give the agent a virtual card with a limit", is coarse: it cannot express *which merchant*, *which category*, *how often*, or *who must say yes*.

Mandate makes the permission itself explicit and auditable:

- **A mandate** is a signed-off policy for one agent: per-transaction cap, daily cap, approval threshold, velocity limit, merchant and category allowlists.
- **A purchase intent** is what the agent asks for. It is evaluated before any PayPal call exists.
- **An approval token** is issued only by a human action in the console, is single-use, and expires in 15 minutes.
- **The audit chain** links every entry to the previous hash, so a deleted or edited record is detectable.

## What is in the box

| Piece | Path | What it does |
| --- | --- | --- |
| Policy engine | `src/policy.mjs` | Six rules, pure function, no model, no network |
| Service layer | `src/service.mjs` | Intent lifecycle: approve → order → capture → refund |
| PayPal adapter | `src/paypal.mjs` | Sandbox driver (OAuth2, Orders v2, Payments v2) + deterministic mock |
| MCP server | `src/mcp.mjs` | Six tools over stdio: any MCP agent can buy, safely |
| Console | `public/index.html` | Live grids for intents, ledger and audit; approval modal; policy simulator |
| Ledger | `src/db.mjs` | SQLite via `node:sqlite`; hash-chained audit and integrity check |
| Tests | `test/` | 25 tests: policy truth table, full HTTP flow, MCP handshake and tools |

No dependencies. Node 24 or newer.

## Quickstart

```bash
node --test          # 25 tests, ~2s
node scripts/demo.mjs
node src/server.mjs  # http://localhost:8787
```

The demo runs the whole lifecycle against the mock driver and prints a transcript:

```
1. agent buys API credits for $15.00 at cloudstore
   policy: ALLOW (WITHIN_LIMITS)
   fulfilled: captured, capture MOCK-CAPTURE-81E3D4F3
2. agent tries a $89.00 SSD
   policy: DENY (PER_TX_CAP)
3. agent tries a $249.00 chair from an unapproved merchant
   policy: DENY (MERCHANT_NOT_ALLOWED)
4. agent needs a $42.00 toner cartridge
   policy: ESCALATE (APPROVAL_REQUIRED)
   human approves; single-use token issued, expires ...
   token replayed: HTTP 400
5. refund issued: refunded
audit chain: verified (12 entries)
```

## Connect a real agent (MCP)

`src/mcp.mjs` speaks newline-delimited JSON-RPC over stdio (protocol `2025-06-18`). Example client config:

```json
{
  "mcpServers": {
    "mandate": {
      "command": "node",
      "args": ["/absolute/path/to/mandate/src/mcp.mjs"],
      "env": { "MANDATE_DB": "/absolute/path/to/mandate.db", "PAYPAL_MODE": "mock" }
    }
  }
}
```

The agent sees: `get_spend_mandate`, `search_catalog`, `purchase`, `fulfill_purchase`, `refund_purchase`, `spending_summary`. A `purchase` call returns one of three things:

```json
{ "status": "captured",         "paid": true,  "capture_id": "..." }
{ "status": "awaiting_approval","paid": false, "intent_id": "...", "code": "APPROVAL_REQUIRED" }
{ "status": "denied",           "paid": false, "code": "MERCHANT_NOT_ALLOWED" }
```

An agent cannot approve itself: approval tokens are created only by `POST /api/intents/:id/approve`, which the console calls after a human clicks Approve. Tokens are stored as SHA-256 hashes, marked used on first redemption and rejected after 15 minutes.

## Going live on PayPal sandbox

```bash
export PAYPAL_MODE=sandbox
export PAYPAL_CLIENT_ID=...      # from developer.paypal.com → Apps & Credentials (sandbox)
export PAYPAL_SECRET=...
node src/server.mjs
```

The sandbox driver implements:

- `POST /v1/oauth2/token` (client credentials, cached until 60s before expiry)
- `POST /v2/checkout/orders` with `intent: CAPTURE`, `custom_id` set to the intent id, no shipping
- `POST /v2/checkout/orders/{id}/capture`
- `POST /v2/payments/captures/{id}/refund`
- `POST /v1/notifications/verify-webhook-signature` (helper, wired for webhooks)

Only the adapter knows which driver is in use. Tests, the demo and the console badge all work offline against the mock.

Copy `.env.example` to `.env` for the full list of variables.

## Policy rules

Evaluated in order; the first failure wins and is stored on the intent as `reason_code`:

1. `NO_MANDATE` / `INACTIVE`: the agent has no active mandate
2. `INVALID_AMOUNT`: amount must be a positive integer number of cents
3. `CURRENCY_MISMATCH`: intent currency must equal the mandate currency
4. `MERCHANT_NOT_ALLOWED`: exact match against the allowlist
5. `CATEGORY_NOT_ALLOWED`: exact match, skipped if the category list is empty
6. `PER_TX_CAP`, then `DAILY_CAP` (captured spend today), then `VELOCITY` (attempts in the last hour)
7. above `approval_threshold_cents`: `APPROVAL_REQUIRED` → escalate
8. otherwise `WITHIN_LIMITS` → allow

The engine is a pure function. It has no clock of its own, no randomness, and no model call, so the same inputs always produce the same decision, and every rule is unit-tested.

## Audit and integrity

Each audit row contains `prev_hash` and `hash = SHA-256(prev_hash || canonical_json(entry))`. `GET /api/state` returns `integrity`, and `verifyAuditChain()` recomputes the whole chain. Tampering with any row breaks verification from that row onward; there is a test that does exactly that.

## Security notes

- Approval tokens: 48 hex chars from `crypto.randomBytes(24)`, stored hashed, single use, 15-minute expiry.
- The policy check happens before `createOrder`; denied intents never touch PayPal. The test suite asserts that a denied intent has zero transactions.
- No credentials in the database. `PAYPAL_SECRET` is read from the environment only.
- The HTTP server is intended for a trusted network or behind an authenticating proxy; `POST /api/mandates` is an owner action, not an agent action.
- SQLite runs in WAL mode; the ledger is append-only by convention and the audit chain makes silent edits detectable.

## Tests

```
node --test
```

- `test/policy.test.mjs`: truth table for every rule, boundaries included (cap equality, threshold equality, non-integer amounts)
- `test/flow.test.mjs`: HTTP flow over the mock driver, token replay, refund, audit tamper detection
- `test/mcp.test.mjs`: spawns the MCP server, handshakes, lists tools, buys, escalates, denies

## Roadmap

- Persistent budget periods (weekly/monthly) and per-merchant caps
- PayPal webhook listener for asynchronous capture and dispute events
- Multi-agent mandates with a shared team budget
- Exportable audit bundle (JSON + CSV) for finance review

## Built with

Hermes Agent (DeepSeek) for implementation and review, Node 24, `node:sqlite`, AG Grid Community, PayPal Orders v2. MIT licensed.
