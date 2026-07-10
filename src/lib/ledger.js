/**
 * Operational ledger — D1. Records of money and traffic: payments,
 * deliveries, request log. D1 is a holding area for intake work and this
 * ledger; the serving path never reads tool data from it (the tools are
 * objects in KV/R2 — see inventory.js).
 */

export async function recordSettledSale(env, p) {
  await env.SW_DB.prepare(
    `INSERT INTO payments (id, sku, price_usd, amount_usdc_micros, payer, network, scheme, idempotency_key, status, tx_hash, settled_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'settled', ?9, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(p.id, p.sku, p.price_usd, p.amount_usdc_micros, p.payer || "", p.network, p.scheme, p.idempotency_key, p.tx_hash || "")
    .run();
}

export async function recordDelivery(env, paymentId, sku, contentHash) {
  await env.SW_DB.prepare(`INSERT INTO deliveries (id, payment_id, sku, content_hash) VALUES (?1, ?2, ?3, ?4)`)
    .bind(`del_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, paymentId, sku, contentHash || "")
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
