# Devpost submission sheet, PayPal AI Hackathon

Paste-ready. Every link below was checked live on 2026-11-04.

## Identity

Field: Project name
Value: Mandate

Field: Elevator pitch (short, under 200 characters)
Value: Spend limits, human approvals and a hash chained audit trail for AI agents that pay with PayPal. The policy engine decides before any order exists.

Field: Thumbnail
Value: docs/thumbnail.png in the repo, 1280x720, 201 KB. Upload this file.

Field: Video demo link
Value: https://youtu.be/RLDdUNBafmk
Verified: public, title "Mandate| Paypal AI Hackathon", channel @Zaygalxx, 109 seconds.

## Links

Field: Public code repository
Value: https://github.com/Zaygalx/mandate
MIT license visible in the About panel. Tests: 25 pass.

Field: Functional demo (hosted URL)
Value: https://cnet-enquiries-cached-quarters.trycloudflare.com
What it is: the real console and HTTP API on the project host, mock PayPal driver, no login. Judges can place a purchase, watch policy decide, approve an escalated one, and read the audit chain.
Caveat: this URL is a quick tunnel and changes if the tunnel restarts. For a permanent URL, deploy the same repo to Render with the included render.yaml (free plan, Node 24, health check /api/state). Render is also a $1,000 credits prize track.

Field: Functional demo (self run, the durable path)
Value: "git clone https://github.com/Zaygalx/mandate && cd mandate && node --test && node src/server.mjs" then open http://localhost:8787. Node 24 or newer, no dependencies, no credentials.

## Tools used, and how

Mandate was built with DeepSeek (deepseek-flash) driving Hermes Agent, an autonomous
coding agent, which wrote and reviewed the Node source, the three test suites and this
submission copy. Playwright and Chromium recorded the demo film from the live console so
the video shows real behaviour, and ffmpeg cut the scenes and laid the narration under
each one. Firecrawl extracted the hackathon rules and judging criteria from the Devpost
page. GitHub CLI published the repository, the release and the Pages demo page.
No model sits in the payment path: the policy engine is a deterministic function, which
is the point of the project.

## Built with

Node.js, node:sqlite, PayPal Orders v2, PayPal Payments v2, Model Context Protocol, AG Grid, Playwright, ffmpeg, HTML, CSS, JavaScript

## Prize tracks to tick

- Best Use of Agentic Commerce ($5,000)
- Best Use of PayPal + AI ($5,000)
- Best Use of Render, if deployed on Render ($1,000 credits, 1st place)

## About the project (paste into the description field)

### Inspiration

Agents can already hold a card number. The moment they can spend, every team that tries
it hits the same wall: there is no layer between an agent's good intentions and a payment
it should not make. Prompt instructions are not a control. A spending limit in a prompt is
a suggestion. We wanted the control to be code that runs before PayPal is ever called, and
a record that survives review.

### What it does

Mandate puts a deterministic spend policy between an AI agent and PayPal.

- A mandate declares the rules: per transaction cap, daily cap, approval threshold,
  velocity limit, allowed merchants and allowed categories.
- The agent requests a purchase intent. The engine returns allowed, escalated or denied,
  with the rule that decided it.
- Allowed intents become a PayPal order and are captured in the same flow.
- Escalated intents wait for a human. Approval mints a single use token, stored as a
  SHA-256 hash, bound to that intent, expiring in fifteen minutes. Replaying it is refused.
- Every decision, order, capture, refund and approval is written to a hash chained audit
  log. Change one row and verification fails, which is what makes the trail worth reading.

Three surfaces, one engine: an MCP stdio server for agents, an HTTP API for anything else,
and a console for the human who has to say yes.

### How we built it

Zero runtime dependencies. It runs on Node 24's built in SQLite, so a judge clones the
repository and runs the tests without installing anything. The PayPal driver is an
interface with two implementations: a mock that returns deterministic order identifiers so
the whole flow works offline, and a sandbox driver that uses the Orders v2 and Payments v2
REST APIs with OAuth2 client credentials, switched with PAYPAL_MODE=sandbox.

The policy engine is a pure function and a small ordered rule table, which made it
straightforward to test exhaustively: allow inside the limits, deny without a mandate or
outside a cap, escalate above the approval threshold, and refuse malformed amounts.

The console came last and taught the sharpest lesson. The table renderer, the approval
modal and the delegated click handling each had to be fixed before the flow felt real.

### Challenges

The hard part was not the PayPal calls, it was making the human approval step genuinely
safe rather than decorative. A token that can be reused is a backdoor. The approval is
therefore a hash on disk, single use, bound to one intent and time limited, and the tests
assert that reuse fails and that only one approval row is ever consumed.

Second: keeping the audit trail trustworthy without a database server. Hash chaining each
entry to its predecessor is enough to make silent edits detectable, and verification runs
in the console so a judge can watch it pass.

### Accomplishments

- 25 tests covering policy, HTTP flow, approval tokens, refunds and the MCP server.
- A demo that runs with no credentials at all, then switches to real PayPal sandbox calls
  by changing one environment variable.
- A console where a denial is visibly cheaper than an approval: a denied intent never
  reached PayPal, so there is no order to cancel.

### What we learned

Controls that live in a prompt are not controls. Putting the decision in a deterministic
function, before the payment call, changes the failure mode from "the agent spent money it
should not have" to "the agent was told no, and here is the rule that said so".

### What's next

Per agent budgets over longer windows, merchant reputation signals, and a second driver for
card rails so the same mandate governs more than PayPal.

## Judging criteria alignment

- Technical execution: deterministic engine, zero dependencies, 25 tests, MCP and HTTP.
- Use of PayPal: Orders v2 create and capture, Payments v2 capture and refund, OAuth2.
- Originality: the approval token and the audit chain, not another checkout button.
- Impact: any team putting an agent near a payment method needs this control layer.
