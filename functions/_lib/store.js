/**
 * Second Wind store — the ONLY reader of the D1 database (binding: SW_DB).
 * Every surface (tools listing, paid endpoints, openapi, x402 resources) is
 * generated from these queries, so surfaces cannot drift from the database.
 * Only status='live' rows are ever sold or discoverable.
 */

const ITEM_COLS =
  "sku, slug, name, item_type, service_slug, category_slug, price_usd, summary, source_repo, source_path, source_url, license_spdx, provenance, content_hash, version, updated_at";

export async function liveItems(env) {
  const { results } = await env.SW_DB.prepare(
    `SELECT ${ITEM_COLS} FROM catalog_items WHERE status = 'live' ORDER BY item_type, service_slug, sku`
  ).all();
  return results || [];
}

export async function liveItemBySku(env, sku) {
  return await env.SW_DB.prepare(
    `SELECT ${ITEM_COLS} FROM catalog_items WHERE status = 'live' AND (sku = ?1 OR slug = ?1)`
  )
    .bind(sku)
    .first();
}

export async function countLive(env) {
  const row = await env.SW_DB.prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE status = 'live'").first();
  return row?.n ?? 0;
}

/**
 * Record a verified payment. The UNIQUE partial index on idempotency_key is
 * the structural double-charge guard: a retry of the same signed payment is
 * rejected by the database itself, and the caller re-delivers for free.
 * Returns { inserted: true } or { inserted: false, existing } on duplicate.
 */
export async function recordVerifiedPayment(env, p) {
  try {
    await env.SW_DB.prepare(
      `INSERT INTO payments (id, sku, price_usd, amount_usdc_micros, payer, network, scheme, idempotency_key, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'verified')`
    )
      .bind(p.id, p.sku, p.price_usd, p.amount_usdc_micros, p.payer || "", p.network, p.scheme, p.idempotency_key)
      .run();
    return { inserted: true };
  } catch (err) {
    if (String(err?.message || err).includes("UNIQUE")) {
      const existing = await env.SW_DB.prepare("SELECT id, sku, status, tx_hash FROM payments WHERE idempotency_key = ?1")
        .bind(p.idempotency_key)
        .first();
      return { inserted: false, existing };
    }
    throw err;
  }
}

export async function markSettled(env, paymentId, txHash, facilitatorRef) {
  await env.SW_DB.prepare(
    `UPDATE payments SET status = 'settled', tx_hash = ?2, facilitator_ref = ?3, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`
  )
    .bind(paymentId, txHash || "", facilitatorRef || "")
    .run();
}

export async function markFailed(env, paymentId, reason) {
  await env.SW_DB.prepare(`UPDATE payments SET status = 'failed', facilitator_ref = ?2 WHERE id = ?1`)
    .bind(paymentId, String(reason || "").slice(0, 200))
    .run();
}

export async function recordDelivery(env, paymentId, sku, contentHash) {
  await env.SW_DB.prepare(
    `INSERT INTO deliveries (id, payment_id, sku, content_hash) VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(`del_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, paymentId, sku, contentHash)
    .run();
}

export async function logRequest(env, { path, sku, method, status, uaClass }) {
  try {
    await env.SW_DB.prepare(
      `INSERT INTO request_log (path, sku, method, status, ua_class) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(path, sku || "", method, status, uaClass || "")
      .run();
  } catch {
    /* logging must never break serving */
  }
}
