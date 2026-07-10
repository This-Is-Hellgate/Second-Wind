/** Free liveness proof: database reachable, inventory count, rail configured. */
import { countLive } from "../_lib/store.js";
import { SERVICE_NAME, CANONICAL_ORIGIN } from "../_lib/brand.js";

export async function onRequestGet(context) {
  const { env } = context;
  let liveCount = null;
  let dbOk = false;
  try {
    liveCount = await countLive(env);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return new Response(
    JSON.stringify(
      {
        service: SERVICE_NAME,
        status: dbOk ? "live" : "degraded",
        tools_live: liveCount,
        payment: {
          rail: "x402",
          x402Version: 2,
          network: "eip155:8453",
          asset: "USDC",
          payTo_configured: Boolean(env.X402_PAYTO_PUBLIC),
          facilitator_configured: Boolean(env.X402_FACILITATOR_URL),
        },
        discovery: {
          tools: `${CANONICAL_ORIGIN}/api/tools`,
          openapi: `${CANONICAL_ORIGIN}/openapi.json`,
          x402_resources: `${CANONICAL_ORIGIN}/v2/x402/discovery/resources`,
          well_known: `${CANONICAL_ORIGIN}/.well-known/x402`,
        },
      },
      null,
      2
    ),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
  );
}
