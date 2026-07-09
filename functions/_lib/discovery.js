/**
 * Second Wind discovery — openapi.json, the x402 resources document, and
 * /.well-known/x402 are ALL generated here from the live catalog rows
 * (functions/_lib/store.js). One source; surfaces cannot drift.
 */
import { CANONICAL_ORIGIN, SERVICE_NAME, TAGLINE } from "./brand.js";
import { liveItems } from "./store.js";

export function discoveryJson(obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      ...extraHeaders,
    },
  });
}

function doorPath(item) {
  // Advertise the slug, not the SKU: in a marketplace listing the URL is the
  // headline, and an agent ranking 112 resources matches on the path before
  // it reads a description. bedrock-agent-action-group-recipe self-describes;
  // AWS-0563 says nothing. The door handler accepts BOTH (sku OR slug), so
  // every previously advertised SKU URL keeps working forever.
  return `/api/x402/${item.slug}`;
}

function doorGuidance(item) {
  return {
    call_when: item.summary,
    price_usd: item.price_usd,
    first_call: `GET ${doorPath(item)} returns 402 with a PAYMENT-REQUIRED header (base64 JSON payment requirements).`,
    pay: "Sign USDC on Base (eip155:8453) via ExactEvmScheme (@x402/fetch) and retry the SAME request with the PAYMENT-SIGNATURE header.",
    inputs: "GET only — the answer is a pure function of the SKU; no query or body inputs.",
    idempotent: "Deterministic: same SKU, same answer on every retry. A retried signed payment is never charged twice — re-delivery is free.",
    deliverable: "The exact GitHub coordinate and usage brief: repo, path, what it does, the gotcha — without cloning the monorepo.",
  };
}

export async function buildOpenApi(env, origin = CANONICAL_ORIGIN) {
  const items = await liveItems(env);
  const paths = {};

  for (const item of items) {
    paths[doorPath(item)] = {
      get: {
        operationId: `${item.slug}_get`,
        summary: item.summary.slice(0, 120),
        description: `${item.summary} Session-less x402 door — pay one nano payment (USDC on Base) and receive the coordinate. ~$${item.price_usd} USDC.`,
        tags: ["paid", "x402", item.item_type, item.service_slug],
        "x-price-usd": item.price_usd,
        "x-payment-info": {
          rail: "x402",
          protocols: ["x402"],
          x402Version: 2,
          price_usd: item.price_usd,
          price: { mode: "fixed", currency: "USD", amount: item.price_usd.toFixed(2) },
          asset: "USDC",
          network: "eip155:8453",
          scheme: "ExactEvmScheme",
        },
        security: [{ x402Payment: [] }],
        "x-guidance": doorGuidance(item),
        responses: {
          200: { description: "Paid. Body carries the item: source repo, exact path, usage summary, license, provenance, content hash, and the settlement receipt." },
          402: { description: "Unpaid. PAYMENT-REQUIRED header carries base64 JSON payment requirements; retry the same URL with PAYMENT-SIGNATURE." },
        },
      },
    };
  }

  for (const s of [
    { path: "/api/proof", rel: "proof", summary: "Free liveness and inventory proof: live item count, payment rail configuration, database reachability." },
    { path: "/api/catalog", rel: "catalog", summary: "Free full catalog: every live item with SKU, type, service, price, and summary." },
  ]) {
    paths[s.path] = {
      get: {
        operationId: `${s.rel}_get`,
        summary: s.summary,
        description: `${s.summary} Free, unpaid surface.`,
        tags: ["free", "discovery"],
        security: [],
        responses: { 200: { description: s.summary } },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${SERVICE_NAME} — AWS-native parts counter for agents`,
      summary: TAGLINE,
      description:
        "Second Wind sells exact GitHub coordinates for AWS-native building: which repo, which path, what it does, and the gotcha — so an agent building an AWS product uses the tool it needs without cloning the monorepo. Diagnostics, CDK constructs, SDK tools, recipes, templates, manifests, auth flows, cost models, and decision frameworks. Every paid door is session-less: discover, pay USDC on Base via x402, use.",
      version: "1.0.0",
      "x-audience": "autonomous_agents",
      contact: { url: `${origin}/llms.txt`, email: "info@secondeyesai.com" },
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        x402Payment: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description:
            "x402 v2. First call returns 402 + PAYMENT-REQUIRED header (base64 JSON). Sign USDC on Base (eip155:8453, ExactEvmScheme) and retry the same URL with PAYMENT-SIGNATURE.",
        },
      },
    },
    paths,
  };
}

export async function buildX402Resources(env, origin = CANONICAL_ORIGIN) {
  const items = await liveItems(env);
  return {
    schema_version: 1,
    x402Version: 2,
    service: SERVICE_NAME,
    payment: { rail: "x402", network: "eip155:8453", asset: "USDC", scheme: "ExactEvmScheme" },
    resources: items.map((item) => ({
      resource: `${origin}${doorPath(item)}`,
      type: "http",
      method: "GET",
      methods: ["GET"],
      x402: true,
      accepts: ["eip155:8453"],
      network: "eip155:8453",
      asset: "USDC",
      scheme: "ExactEvmScheme",
      price_usd: item.price_usd,
      slug: item.slug,
      item_type: item.item_type,
      service: item.service_slug,
      summary: item.summary,
    })),
    links: { openapi: `${origin}/openapi.json`, catalog: `${origin}/api/catalog`, llms: `${origin}/llms.txt` },
  };
}
