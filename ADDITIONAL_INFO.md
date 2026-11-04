# Devpost Additional info, paste answers

## Upload a file
Optional. Skip it. Everything the judges need is the repo, the hosted demo and the video.

## Submitter Type
Individual

## Submitter Country of Residence
Nigeria

## Province (Canada only)
N/A

## Organization Name
N/A

## Is your project new, or did it exist before Oct 1, 2026?
New. Mandate was written entirely inside the submission period, first commit November 3, 2026.

## If it existed before, explain what changed
N/A, new project.

## Explain how your project meets the main technology requirement

PayPal tools used:

- PayPal Orders v2 REST API, POST /v2/checkout/orders and POST /v2/checkout/orders/{id}/capture. Every purchase the policy allows is created as a real PayPal order and captured server side, and the order id and capture id are stored on the intent and shown in the console.
- PayPal Payments v2 API, POST /v2/payments/captures/{capture_id}/refund. Refunds are issued against the stored capture id and the refunded state is written to the ledger.
- PayPal OAuth 2.0 client credentials, POST /v1/oauth2/token. The server mints and caches its access token from PAYPAL_CLIENT_ID and PAYPAL_SECRET, which are read from the environment only and never stored in the database.
- PayPal sandbox environment, api-m.sandbox.paypal.com. The sandbox driver is selected with PAYPAL_MODE=sandbox and implements the documented Orders v2 and Payments v2 calls. The public demo runs the deterministic mock driver on purpose, so judges can walk the whole flow, including capture and refund, without anyone's credentials in the loop. Both drivers sit behind one interface in src/paypal.mjs.
- Server side only. No PayPal JS SDK and no card data touches the application, which is appropriate for an agent that pays on its own.

AI tools used:

- DeepSeek, model deepseek-flash, driving Hermes Agent, an autonomous coding agent, for implementation, tests, review and the demo film pipeline.
- Model Context Protocol. src/mcp.mjs exposes Mandate as an MCP stdio server, so an MCP capable model such as Claude, GPT or DeepSeek is the actual client of the product: the model proposes a purchase, Mandate decides.
- Deliberate design point: the policy engine contains no model. An LLM in the approval path would make the audit trail a matter of opinion, so the AI is the initiator of a payment and never the authoriser. Denials, caps, escalation and the hash chain are deterministic and tested.

## Which additional sponsor tool(s) did you use?
- AG Grid, Community edition 32.2.2, for the console's ledger grid, custom rule and status renderers and the action column.
- Render, web service plus a 1 GB persistent disk, hosting the live demo with a health check on /api/state.
No other sponsor tools were used: no APIMatic, Postman, Bryntum, Channel3, Elastic, KERNEL, Astropods or Zapier.

## Public code repository
https://github.com/Zaygalx/mandate
MIT licensed, license visible in the About panel. README covers setup, the HTTP and MCP surfaces, the PayPal sandbox path, the policy rules, the audit chain, and which sponsor tools are used where. 25 tests pass with node --test on Node 24, zero runtime dependencies.

## Working demo URL
https://mandate-w608.onrender.com

## Testing instructions or credentials
No login and no credentials needed.

1. Open the URL. The console loads with a seeded ledger: 1500 captured, 8900 denied for exceeding the per transaction cap, 4200 waiting for a human.
2. Create a purchase with the form or the API: 1500 API credits is allowed, 8900 SSD is denied, 4200 toner is escalated for approval.
3. On the escalated row, press Approve. A single use token appears. Press Fulfil to capture it, then try the same token again: it is refused, because the token is stored as a hash and consumed once.
4. Refund a captured row to see the Payments v2 refund path and the ledger update.
5. The header shows the audit chain verification. GET /api/state returns the same state as JSON.
6. For the agent surface, node src/mcp.mjs speaks MCP over stdio, and node scripts/demo.mjs prints the protocol exchange.

## Overall experience rating (1 to 10)
9

## Why that rating
Orders v2 maps cleanly onto the concept: an intent, then an order, then a capture, which mirrors what a spend control layer needs to record. The client credentials token exchange and the sandbox base URL were the easy part, and the resource model made it obvious where the order and capture ids belong in the ledger. The parts I would improve are small: the sandbox and live base URLs are easy to mix up when you first point the client at PayPal, amounts must be sent as strings with the right number of decimals, and different failure modes return error bodies of different shapes, which pushes more defensive parsing into the client than I would like. A typed Node client that ships with the docs would remove most of that.

## Open to being contacted for feedback
Yes.

## APIMatic Context Plugin
N/A, not used.

## AG Grid experience
Pleasant. AG Grid Community 32.2.2 came in from a CDN with no build step, which matters in a project that deliberately has zero dependencies. The dark quartz theme matched the console with a little CSS, custom cell renderers let me show the deciding rule as a badge and the status as a coloured pill, and the action column carries approve and refund buttons that call the HTTP API. Two lessons: give every column an explicit id, because two columns sharing an empty identifier cost me a vanishing action column, and handle button clicks by delegation on the grid body rather than binding at render time, because the grid recycles cells.

## Age of majority
Checked. True.

## Eligible jurisdiction
Checked. True. Nigeria is not among the excluded jurisdictions in the rules.

## Not employees or agents of the promotion entities
Checked. True.

## Which AI tools have you leveraged while working on this project?
DeepSeek (deepseek-flash) as the coding model behind Hermes Agent, an autonomous agent that wrote and reviewed the Node service, the test suites and the film pipeline, and drove the browser checks. Model Context Protocol as the agent facing interface of the product itself. Firecrawl to pull the hackathon rules and judging criteria. Playwright and Chromium to record the demo film from the live console, and ffmpeg to cut it.

## Describe the level of learning you derived from the project
Substantial, and mostly in the unglamorous places. I learned how PayPal's order and capture resources actually relate, and why the capture id, not the order id, is the thing you store if you want refunds to work later. I learned that an approval token is a security boundary rather than a UI convenience: single use, hashed at rest, bound to one intent, expiring, with tests that try to replay it. I learned that a deterministic rule table is easier to defend in an audit than any amount of prompt engineering. On the engineering side I learned how much of a product is the last ten percent: the grid, the modal, the click handling, the seed data that stops a judge seeing an empty table.

## Did you gain AI value that you can use in your career?
Yes. The reusable value is the pattern rather than the tool: put the model where it proposes and a deterministic function where it authorises, then keep a record that a third party can verify. That pattern applies to any agent that touches money, infrastructure or customer data, and I can take it into future work with agents. Practically, I also learned where an agent helps most in a build like this, which is tests, refactors and repetitive verification, and where it needs a human, which is the judgement calls about what the product should claim.
