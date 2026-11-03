# Devpost submission copy: Mandate

Paste-ready text for the PayPal AI Hackathon submission form. Keep the wording
as is unless a field has a character limit; the short versions below are for
those.

## Project name

Mandate

## Elevator pitch (one line)

Spend controls, human approvals and an audit-grade ledger for AI agents that pay with PayPal.

## Inspiration

Agentic commerce has a trust problem in both directions. Merchants do not want
an LLM hallucinating a four thousand dollar purchase, and buyers do not want an
agent that can be prompt-injected into draining an account. The usual answer,
give the agent a virtual card with a limit, cannot express which merchant, which
category, how often, or who must say yes.

We built the missing control layer. An agent with a card is a liability. An
agent with a mandate is a colleague.

## What it does

Mandate sits between an AI agent and the PayPal Orders API.

- A **mandate** is an explicit policy for one agent: per transaction cap, daily
  cap, approval threshold, velocity limit, merchant and category allowlists.
- A **purchase intent** is what the agent asks for. It is evaluated before any
  PayPal call exists.
- Policy returns one of three outcomes: **allow**, **deny**, or **escalate** to
  a human.
- Escalations produce a **single use approval token** that only a human action
  in the console can mint. Tokens are stored as SHA-256 hashes, expire in 15
  minutes, and are refused on replay.
- Every decision, order, capture, refund and approval is written to a
  **hash-chained audit trail**, so a silent edit is detectable.

The agent reaches all of this three ways: an MCP server over stdio for any MCP
capable agent, an HTTP API, and the console a human uses to approve and watch
the ledger.

## How we built it

Node 24 with the built-in `node:sqlite` driver, so the whole service has **zero
dependencies**. The policy engine is a pure function with six ordered rules and
no clock, no randomness and no model call, which makes every decision
reproducible and unit-testable.

The PayPal adapter has two drivers behind one interface. `MockPayPal` is
deterministic and offline, so judges can run the entire flow without
credentials. `SandboxPayPal` implements the real thing: OAuth2 client
credentials with token caching, `POST /v2/checkout/orders` with `intent:
CAPTURE`, capture, refund, and webhook signature verification against
`api-m.sandbox.paypal.com`. `PAYPAL_MODE=sandbox` switches between them.

The console is plain HTML and AG Grid, served by the same process. It shows the
mandate in force, the purchase form, live intents with their policy rule and
reason, the PayPal ledger with real order and capture identifiers, a policy
simulator that evaluates without creating an order, and the audit trail with
its integrity check.

## Challenges we ran into

The hard part was not the PayPal calls, it was making the unsafe path
impossible rather than discouraged. That meant refusing intents before an order
exists, binding approvals to a single intent and a human action, making the
approval single use and short lived, and proving all of it with tests rather
than describing it. One test asserts a denied purchase creates zero PayPal
transactions. Another tampers with an audit row and asserts verification fails
from that row onward. A third spawns the MCP server and drives it over stdio to
confirm an agent cannot approve itself.

## Accomplishments we are proud of

- A complete, runnable demo with no credentials and no network.
- 25 tests across the policy truth table, the HTTP lifecycle and the MCP
  interface.
- A real PayPal sandbox driver, not a stub, with the mock only as the default.
- An audit trail with actual tamper detection rather than a log table.

## What we learned

Deterministic policy beats model judgment in the payment path. The model should
decide what to buy; the rules should decide whether it may. Keeping those two
separate made the system auditable, testable and explainable to a finance team.

## What is next

Weekly and monthly budget periods, per merchant caps, a webhook listener for
asynchronous captures and disputes, shared team mandates, and an exportable
audit bundle for finance review.

## Built with

node.js, node:sqlite, PayPal Orders API v2, PayPal Payments API v2, MCP
(Model Context Protocol), AG Grid, HTML, CSS, JavaScript

## Links

- Repository: https://github.com/Zaygalx/mandate
- Demo page (film, screenshots, protocol example): https://zaygalx.github.io/mandate/
- Video file (direct MP4, 109s): https://zaygalx.github.io/mandate/mandate-demo.mp4
- Release with the same film attached: https://github.com/Zaygalx/mandate/releases/tag/v1.0.0
- Demo: runs locally with `node --test`, `node scripts/demo.mjs`, `node src/server.mjs`

## Judge test path

```bash
git clone https://github.com/Zaygalx/mandate
cd mandate
node --test          # 25 tests, no credentials needed
node scripts/demo.mjs
node src/server.mjs  # http://localhost:8787
```

For live PayPal sandbox orders:

```bash
PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID=... PAYPAL_SECRET=... node src/server.mjs
```

## Team

Hassan Dosunmu, solo build. Implementation and review assisted by Hermes Agent
running DeepSeek.
