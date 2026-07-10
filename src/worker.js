/**
 * Second Wind gatekeeper — Hono on Cloudflare Workers running the OFFICIAL
 * x402 SDK (@x402/hono + @x402/core + @x402/evm). Cloudflare verifies payment
 * at the edge; the handler serves the goods (KV object, D1 record fallback);
 * the middleware settles ONLY after the handler succeeds — a buyer is never
 * charged for a failed response. AWS executes behind this gate when tools
 * need computation (Bedrock proxy slot, added with the first such tool).
 *
 * Pages "advanced mode": this file bundles to public/_worker.js (esbuild) and
 * takes over all routing; static assets pass through env.ASSETS.
 */
import { Hono } from "hono";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declarePaymentIdentifierExtension,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";

import { SERVICE_NAME, TAGLINE, CANONICAL_ORIGIN } from "../functions/_lib/brand.js";
import { liveItems, liveItemBySku, recordVerifiedPayment, markSettled, recordDelivery, logRequest, countLive } from "../functions/_lib/store.js";
import { buildOpenApi, buildX402Resources, discoveryJson } from "../functions/_lib/discovery.js";
import { buildCdpAuthHeaders, facilitatorPaths } from "../functions/_lib/cdp-auth.js";

const NETWORK = "eip155:8453"; // Base mainnet only, by design

/* ------------------------------------------------------------------ *
 * Payment server — official SDK, constructed per catalog snapshot
 * ------------------------------------------------------------------ */

/**
 * CDP facilitator client. createAuthHeaders returns per-path header maps per
 * the @x402/core FacilitatorConfig contract.
 */
function facilitatorClient(env) {
  const configured = env.X402_FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402";
  const paths = facilitatorPaths(configured);
  const client = new HTTPFacilitatorClient({
    url: `${paths.base}/platform/v2/x402`,
    createAuthHeaders: async () => ({
      verify: await buildCdpAuthHeaders(env, "POST", paths.verifyPath),
      settle: await buildCdpAuthHeaders(env, "POST", paths.settlePath),
      supported: await buildCdpAuthHeaders(env, "GET", "/platform/v2/x402/supported"),
    }),
  });
  // Offline test fixture: the selftest runs with no network, so it supplies
  // the facilitator /supported contract itself. Never set in production.
  if (env.X402_TEST_SUPPORTED_KINDS) {
    client.getSupported = async () => JSON.parse(env.X402_TEST_SUPPORTED_KINDS);
  }
  return client;
}

/** One RouteConfig per live tool, keyed by BOTH slug and sku paths. */
function routeForItem(item, payTo) {
  const url = `${CANONICAL_ORIGIN}/api/x402/${item.slug}`;
  return {
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        payTo,
        price: `$${item.price_usd.toFixed(2)}`,
      },
    ],
    description: `${item.name} — ${item.summary.slice(0, 140)}`,
    mimeType: "application/json",
    resource: url,
    serviceName: SERVICE_NAME,
    tags: [item.item_type, "aws", "x402"].slice(0, 5),
    iconUrl: `${CANONICAL_ORIGIN}/favicon.ico`,
    extensions: {
      ...declareDiscoveryExtension({
        type: "http",
        method: "GET",
        output: {
          type: "json",
          example: {
            sku: item.sku,
            name: item.name,
            item_type: item.item_type,
            service: item.service_slug,
            summary: item.summary.slice(0, 200),
            content_hash: item.content_hash,
          },
          schema: {
            type: "object",
            properties: {
              sku: { type: "string" },
              name: { type: "string" },
              item_type: { type: "string" },
              service: { type: "string" },
              summary: { type: "string" },
              content: { type: "string" },
              source: { type: "object" },
              content_hash: { type: "string" },
            },
            required: ["sku", "name", "summary", "content_hash"],
          },
        },
      }),
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
    },
  };
}

/**
 * The payment middleware is rebuilt when the live catalog changes; cached per
 * isolate for 60s so route lookups stay cheap without drifting from D1.
 */
const paymentCache = { middleware: null, expires: 0, count: -1 };

async function getPaymentMiddleware(env) {
  const now = Date.now();
  if (paymentCache.middleware && now < paymentCache.expires) return paymentCache.middleware;

  const items = await liveItems(env);
  const payTo = env.X402_PAYTO || env.X402_PAYTO_PUBLIC;
  if (!payTo) return null;

  const routes = {};
  for (const item of items) {
    const route = routeForItem(item, payTo);
    routes[`GET /api/x402/${item.slug}`] = route;
    if (item.sku !== item.slug) routes[`GET /api/x402/${item.sku}`] = route;
  }
  if (Object.keys(routes).length === 0) {
    paymentCache.middleware = "empty";
    paymentCache.expires = now + 60_000;
    return "empty";
  }

  const resourceServer = new x402ResourceServer(facilitatorClient(env))
    .register(NETWORK, new ExactEvmScheme())
    // Ledger: the record of every settled sale stays in D1. Errors here must
    // never break delivery — the settlement already happened on-chain.
    .onAfterSettle(async (context) => {
      try {
        const paymentId = `pay_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const sku = skuFromResourceUrl(context.paymentPayload?.resource?.url) || "";
        await recordVerifiedPayment(env, {
          id: paymentId,
          sku,
          price_usd: Number(context.requirements?.amount || 0) / 1_000_000,
          amount_usdc_micros: String(context.requirements?.amount || ""),
          payer: context.result?.payer || "",
          network: context.requirements?.network || NETWORK,
          scheme: context.requirements?.scheme || "exact",
          idempotency_key: `settle:${context.result?.transaction || crypto.randomUUID()}`,
        });
        await markSettled(env, paymentId, context.result?.transaction || "", "sdk");
        await recordDelivery(env, paymentId, sku, "");
      } catch (err) {
        console.log(JSON.stringify({ event: "ledger_write_failed", error: String(err?.message || err) }));
      }
    });

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  // Default sync: the middleware lazily fetches the facilitator's /supported
  // kinds (with CDP auth) on the first payment-relevant request.
  paymentCache.middleware = paymentMiddlewareFromHTTPServer(httpServer);
  paymentCache.expires = now + 60_000;
  paymentCache.count = items.length;
  return paymentCache.middleware;
}

function skuFromResourceUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/api\/x402\/([^/?#]+)/);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

const app = new Hono();

const JSON_HEADERS = { "Access-Control-Allow-Origin": "*" };

// Request logging — fire-and-forget, must never break serving.
app.use("*", async (c, next) => {
  await next();
  if (c.req.method === "OPTIONS") return;
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith("/api/")) return;
  const ua = (c.req.header("User-Agent") || "").toLowerCase();
  const uaClass = !ua
    ? "none"
    : /bot|crawl|spider|scan|probe|monitor/.test(ua)
      ? "crawler"
      : /python|node|curl|wget|go-http|axios|fetch/.test(ua)
        ? "agent"
        : "browser";
  c.executionCtx?.waitUntil?.(
    logRequest(c.env, {
      path,
      sku: path.startsWith("/api/x402/") ? path.split("/").pop() : "",
      method: c.req.method,
      status: c.res?.status ?? 0,
      uaClass,
    })
  );
});

// The old listing path stays reachable; the canonical URL is /api/tools.
app.all("/api/catalog", (c) => c.redirect(`/api/tools${new URL(c.req.url).search}`, 308));

// CORS preflight for the paid surface.
app.options("/api/*", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, Idempotency-Key",
  })
);

// Free: liveness proof.
app.get("/api/proof", async (c) => {
  let liveCount = null;
  let dbOk = false;
  try {
    liveCount = await countLive(c.env);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return c.json(
    {
      service: SERVICE_NAME,
      status: dbOk ? "live" : "degraded",
      tools_live: liveCount,
      payment: {
        rail: "x402",
        x402Version: 2,
        network: NETWORK,
        asset: "USDC",
        payTo_configured: Boolean(c.env.X402_PAYTO_PUBLIC || c.env.X402_PAYTO),
        facilitator_configured: Boolean(c.env.X402_FACILITATOR_URL),
      },
      discovery: {
        tools: `${CANONICAL_ORIGIN}/api/tools`,
        openapi: `${CANONICAL_ORIGIN}/openapi.json`,
        x402_resources: `${CANONICAL_ORIGIN}/v2/x402/discovery/resources`,
        well_known: `${CANONICAL_ORIGIN}/.well-known/x402`,
      },
    },
    200,
    JSON_HEADERS
  );
});

// Free: the tools listing.
app.get("/api/tools", async (c) => {
  const items = await liveItems(c.env);
  return c.json(
    {
      service: SERVICE_NAME,
      tagline: TAGLINE,
      total_live: items.length,
      payment: { rail: "x402", network: NETWORK, asset: "USDC", how: "GET any tool URL -> 402 -> sign -> retry with PAYMENT-SIGNATURE" },
      tools: items.map((i) => ({
        sku: i.sku,
        name: i.name,
        item_type: i.item_type,
        service: i.service_slug,
        price_usd: i.price_usd,
        summary: i.summary,
        url: `${CANONICAL_ORIGIN}/api/x402/${i.slug}`,
      })),
    },
    200,
    { ...JSON_HEADERS, "Cache-Control": "public, max-age=300" }
  );
});

// Free: generated discovery documents (one source: the live D1 rows).
app.get("/openapi.json", async (c) => discoveryJson(await buildOpenApi(c.env, new URL(c.req.url).origin)));
app.get("/v2/x402/discovery/resources", async (c) => discoveryJson(await buildX402Resources(c.env, new URL(c.req.url).origin)));
app.get("/.well-known/x402", async (c) => discoveryJson(await buildX402Resources(c.env, new URL(c.req.url).origin)));

// Paid surface — the OFFICIAL SDK middleware verifies before the handler and
// settles after it succeeds. A buyer is never charged for a failed response.
app.use("/api/x402/*", async (c, next) => {
  const middleware = await getPaymentMiddleware(c.env);
  if (!middleware) return c.json({ error: "payment_rail_not_configured" }, 503, JSON_HEADERS);
  if (middleware === "empty") return next(); // no live tools: handler 404s below
  return middleware(c, next);
});

app.get("/api/x402/:key", async (c) => {
  const item = await liveItemBySku(c.env, c.req.param("key"));
  if (!item) {
    return c.json({ error: "unknown_sku", tools: "/api/tools" }, 404, JSON_HEADERS);
  }
  // The goods: KV object when stocked (markdown/JSON), D1 record always.
  let content = null;
  try {
    content = (await c.env.SW_KV?.get?.(`tool:${item.sku}`)) ?? null;
  } catch {
    content = null;
  }
  return c.json(
    {
      sku: item.sku,
      name: item.name,
      item_type: item.item_type,
      service: item.service_slug,
      summary: item.summary,
      ...(content ? { content } : {}),
      source: {
        repo: item.source_repo,
        path: item.source_path,
        url: item.source_url,
        license_spdx: item.license_spdx,
        provenance: item.provenance,
      },
      content_hash: item.content_hash,
      version: item.version,
    },
    200,
    JSON_HEADERS
  );
});

// Teaching 405 for wrong methods on known surfaces.
app.all("/api/*", (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.json({ error: "unknown_path", tools: "/api/tools", openapi: "/openapi.json" }, 404, JSON_HEADERS);
  }
  return c.json(
    {
      error: "method_not_allowed",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      hint: "All Second Wind surfaces are GET. Paid tools: GET /api/x402/{sku}. The exact method per path is declared in openapi.json.",
      docs: { openapi: `${new URL(c.req.url).origin}/openapi.json`, tools: `${new URL(c.req.url).origin}/api/tools` },
    },
    405,
    JSON_HEADERS
  );
});

// Everything else: static assets (llms.txt, agent card, favicons).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  // HEAD mirrors GET everywhere (headers only) — agents probe with HEAD.
  async fetch(request, env, ctx) {
    if (request.method === "HEAD") {
      const asGet = new Request(request.url, { method: "GET", headers: request.headers });
      const res = await app.fetch(asGet, env, ctx);
      return new Response(null, { status: res.status, headers: res.headers });
    }
    return app.fetch(request, env, ctx);
  },
};

export { app };
