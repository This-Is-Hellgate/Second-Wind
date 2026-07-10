# Second Wind — Specification and Action Plan

The governing rulebook is the [x402 Foundation specification](https://github.com/x402-foundation/x402):
`specs/x402-specification-v2.md`, its transport specs (`specs/transports-v2/`), and its extension
specs (`specs/extensions/`). Where this document and that repository disagree, that repository wins.

This document records (1) exactly which parts of the rulebook Second Wind implements and how that
is proven, (2) the step-by-step action plan with the proof required to advance each step, and
(3) the standing rules of the project. It is updated as steps complete.

---

## 1. Conformance status

Proof for every "Verified" row is machine-checked by `scripts/selftest.mjs`, which validates the
actual emitted objects against JSON Schemas transcribed from the spec's field tables
(`scripts/spec-schemas.mjs`) and decodes wire surfaces with the official `@x402/core` and
`@x402/extensions` packages. The suite encodes the spec, not this codebase: it was proven to fail
the previously non-conformant discovery document.

| Rulebook section | Status | Proof |
| --- | --- | --- |
| §5.1 PaymentRequired (incl. PaymentRequirements, ResourceInfo, Extensions info+schema rule) | Verified | selftest: decoded `PAYMENT-REQUIRED` header and 402 body validate against §5.1 schema |
| §5.2 PaymentPayload consumption (`accepted.network` rail matching, payment-identifier extraction) | Verified | selftest: synthetic payload → facilitator body; official `extractPaymentIdentifier` |
| §5.3 SettlementResponse (success and failure; failure carries `transaction: ""` + `errorReason`) | Verified | selftest: both builder outputs validate; header rides paid 200s and settle-failure 402s |
| §7.1/7.2 Facilitator verify/settle request body | Verified | selftest: `{x402Version, paymentPayload, paymentRequirements}` validates against §7.1 schema |
| §7.3 GET /supported | Not used | Single scheme (`exact`) on a single network; nothing to negotiate |
| §8 Discovery resources document | Verified | selftest: `/.well-known/x402` output validates against §8.1/§8.3 schema |
| §9 Error codes | Pass-through | Facilitator `invalidReason`/`errorReason` surfaced unmodified |
| §10 Replay protection | Verified + structural | EIP-3009 nonce/time-window at facilitator and contract; UNIQUE idempotency index refuses a second charge; failed settlements retry under their original record |
| §11 CAIP-2 networks, atomic units | Verified | `eip155:8453` only; amounts in USDC micros as strings |
| HTTP transport (`transports-v2/http.md`) | Verified | 402 + base64 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; official `@x402/fetch` client decodes production-shaped responses |
| Extension: `bazaar` | Verified | Built by official `declareDiscoveryExtension`; validated by official `validateDiscoveryExtension` |
| Extension: `payment-identifier` | Verified | Declared `{required: false}` via official helper; client id accepted as idempotency source, scoped by SKU; same-id conflicting replay hits the UNIQUE guard |
| Extensions: `offer-receipt`, `sign-in-with-x`, `builder-code`, gas sponsoring | Not implemented | Not advertised anywhere — nothing rides the wire that is not implemented |

### 1.1 Transport posture

An x402 seller is bound by a transport spec only for transports it offers or advertises.
Advertising a transport without implementing it is the one way to violate a transport spec from
the outside — Second Wind does not do that.

| Transport | Posture |
| --- | --- |
| **HTTP** (`transports-v2/http.md`) | **Implemented and verified.** The only selling surface. |
| **MCP** (`transports-v2/mcp.md`) | Not implemented, not advertised. If a paid MCP server ships later, it follows `_meta["x402/payment"]` / `_meta["x402/payment-response"]` and the dual-format `PaymentRequired` rule exactly. |
| **A2A** (`transports-v2/a2a.md`) | **Not implemented, not advertised — compliant by abstention.** The spec's activation clause binds "agents supporting x402 payments" over A2A, which must declare `capabilities.extensions` with uri `https://github.com/google-a2a/a2a-x402/v0.1` in their AgentCard. Second Wind's agent card declares no such extension and no A2A interface. History: the card previously advertised a `supportedInterfaces` entry pointing at `/api/a2a`, an endpoint that did not exist and carried no extension declaration — that false claim was removed. Becoming A2A-compliant later requires, in full: the task lifecycle (`input-required` → `working` → `completed`/`failed`), the `x402.payment.status` progression (`payment-required` → `payment-submitted` → `payment-verified` → `payment-completed`/`payment-failed`), `PaymentRequired` in `x402.payment.required`, `PaymentPayload` in `x402.payment.payload` with task correlation, `SettlementResponse` arrays in `x402.payment.receipts` (success and failure), the error-to-task-state mapping table, and the AgentCard extension declaration. The §5 core objects Second Wind already emits are the same objects that ride A2A metadata; only the JSON-RPC/task shell is missing. |

---

## 2. Action plan

Each step has one job and a hard gate. A step's gate must be proven — machine-checked where
possible — before the next step starts. No step is skipped because the previous one went well.
This table is updated in place as steps complete.

| # | Step | Action | Gate: what must be proven to advance | Status |
| --- | --- | --- | --- | --- |
| 1 | Ship the foundation | Push the conformance commits; workflow auto-deploys secondwindai.com | Production `/api/proof` returns the new shape; `/api/catalog` 308s to `/api/tools`; production `/.well-known/x402` validates against the §8 schema; production `/openapi.json` carries `components.schemas`; official `@x402/fetch` decodes a production 402 | **Ready — awaiting explicit deploy approval** |
| 2 | First repo intake | Mike sends an AWS repo; tool candidates drafted — each a small task an agent fails at: sku, price ≤ $1.00 USDC, summary, source repo/path, SPDX license, content hash | Every draft passes field validation (price cap, license, completeness); Mike has approved or rejected each candidate individually; at least one approved tool exists | Blocked on Step 1 + first repo |
| 3 | First publish | With Mike's explicit go — the only database write — approved tools written to production D1. The database is law from that moment | `/api/proof` count equals approved count exactly; each tool's 402 passes the spec suite against production; its openapi path and discovery item appear, spec-valid; `/api/tools` lists exactly what was approved | Blocked on Step 2 |
| 4 | Prove one real sale | Canary purchase with Mike's wallet via the official client | 200 with `PAYMENT-RESPONSE` decoding to a success SettlementResponse; transaction confirmed on Base; payments + deliveries rows written; a retried signed payment re-delivers free; a failed settlement shows `settle_failed` and permits retry | Blocked on Step 3 |
| 5 | Get discovered | Confirm CDP catalogs the resources (`EXTENSION-RESPONSES` bazaar status `success`; presence in CDP `/discovery/resources`); submit to x402scan and ecosystem registries | Resource visible in at least one facilitator discovery index with no schema rejections; x402scan lists without extraction errors | Blocked on Step 4 |
| 6 | Scale intake | Repo after repo, each batch through the Step 2 → 3 gates | Same gates as Steps 2–3, every batch | Ongoing after Step 5 |
| — | Parallel: Second Eyes | Take the conformance gap list back to Second Eyes (MCP transport for mcp-unblock, signed receipts, hand-rolled bazaar risk) | Independent of the gates above | Open |

---

## 3. Standing rules

1. **The x402 Foundation repository is the rulebook.** Follow it as written; use its official
   packages where they exist; never hand-roll what they ship helpers for.
2. **Nothing rides the wire unless a downstream role consumes it.** Protocol surfaces carry
   spec-defined fields only; guidance for humans and agents lives in application data (the 402
   body) and documentation.
3. **The database is law after publish.** Files and drafts prepare a change; writing it to
   production D1 is the act of publishing; live changes are deliberate database updates with a
   version bump and new content hash.
4. **No production database writes without Mike's explicit approval.** None.
5. **Price ceiling: $1.00 USDC per tool.** A tool is a small task — one specific thing an agent
   fails at, with the short content that unblocks it.
6. **Plain names only.** No metaphor vocabulary on any agent-facing surface. The selftest greps
   for banned words and fails on a hit.
7. **The test suite must encode the spec, not the implementation.** Any conformance fix lands
   together with a check that would have caught it — a check proven to fail the flawed version.
