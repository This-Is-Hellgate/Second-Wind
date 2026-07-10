/**
 * Second Wind paid endpoint — GET /api/x402/{sku}.
 * 402 until paid; on a valid PAYMENT-SIGNATURE: verify -> record (structural
 * idempotency) -> settle -> deliver. A retried signed payment hits the UNIQUE
 * idempotency index and is re-delivered free — the database itself refuses a
 * second charge. A payment whose settlement previously FAILED may retry
 * settlement under its original record (never a second charge).
 */
import {
  buildProductPaymentRequirements,
  payment402BodyForProduct,
  payment402Headers,
  readPaymentHeader,
  verifyPaymentHeader,
  settleBuiltPayment,
  usdToUsdcMicros,
  parsePaymentPayloadFromHeader,
  paymentResponseHeaders,
  failedSettlementResponse,
} from "../../_lib/x402.js";
// Official helper: reads extensions["payment-identifier"].info.id (validated)
// from the client's PaymentPayload per specs/extensions/payment_identifier.md.
import { extractPaymentIdentifier } from "@x402/extensions/payment-identifier";
import { liveItemBySku, recordVerifiedPayment, markSettled, markFailed, recordDelivery } from "../../_lib/store.js";

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, Idempotency-Key",
    },
  });
}

function deliverable(item, receipt) {
  return {
    sku: item.sku,
    name: item.name,
    item_type: item.item_type,
    service: item.service_slug,
    summary: item.summary,
    source: {
      repo: item.source_repo,
      path: item.source_path,
      url: item.source_url,
      license_spdx: item.license_spdx,
      provenance: item.provenance,
    },
    content_hash: item.content_hash,
    version: item.version,
    receipt: receipt || null,
  };
}

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const item = await liveItemBySku(env, params.sku);
  if (!item) {
    return json({ error: "unknown_sku", tools: "/api/tools" }, 404);
  }

  const product = {
    kind: item.item_type,
    id: item.sku,
    slug: item.slug,
    priceUsd: item.price_usd,
    description: `${item.name} — ${item.summary.slice(0, 140)}`,
    summary: item.summary,
    contentHash: item.content_hash,
    service: item.service_slug,
  };
  const requirements = buildProductPaymentRequirements(product, request.url, env);
  if (!requirements) {
    return json({ error: "payment_rail_not_configured" }, 503);
  }

  const paymentHeader = readPaymentHeader(request);
  if (!paymentHeader) {
    const body = payment402BodyForProduct(requirements, product, null, undefined, request.url);
    return json(body, 402, payment402Headers(requirements, null));
  }

  const verified = await verifyPaymentHeader(paymentHeader, requirements, env);
  if (!verified.ok) {
    const body = payment402BodyForProduct(requirements, product, verified.error || "Payment verification failed.", undefined, request.url);
    return json(body, 402, payment402Headers(requirements, verified.error));
  }

  // Structural double-charge guard: one row per signed payment, enforced by
  // the UNIQUE partial index on payments.idempotency_key. Key priority per
  // specs/extensions/payment_identifier.md: client id from the PaymentPayload
  // extension (scoped by sku so the same id on another resource cannot
  // collide), then the Idempotency-Key header, then a digest of the signature.
  const clientPaymentId = extractPaymentIdentifier(parsePaymentPayloadFromHeader(paymentHeader) || {});
  const idemKey =
    (clientPaymentId ? `${item.sku}:${clientPaymentId}` : null) ||
    request.headers.get("Idempotency-Key") ||
    (await (async () => {
      const data = new TextEncoder().encode(paymentHeader);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
    })());

  const paymentId = `pay_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const rec = await recordVerifiedPayment(env, {
    id: paymentId,
    sku: item.sku,
    price_usd: item.price_usd,
    amount_usdc_micros: String(usdToUsdcMicros(item.price_usd)),
    payer: verified.built?.paymentPayload?.payload?.authorization?.from || "",
    network: verified.accept?.network || "eip155:8453",
    scheme: verified.accept?.scheme || "exact",
    idempotency_key: idemKey,
  });

  let settlePaymentId = paymentId;
  if (!rec.inserted) {
    if (rec.existing?.status === "settled") {
      const receipt = {
        success: true,
        transaction: rec.existing.tx_hash || "",
        network: verified.accept?.network || "eip155:8453",
        payer: verified.built?.paymentPayload?.payload?.authorization?.from || "",
      };
      return json(
        { ...deliverable(item, { ...receipt, note: "already_settled_no_second_charge" }), redelivery: true },
        200,
        paymentResponseHeaders(receipt)
      );
    }
    if (rec.existing?.status !== "failed") {
      return json({ error: "payment_in_progress", note: "This signed payment is being processed. Do not re-sign; retry shortly." }, 409);
    }
    // Previous settlement attempt failed — retry settlement under the ORIGINAL
    // payment record so the guard still sees exactly one row for this payment.
    settlePaymentId = rec.existing.id;
  }

  const settled = await settleBuiltPayment(verified.built, verified.accept, env);
  if (!settled.ok) {
    await markFailed(env, settlePaymentId, settled.error);
    const body = payment402BodyForProduct(requirements, product, settled.error || "Payment settlement failed.", undefined, request.url);
    // Per the v2 flow the settlement outcome rides PAYMENT-RESPONSE on failure
    // too — official SDK clients read paymentStatus (settle_failed) from it.
    return json(body, 402, {
      ...payment402Headers(requirements, settled.error),
      ...paymentResponseHeaders(failedSettlementResponse(settled.error, verified.accept?.network)),
    });
  }

  await markSettled(env, settlePaymentId, settled.receipt?.transaction, settled.bazaar ? "bazaar" : "");
  await recordDelivery(env, settlePaymentId, item.sku, item.content_hash);

  return json(deliverable(item, settled.receipt), 200, paymentResponseHeaders(settled.receipt));
}
