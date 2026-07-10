/**
 * Second Wind inventory — the tools ARE objects. KV holds text tools
 * (markdown / JSON) at `tool:<sku>`; R2 holds bundles (zips, scripts,
 * binaries). Publishing a tool means writing its object; the object store is
 * law. D1 is a holding area for intake work and the operational ledger — the
 * serving path never reads tool data from it.
 *
 * The KV key `manifest` is the single machine-readable index: an array of
 * stubs (the customer-facing few words + the operational record) written at
 * publish time alongside the object. Every surface — payment routes, the
 * tools listing, openapi.json, the discovery documents — is generated from
 * the manifest, so surfaces cannot drift from the shelfless truth: what is
 * IN the store is what is for sale.
 *
 * Stub fields:
 *   sku, slug, name, item_type, service, price_usd, summary,
 *   source { repo, path, url, license_spdx, provenance },
 *   content_hash, version, updated_at,
 *   store: "kv" | "r2", key (object key), mime_type
 */

export async function listTools(env) {
  if (!env.SW_KV) return [];
  try {
    const manifest = await env.SW_KV.get("manifest", "json");
    return Array.isArray(manifest) ? manifest : [];
  } catch {
    return [];
  }
}

export async function countTools(env) {
  return (await listTools(env)).length;
}

/** Find a stub by SKU or slug — both resolve, so advertised URLs never break. */
export async function findTool(env, key) {
  const tools = await listTools(env);
  return tools.find((t) => t.sku === key || t.slug === key) || null;
}

/**
 * Fetch the goods for a stub. KV tools return { content } (text); R2 bundles
 * return { object } (stream + metadata) for binary delivery.
 */
export async function getGoods(env, stub) {
  if (stub.store === "r2") {
    if (!env.SW_R2) return null;
    const object = await env.SW_R2.get(stub.key || `bundle:${stub.sku}`);
    return object ? { object } : null;
  }
  if (!env.SW_KV) return null;
  const content = await env.SW_KV.get(stub.key || `tool:${stub.sku}`);
  return content != null ? { content } : null;
}
