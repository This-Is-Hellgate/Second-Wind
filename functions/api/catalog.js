/** Free full catalog — every live item with its door and price. */
import { liveItems } from "../_lib/store.js";
import { SERVICE_NAME, TAGLINE, CANONICAL_ORIGIN } from "../_lib/brand.js";

export async function onRequestGet(context) {
  const items = await liveItems(context.env);
  const shelves = {};
  for (const i of items) {
    (shelves[i.item_type] ||= []).push({
      sku: i.sku,
      name: i.name,
      service: i.service_slug,
      price_usd: i.price_usd,
      summary: i.summary,
      door: `${CANONICAL_ORIGIN}/api/x402/${i.sku}`,
    });
  }
  return new Response(
    JSON.stringify(
      {
        service: SERVICE_NAME,
        tagline: TAGLINE,
        total_live: items.length,
        payment: { rail: "x402", network: "eip155:8453", asset: "USDC", how: "GET any door -> 402 -> sign -> retry with PAYMENT-SIGNATURE" },
        shelves,
      },
      null,
      2
    ),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } }
  );
}
