# Second Wind — Specification and Action Plan

The governing rulebook is the [x402 Foundation specification](https://github.com/x402-foundation/x402):
`specs/x402-specification-v2.md`, its transport specs (`specs/transports-v2/`), and its extension
specs (`specs/extensions/`). Where this document and that repository disagree, that repository wins.

This document records (1) exactly which parts of the rulebook Second Wind implements and how that
is proven, (2) the step-by-step action plan with the proof required to advance each step, and
(3) the standing rules of the project. It is updated as steps complete.

---

## 0. Architecture

**The gatekeeper is the official x402 SDK.** Serving runs as a Hono app on Cloudflare Workers
(`src/worker.js`, bundled to `public/_worker.js`) using `@x402/hono` + `@x402/core` +
`@x402/evm` — the pattern of the official CloudFront/Lambda@Edge example, on the edge runtime we
already operate. The middleware verifies payment before the handler and settles ONLY after the
handler succeeds: a buyer is never charged for a failed response. Payment routes are generated
from the live D1 rows (60-second isolate cache); the CDP facilitator authenticates via
`createAuthHeaders` (CDP JWT). Hand-rolled payment code no longer serves payments — it survives
only inside the discovery-document generators pending their port.

Storage: **the tools ARE objects.** **KV** holds text tools (markdown/JSON) at `tool:<sku>` plus
the `manifest` key — the single machine-readable index every surface (payment routes, the tools
listing, openapi.json, the discovery documents) is generated from. **R2** holds bundles (zips,
scripts, binaries), delivered as binary responses. Publishing a tool means writing its object and
its manifest stub — **the object store is law**. **D1** is nothing more than a holding area for
intake work plus the operational ledger (payments, deliveries, request log); the serving path
never reads tool data from it. **AWS (Bedrock)** executes behind the paywall when a tool requires
computation; Cloudflare verifies, proxies, settles after success.

**Network is config, not a constant.** The first proof runs **Base Sepolia (`eip155:84532`)**
with valueless test USDC via the public `x402.org` facilitator (no auth) — real on-chain
verify → settle exercised at zero cost, on the same network the AP2/a2a-x402 reference samples
use. Promotion to Base mainnet is an env swap (`X402_NETWORK`, `X402_FACILITATOR_URL` → CDP with
JWT auth, mainnet `payTo`). The proof `payTo` must be a THROWAWAY test wallet (Mike supplies).

**Execution layer (Bedrock) — implemented.** Manifest stubs with `store: "bedrock"` become paid
`POST` routes: the middleware verifies, the worker invokes the agent via SigV4-signed fetch
(`aws4fetch`, AWS event-stream decoded in the worker), and settlement happens only when the
invocation succeeds — a failed agent run never charges the buyer. The bazaar block advertises
`bodyType: json` with the stub's input schema.

**A2A/AP2 posture.** HTTP is the primary surface, built a2a-x402-shaped: the x402 payment objects
(PaymentRequirements / PaymentPayload / receipts) stay cleanly separable so the same core can be
carried over A2A tasks or nested in an AP2 CartMandate later. The AgentCard
`capabilities.extensions` declaration of the a2a-x402 URI is DEFERRED until an actual A2A task
endpoint exists — no advertised transport without an implementation behind it. MCP exposure is a
possible later second face; it is not the discovery surface A2A/AP2 consume.

The legacy `functions/` handlers remain in-repo until the gatekeeper's production cutover is
proven (`_worker.js` takes precedence on Pages; the old code is inert once deployed).

## 1. Conformance status

Proof for every "Verified" row is machine-checked by two suites run in CI before any deploy:
`scripts/selftest.mjs` (discovery generators, shared libraries, facilitator body, settlement
shapes) and `scripts/worker-selftest.mjs` (the REAL gatekeeper worker end-to-end: SDK-emitted
402s, free surfaces, redirects, teaching 405s, HEAD, vocabulary ban). Both validate emitted
objects against JSON Schemas transcribed from the spec's field tables
(`scripts/spec-schemas.mjs`) and decode wire surfaces with the official `@x402/core` and
`@x402/extensions` packages. The suites encode the spec, not this codebase: the schema layer was
proven to fail the previously non-conformant discovery document.

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
| 1 | Ship the gatekeeper (Sepolia config) | Mike supplies a throwaway Base Sepolia test wallet for `payTo`; push the commits; CI runs both conformance suites, builds the worker, auto-deploys secondwindai.com; Mike-gated infra: create the KV namespace (+ R2 bucket) bindings | Production `/api/proof` returns the new shape on `eip155:84532`; `/api/catalog` 308s to `/api/tools`; production `/.well-known/x402` validates against the §8 schema; production `/openapi.json` carries `components.schemas`; official `@x402/fetch` decodes a production 402 emitted by the SDK middleware | **Ready — awaiting throwaway wallet + deploy approval** |
| 2 | Sepolia proof of the money path | Seed ONE test object into KV (Mike-gated write); canary purchase with a test wallet via the official client — real on-chain verify → settle with valueless USDC through x402.org | 200 with `PAYMENT-RESPONSE` decoding to a success SettlementResponse; transaction confirmed on Base Sepolia; ledger rows written; a failed handler response is NOT charged (settle-after-success observed); if a Bedrock stub is configured: paid POST runs the agent end-to-end | Blocked on Step 1 |
| 3 | First repo intake | Mike sends an AWS repo; tool candidates drafted — each a small task an agent fails at: sku, price ≤ $1.00 USDC, summary, source repo/path, SPDX license, content hash | Every draft passes field validation (price cap, license, completeness); Mike has approved or rejected each candidate individually; at least one approved tool exists | Blocked on Step 2 + first repo |
| 4 | First publish | With Mike's explicit go — approved tools written as OBJECTS: KV (text) / R2 (bundles) / bedrock stubs, plus their manifest entries. The object store is law from that moment | `/api/proof` count equals the manifest exactly; each tool's 402 passes the spec suite against production; its openapi path and discovery item appear, spec-valid; `/api/tools` lists exactly what was approved; each object fetches and matches its content hash | Blocked on Step 3 |
| 5 | Mainnet promotion + real sale | Env swap to `eip155:8453` + CDP facilitator (JWT secrets) + mainnet payTo; canary purchase with real cents | Same proofs as Step 2 on mainnet; CDP settle confirmed on Base | Blocked on Step 4 |
| 6 | Get discovered | Confirm the facilitator catalogs the resources (`EXTENSION-RESPONSES` bazaar status `success`; presence in `/discovery/resources`); submit to x402scan and ecosystem registries | Resource visible in at least one facilitator discovery index with no schema rejections; x402scan lists without extraction errors | Blocked on Step 5 |
| 7 | Scale intake | Repo after repo, each batch through the Step 3 → 4 gates | Same gates as Steps 3–4, every batch | Ongoing after Step 6 |
| — | Parallel: Second Eyes | Take the conformance gap list back to Second Eyes (MCP transport for mcp-unblock, signed receipts, hand-rolled bazaar risk) | Independent of the gates above | Open |

---

## 3. Standing rules

1. **The x402 Foundation repository is the rulebook.** Follow it as written; use its official
   packages where they exist; never hand-roll what they ship helpers for.
2. **Nothing rides the wire unless a downstream role consumes it.** Protocol surfaces carry
   spec-defined fields only; guidance for humans and agents lives in application data (the 402
   body) and documentation.
3. **The object store is law after publish.** Drafts and intake work live in the D1 holding
   area; writing a tool's object (KV/R2) and its manifest stub is the act of publishing. Live
   changes are deliberate object writes with a version bump and new content hash. What is IN the
   store is what is for sale — nothing else.
4. **No production store writes (KV, R2, or D1) without Mike's explicit approval.** None.
5. **Price ceiling: $1.00 USDC per tool.** A tool is a small task — one specific thing an agent
   fails at, with the short content that unblocks it.
6. **Plain names only.** No metaphor vocabulary on any agent-facing surface. The selftest greps
   for banned words and fails on a hit.
7. **The test suite must encode the spec, not the implementation.** Any conformance fix lands
   together with a check that would have caught it — a check proven to fail the flawed version.
