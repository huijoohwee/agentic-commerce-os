# From useful idea to first sale

Airvio education materials · Edition 1 · 12 September 2026

A practical guide and reusable worksheets for a solo operator designing a small,
agent-assisted commerce offer. This is original, open educational content. It is
not a promise of revenue, consulting, or access to a hosted agent service.

Use this file in any text editor. Copy the blank worksheets into your own private
workspace. Keep customer details and confidential research out of public repos.

## 1. Choose one problem you can reach

Start with a buyer who has a specific task, a recurring obstacle, and a way to
pay for a useful result. An impressive agent demonstration alone is not evidence
of demand. Prefer an observable cost: hours spent preparing an invoice, missed
orders, manual catalog cleanup, or a report that repeatedly arrives late.

Example hypothesis: an independent instructor spends two hours each week turning
rough lesson notes into a consistent lesson pack. A reviewed, editable pack could
save preparation time. The example is a hypothesis, not a validated market.

Describe the existing workaround before proposing your solution. A buyer who
already pays for help or spends substantial time on the task offers stronger
evidence than a friendly reaction to a demo.

### Buyer interview worksheet

- Buyer role and how I can reach them:
- Task they completed most recently:
- Trigger that made the task necessary:
- Current steps and tools:
- Time, money, or errors in the current process:
- What they have already tried:
- Who can authorize a purchase:
- Exact words or observable evidence, with permission to retain:
- Smallest useful result I could deliver:
- Next action the buyer agreed to:

Ask about recent behavior. “Walk me through the last time” is more informative
than “Would you use an AI agent?” Do not label interest, a free trial, or a test
payment as revenue or willingness to pay.

## 2. Select a small offer

Compare two or three options before building. First eliminate options that fail
hard constraints: you cannot reach the buyer, cannot deliver safely, lack rights
to the input, or would need infrastructure you cannot operate.

For remaining options, write the strongest reason for and against each. Prefer an
option when it has better evidence of pain, a clearer deliverable, and less new
work. If one option is cheaper but has weaker buyer evidence, record that tradeoff
explicitly. Do not hide missing evidence behind a weighted score.

### Offer comparison worksheet

| Criterion | Option A | Option B | Evidence / uncertainty |
|---|---|---|---|
| Reachable buyer with a recent problem | | | |
| Concrete result they can inspect | | | |
| Willingness to commit at the proposed price | | | |
| Existing capability I can reuse | | | |
| Delivery effort and ongoing support | | | |
| Safety, ownership and operating constraints | | | |

Decision:

Reason this option is preferred:

Evidence that would change the decision:

## 3. Write the terms before automating

A useful first offer fits in a paragraph: who it serves, what you deliver, when,
what it costs, and what is excluded. Name the format and acceptance criteria.
For a digital product, tell the buyer how to obtain and keep the file. For a
service, define the number of revisions and the inputs required from the buyer.

Example: “One editable lesson pack from your supplied notes, reviewed by me,
delivered as Markdown within two business days. Includes one correction round.
Does not include student assessment, regulated advice, or redistribution of
third-party materials.” Decide your own terms from your actual capabilities.

### Offer worksheet

- Buyer and problem:
- Outcome:
- Deliverable and format:
- Price and currency:
- Required buyer inputs:
- Delivery time:
- Acceptance criteria:
- Included support or revisions:
- Exclusions:
- How the buyer requests help:
- How I will handle errors or non-delivery:
- Evidence that I can produce the promised result:

## 4. Check the economics

Use your actual provider terms and measured delivery time. Do not assume a
universal transaction fee or that a free infrastructure tier makes operation free.
Include your own time, agent usage, retries, support, and customer acquisition.

Contribution per sale = price − delivery cost − payment cost − agent cost
                       − acquisition cost − expected support cost

Break-even sales = one-time setup cost ÷ positive contribution per sale,
rounded up. If contribution is zero or negative, revise the offer before scaling.
This calculation does not include every tax or business obligation; determine
those from the requirements that apply to your own business.

### Unit economics worksheet

| Input, in one currency | Estimate | Source / measured basis |
|---|---:|---|
| Price | | |
| Delivery time × value of an hour | | |
| Provider cost per successful sale | | |
| Agent and tool usage per sale | | |
| Acquisition cost per sale | | |
| Expected support cost per sale | | |
| Contribution per sale | | |
| One-time setup cost | | |
| Break-even sales | | |

Record estimated and actual costs separately. Review them after the first few
real deliveries. A low selling price is not automatically a low-risk offer if
support consumes more time than the product saves.

## 5. Give agents bounded jobs

Let an agent research options, prepare a draft, or explain a quote. Keep writes
explicit: publishing an offer, changing a price, contacting a buyer, charging a
payment method, or issuing a refund requires the appropriate authorization.

Give each action an owner, allowed inputs, output contract, deadline, and failure
behavior. Reuse the payment provider's ledger and idempotency controls. Do not
create a second “paid” flag based on a browser redirect or a model's assertion.

### Agent action worksheet

- Task:
- Authorized actor:
- Read sources and freshness requirement:
- Allowed tools:
- Permitted writes:
- Human approval required before:
- Exact output and validation:
- Maximum time, attempts, and spend:
- Idempotency key or duplicate-action rule:
- Behavior after timeout or an uncertain result:
- Evidence retained without secrets or customer payment details:

After an uncertain payment result, look up the existing operation before trying
again. “Request timed out” does not mean “nothing happened.” Never retry a charge
with a new identity merely because the first response was lost.

## 6. Complete the smallest sale loop

1. Show the exact offer, price, delivery terms, and merchant.
2. Let the buyer review and choose to continue.
3. Hand payment details to the payment provider's hosted page.
4. Verify the provider's payment status on the server.
5. Release the promised result only after successful verification.
6. Give the buyer a receipt and a way to retain the deliverable.
7. Record delivery, support effort, and feedback without exposing private data.

Test declines, abandoned checkout, delayed confirmation, refresh, duplicate
clicks, expired sessions, and network loss. Confirm that a forged return URL
cannot unlock delivery. Avoid collecting card details in your own interface.

### Launch review worksheet

- [ ] The offer and price match the authoritative provider configuration.
- [ ] I have inspected the actual deliverable.
- [ ] The buyer can understand what is included before paying.
- [ ] No private draft or customer data appears in the public listing.
- [ ] Payment is confirmed by the provider, not by a redirect parameter.
- [ ] Retries and duplicate clicks cannot create an unintended second charge.
- [ ] Failure messages explain how to resume or seek help.
- [ ] The deployed source and verification evidence are recorded.
- [ ] A rollback preserves existing orders and customer access.
- [ ] I have a practical plan to handle support and non-delivery.

## 7. Run one learning sprint

Choose a small reachable cohort and one offer. Record the number of conversations,
qualified buyers, checkout starts, verified payments, successful deliveries, and
support minutes. A checkout start is not a completed sale. A fixture or test-mode
payment is not customer revenue.

### Sprint worksheet

- Start and review dates:
- Buyer hypothesis:
- Evidence needed to continue:
- Smallest deliverable:
- Maximum build and support time:
- Outreach channel and authorization:
- Conversations / qualified buyers:
- Checkout starts / verified payments:
- Deliveries / unresolved issues:
- Revenue / direct costs / support time:
- What buyers actually valued:
- Decision: continue, narrow, change, or stop:
- Next smallest action and its owner:

Keep what works, remove what was replaced, and expand only when evidence supports
it. The purpose of the first sale is to learn whether you can repeatedly deliver
something useful at a sustainable cost.
