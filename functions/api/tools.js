/** Free tools listing — every live tool with its URL and price. */
import { liveItems } from "../_lib/store.js";
import { SERVICE_NAME, TAGLINE, CANONICAL_ORIGIN } from "../_lib/brand.js";

export async function onRequestGet(context) {
  const items = await liveItems(context.env);
  const tools = items.map((i) => ({
    sku: i.sku,
    name: i.name,
    item_type: i.item_type,
    service: i.service_slug,
    price_usd: i.price_usd,
    summary: i.summary,
    url: `${CANONICAL_ORIGIN}/api/x402/${i.slug}`,
  }));
  return new Response(
    JSON.stringify(
      {
        service: SERVICE_NAME,
        tagline: TAGLINE,
        total_live: tools.length,
        payment: { rail: "x402", network: "eip155:8453", asset: "USDC", how: "GET any tool URL -> 402 -> sign -> retry with PAYMENT-SIGNATURE" },
        tools,
      },
      null,
      2
    ),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } }
  );
}
