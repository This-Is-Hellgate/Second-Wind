/**
 * x402 extension metadata — repo-side support for the v2 extension surface beyond
 * the baseline accepts[]/PAYMENT-REQUIRED flow in x402.js.
 *
 * Every extension here is METADATA + DETERMINISTIC LOGIC the server can emit and a
 * client can read. Anything that needs a live facilitator or an on-chain action
 * (batch redemption, real authorize/capture settlement, ERC20 gas sponsorship) is
 * declared with `live: false` and a `blocked_reason`, because the CDP facilitator
 * we settle through does not yet expose those calls. The repo-side model, types,
 * idempotency, and receipt signing are real and tested; the live rail is not faked.
 *
 * Wire shape mirrors @x402/extensions: each builder returns { <key>: { info, schema? } }
 * so several can be spread into one `extensions` object on a PaymentRequirements.
 */

import { SERVICE_NAME, CANONICAL_ORIGIN } from "./brand.js";

export const ICON_URL = `${CANONICAL_ORIGIN}/favicon.ico`;

/** CAIP-2 for Base mainnet — the canonical rail (matches x402-networks BASE_NETWORK.id). */
export const BASE_CAIP2 = "eip155:8453";

/** USDC on Base (matches x402-networks USDC_BASE). */
export const USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913";

/* ------------------------------------------------------------------ *
 * Bazaar discovery metadata
 * ------------------------------------------------------------------ */

/**
 * Bazaar listing metadata an indexer reads to catalog the resource: serviceName,
 * tags, iconUrl. Kept separate from the bazaar input/output schema in x402.js so a
 * product can advertise listing identity without re-deriving its callable schema.
 */
export function bazaarMetadataExtension(product = {}) {
  const tags = Array.isArray(product.tags) && product.tags.length
    ? product.tags
    : defaultTags(product);
  return {
    bazaar_metadata: {
      info: {
        serviceName: product.serviceName || SERVICE_NAME,
        tags,
        iconUrl: product.iconUrl || ICON_URL,
      },
    },
  };
}

function defaultTags(product) {
  const base = ["x402", "agents", "second-eyes"];
  if (product.kind) base.push(product.kind);
  if (product.slug) base.push(product.slug);
  return base;
}

/* ------------------------------------------------------------------ *
 * Payment-identifier extension + idempotency
 * ------------------------------------------------------------------ */

/**
 * Declares a REQUIRED payment identifier so a retried payment is recognized as the
 * same charge and never double-billed. `required: true` is the teardown contract.
 * The identifier the client must echo is `identifierField` (Idempotency-Key header
 * or paymentId in the payload); the server keys settlement on it (see
 * isDuplicatePaymentId / a4a-store idempotency helpers).
 */
export function paymentIdentifierExtension() {
  return {
    payment_identifier: {
      info: {
        required: true,
        identifierField: "Idempotency-Key",
        payloadField: "paymentId",
        behavior: "idempotent",
        note:
          "Echo a stable Idempotency-Key (or paymentId in the signed payload) on retries. " +
          "The server returns the original receipt for a repeated identifier and never " +
          "settles the same logical payment twice.",
      },
    },
  };
}

/**
 * Pure idempotency decision: given the identifier a client sent and the set of
 * identifiers already seen, decide whether this is a fresh charge or a duplicate.
 * No I/O — the caller supplies `seen` (e.g. from D1). Returns the canonical key so
 * callers store/look up under one normalized value.
 */
export function paymentIdentityDecision(identifier, seen = new Set()) {
  const key = normalizeIdentifier(identifier);
  if (!key) return { ok: true, key: null, duplicate: false, reason: "no_identifier" };
  if (seen.has(key)) return { ok: false, key, duplicate: true, reason: "duplicate_payment_identifier" };
  return { ok: true, key, duplicate: false };
}

export function normalizeIdentifier(identifier) {
  if (!identifier) return null;
  const s = String(identifier).trim();
  return s.length ? s.toLowerCase() : null;
}

/** Extract a payment identifier from request headers or a parsed payload. */
export function readPaymentIdentifier(request, payload = null) {
  const headerKey =
    request?.headers?.get?.("Idempotency-Key") ||
    request?.headers?.get?.("X-Idempotency-Key") ||
    null;
  const payloadKey =
    payload?.paymentId || payload?.payment_id || payload?.nonce || null;
  return normalizeIdentifier(headerKey || payloadKey);
}

/* ------------------------------------------------------------------ *
 * Auth-hints extension
 * ------------------------------------------------------------------ */

/**
 * Tells a client what authorization the resource expects AFTER payment (the access
 * token rail) and what wallet posture to use BEFORE paying. Pure metadata.
 */
export function authHintsExtension() {
  return {
    auth_hints: {
      info: {
        wallet: "dedicated-low-balance-base-usdc",
        wallet_rule: "Never sign from a primary/high-balance wallet.",
        post_payment_auth: "Bearer",
        token_source: "200 response body accessToken / X-PAYMENT-RESPONSE receipt",
        signature_header: "PAYMENT-SIGNATURE",
        requirements_header: "PAYMENT-REQUIRED",
        scheme: "ExactEvmScheme",
        network: BASE_CAIP2,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Batch-settlement extension  (repo-side support; live redemption BLOCKED)
 * ------------------------------------------------------------------ */

/**
 * Commitment model for batch settlement: a client accrues N micro-charges under one
 * commitment and the operator redeems them together. Repo-side we model the
 * commitment, accumulate line items, and compute the redeemable total. LIVE on-chain
 * batch redemption is BLOCKED — the CDP facilitator settles one authorization per
 * verify/settle and exposes no batch-redeem call — so `live: false`.
 */
export function batchSettlementExtension() {
  return {
    batch_settlement: {
      info: {
        supported: true,
        live: false,
        blocked_reason:
          "CDP facilitator settles one authorization per verify/settle; no batch-redeem endpoint. " +
          "Repo-side commitment model + accumulation are implemented and tested; on-chain redemption is blocked.",
        model: "commitment",
        network: BASE_CAIP2,
        asset: USDC_BASE_ASSET,
      },
    },
  };
}

/** Open a batch commitment the client can accrue micro-charges against. */
export function openBatchCommitment({ payer, maxTotalMicros, window_seconds = 3600 } = {}) {
  const now = Date.now();
  return {
    type: "x402.batch.commitment",
    version: 1,
    commitmentId: `bc_${randomHex(8)}`,
    payer: payer || null,
    network: BASE_CAIP2,
    asset: USDC_BASE_ASSET,
    maxTotalMicros: String(maxTotalMicros ?? "0"),
    accruedMicros: "0",
    items: [],
    status: "open",
    openedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + window_seconds * 1000).toISOString(),
  };
}

/**
 * Add a line item to a commitment. Pure — returns a NEW commitment object. Rejects
 * when the item would push accrued past maxTotalMicros (the cap the payer signed).
 */
export function accrueToCommitment(commitment, { amountMicros, ref } = {}) {
  if (!commitment || commitment.status !== "open") {
    return { ok: false, error: "commitment_not_open" };
  }
  const add = BigInt(String(amountMicros ?? "0"));
  if (add <= 0n) return { ok: false, error: "invalid_amount" };
  const accrued = BigInt(commitment.accruedMicros) + add;
  const cap = BigInt(commitment.maxTotalMicros);
  if (cap > 0n && accrued > cap) {
    return { ok: false, error: "commitment_cap_exceeded", accruedMicros: commitment.accruedMicros, cap: commitment.maxTotalMicros };
  }
  const next = {
    ...commitment,
    accruedMicros: String(accrued),
    items: [...commitment.items, { amountMicros: String(add), ref: ref || null, at: new Date().toISOString() }],
  };
  return { ok: true, commitment: next };
}

/** Close a commitment and produce the redeemable total (repo-side; not settled live). */
export function closeBatchCommitment(commitment) {
  if (!commitment) return { ok: false, error: "no_commitment" };
  return {
    ok: true,
    commitment: { ...commitment, status: "closed", closedAt: new Date().toISOString() },
    redeemableMicros: commitment.accruedMicros,
    itemCount: commitment.items.length,
    live_redemption: false,
    blocked_reason: "On-chain batch redemption requires a facilitator batch-redeem call not exposed by CDP.",
  };
}

/* ------------------------------------------------------------------ *
 * Auth-capture extension  (repo-side support; live capture BLOCKED)
 * ------------------------------------------------------------------ */

/**
 * Authorize-then-capture model: authorize a MAX, capture the ACTUAL (≤ max), with
 * void/release and a refund window. Repo-side state machine + metadata are real;
 * LIVE capture/void against the chain is BLOCKED (CDP verify/settle captures the
 * full signed amount immediately — there is no separate hold/capture call).
 */
export function authCaptureExtension({ refundWindowSeconds = 86400 } = {}) {
  return {
    auth_capture: {
      info: {
        supported: true,
        live: false,
        blocked_reason:
          "CDP verify/settle captures the full signed amount at settle; no separate authorize-hold/capture/void call. " +
          "Repo-side authorize→capture→void/refund state machine is implemented and tested; live partial capture is blocked.",
        operations: ["authorize", "capture", "void", "refund"],
        refund_window_seconds: refundWindowSeconds,
        network: BASE_CAIP2,
      },
    },
  };
}

/** Authorize a maximum amount (a hold). Pure repo-side state object. */
export function authorizeMax({ payer, maxAmountMicros, refundWindowSeconds = 86400 } = {}) {
  const now = Date.now();
  return {
    type: "x402.auth.hold",
    version: 1,
    authId: `ah_${randomHex(8)}`,
    payer: payer || null,
    network: BASE_CAIP2,
    asset: USDC_BASE_ASSET,
    maxAmountMicros: String(maxAmountMicros ?? "0"),
    capturedMicros: "0",
    status: "authorized",
    authorizedAt: new Date(now).toISOString(),
    refundableUntil: new Date(now + refundWindowSeconds * 1000).toISOString(),
  };
}

/** Capture the actual amount (≤ authorized max). Pure — returns new state. */
export function captureActual(hold, actualMicros) {
  if (!hold || hold.status !== "authorized") return { ok: false, error: "not_authorized" };
  const actual = BigInt(String(actualMicros ?? "0"));
  const max = BigInt(hold.maxAmountMicros);
  if (actual <= 0n) return { ok: false, error: "invalid_capture_amount" };
  if (actual > max) return { ok: false, error: "capture_exceeds_authorization", maxAmountMicros: hold.maxAmountMicros };
  return {
    ok: true,
    hold: { ...hold, capturedMicros: String(actual), status: "captured", capturedAt: new Date().toISOString() },
    live_capture: false,
  };
}

/** Void/release an unused authorization. */
export function voidAuthorization(hold) {
  if (!hold || (hold.status !== "authorized" && hold.status !== "captured")) {
    return { ok: false, error: "not_voidable" };
  }
  return { ok: true, hold: { ...hold, status: "voided", voidedAt: new Date().toISOString() }, live_void: false };
}

/* ------------------------------------------------------------------ *
 * EIP-2612 / ERC20 gas-sponsorship extension  (metadata; live sponsorship BLOCKED)
 * ------------------------------------------------------------------ */

/**
 * Declares that USDC on Base supports EIP-2612 `permit` (gasless approval) so a
 * sponsor could pay gas. Metadata + hook surface are repo-side; LIVE relaying of a
 * sponsored permit is BLOCKED — we do not run a paymaster/relayer and the CDP
 * facilitator does not sponsor gas on our behalf.
 */
export function eip2612SponsorshipExtension() {
  return {
    eip2612_sponsorship: {
      info: {
        supported: true,
        live: false,
        blocked_reason:
          "No paymaster/relayer is operated and the CDP facilitator does not sponsor gas. " +
          "permit() metadata + the sponsorship request hook are repo-side; live sponsored relay is blocked.",
        token: USDC_BASE_ASSET,
        network: BASE_CAIP2,
        permit: { standard: "EIP-2612", primaryType: "Permit", version: "2" },
      },
    },
  };
}

/**
 * Build the EIP-712 typed-data skeleton for a USDC permit on Base. Repo-side helper
 * a client/sponsor would fill (owner/spender/value/deadline) and sign. We never sign
 * or relay it ourselves.
 */
export function buildPermitTypedData({ owner, spender, value, nonce, deadline } = {}) {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE_ASSET },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: owner || null,
      spender: spender || null,
      value: String(value ?? "0"),
      nonce: String(nonce ?? "0"),
      deadline: String(deadline ?? "0"),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Offer-and-receipt extension  (signed, deterministic)
 * ------------------------------------------------------------------ */

/**
 * Offer extension: declares that the server emits a signed, deterministic receipt
 * proving the terms offered and (after settlement) the delivery. The receipt is
 * HMAC-signed with X402_RECEIPT_SECRET (falls back to ACCESS_TOKEN_SECRET).
 */
export function offerReceiptExtension() {
  return {
    offer_receipt: {
      info: {
        supported: true,
        signed: true,
        deterministic: true,
        algorithm: "HMAC-SHA256",
        canonicalization: "sorted-keys-json",
        proves: ["terms", "delivery"],
        verify: "Recompute HMAC over the canonical receipt (minus `signature`) with the shared secret.",
      },
    },
  };
}

/**
 * Canonical JSON: object keys sorted recursively so the SAME logical receipt always
 * serializes to the SAME bytes — the basis for a deterministic signature.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortValue(value[k]);
    return out;
  }
  return value;
}

function receiptSecret(env) {
  return (env && (env.X402_RECEIPT_SECRET || env.ACCESS_TOKEN_SECRET)) || null;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Build the unsigned, deterministic offer/receipt body. `terms` proves what was
 * offered; `delivery` (optional) proves what was delivered after settlement.
 */
export function buildReceiptBody({ offerId, product = {}, terms = {}, delivery = null, paymentId = null }) {
  const body = {
    type: "x402.offer.receipt",
    version: 1,
    offerId: offerId || `of_${randomHex(8)}`,
    issuer: SERVICE_NAME,
    network: BASE_CAIP2,
    asset: USDC_BASE_ASSET,
    paymentId: paymentId || null,
    terms: {
      resource: terms.resource || null,
      amountMicros: terms.amountMicros != null ? String(terms.amountMicros) : null,
      priceUsd: terms.priceUsd ?? product.priceUsd ?? null,
      productId: terms.productId || product.id || null,
      scheme: terms.scheme || "ExactEvmScheme",
    },
    delivery: delivery
      ? {
          transaction: delivery.transaction || null,
          payer: delivery.payer || null,
          grantId: delivery.grantId || null,
          deliveredAt: delivery.deliveredAt || new Date().toISOString(),
        }
      : null,
  };
  return body;
}

/** Sign a receipt body deterministically. Returns { ...body, signature }. */
export async function signReceipt(body, env) {
  const secret = receiptSecret(env);
  if (!secret) {
    return { ...body, signature: null, signed: false, note: "X402_RECEIPT_SECRET/ACCESS_TOKEN_SECRET not configured" };
  }
  const signature = await hmacSha256Hex(secret, canonicalJson(body));
  return { ...body, signature, signed: true, alg: "HMAC-SHA256" };
}

/** Verify a signed receipt: recompute HMAC over the canonical body sans signature. */
export async function verifyReceipt(receipt, env) {
  const secret = receiptSecret(env);
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!receipt || !receipt.signature) return { ok: false, reason: "no_signature" };
  const { signature, signed, alg, note, ...body } = receipt;
  const expected = await hmacSha256Hex(secret, canonicalJson(body));
  const ok = timingSafeEqualHex(expected, signature);
  return { ok, reason: ok ? "valid" : "signature_mismatch" };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Aggregate
 * ------------------------------------------------------------------ */

/**
 * Merge every extension this server advertises into one `extensions` object,
 * spreadable onto a PaymentRequirements alongside the existing bazaar schema
 * (x402.js bazaarExtension). Pure — no secret reads, safe for the 402 body.
 */
export function allExtensions(product = {}) {
  return {
    ...bazaarMetadataExtension(product),
    ...paymentIdentifierExtension(),
    ...authHintsExtension(),
    ...offerReceiptExtension(),
    ...batchSettlementExtension(),
    ...authCaptureExtension(),
    ...eip2612SponsorshipExtension(),
  };
}

/**
 * Compact extensions for the PAYMENT-REQUIRED header. The Coinbase Python
 * x402_action_provider extracts discoveryInfo from the DECODED header object
 * (make_http_request: payment_data.get("extensions")), so the only extension
 * data that reaches a Python agent's discoveryInfo is whatever rides the header.
 * The full allExtensions() block (with the Bazaar input/output schema and the
 * deterministic offer/receipt/batch/auth-capture metadata) is multi-KB and stays
 * in the 402 JSON body — putting it in the header would reintroduce exactly the
 * bloat the header-size gate prevents. This carries only the small listing
 * identity (serviceName/tags/iconUrl) an indexer/agent actually wants up front.
 */
export function headerDiscoveryExtensions(product = {}) {
  return { ...bazaarMetadataExtension(product) };
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}
