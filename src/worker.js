/**
 * Second Wind gatekeeper — Hono on Cloudflare Workers running the OFFICIAL
 * x402 SDK (@x402/hono + @x402/core + @x402/evm). Cloudflare verifies payment
 * at the edge; the handler serves the goods; the middleware settles ONLY
 * after the handler succeeds — a buyer is never charged for a failed
 * response. AWS executes behind this gate when tools need computation
 * (Bedrock proxy slot, added with the first such tool).
 *
 * Product model: the deliverable is the RESOLVED, INVOCABLE CAPABILITY plus
 * the judgment around it — never a file dump. D1 holds the curated index and
 * the relationship graph (the moat) plus the operational ledger; R2 holds the
 * occasional genuine artifact, reached only through a resolved response.
 * Bulk raw access deliberately does not exist.
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
import {
  declarePaymentIdentifierExtension,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";

import { SERVICE_NAME, TAGLINE, CANONICAL_ORIGIN } from "./lib/brand.js";
import { liveStubs, countLive, findItem, resolveCapability, getArtifact } from "./lib/curation.js";
import { recordSettledSale, recordDelivery, logRequest } from "./lib/ledger.js";
import { buildOpenApi, buildX402Resources, discoveryJson, toolBazaarExtension } from "./lib/discovery.js";
import { buildCdpAuthHeaders, facilitatorPaths } from "./lib/cdp-auth.js";
import { activeNetwork, activePayTo, activeFacilitatorUrl, isCdpFacilitator } from "./lib/networks.js";
import { invokeAgent } from "./lib/bedrock.js";

/* ------------------------------------------------------------------ *
 * Payment server — official SDK, constructed per curated-index snapshot
 * ------------------------------------------------------------------ */

/**
 * Facilitator client. Plain URL for open facilitators (x402.org testnet);
 * CDP gets createAuthHeaders (per-path CDP JWTs) per the @x402/core
 * FacilitatorConfig contract.
 */
function facilitatorClient(env) {
  const configured = activeFacilitatorUrl(env);
  let client;
  if (isCdpFacilitator(configured)) {
    const paths = facilitatorPaths(configured);
    client = new HTTPFacilitatorClient({
      url: `${paths.base}/platform/v2/x402`,
      createAuthHeaders: async () => ({
        verify: await buildCdpAuthHeaders(env, "POST", paths.verifyPath),
        settle: await buildCdpAuthHeaders(env, "POST", paths.settlePath),
        supported: await buildCdpAuthHeaders(env, "GET", "/platform/v2/x402/supported"),
      }),
    });
  } else {
    client = new HTTPFacilitatorClient({ url: configured.replace(/\/$/, "") });
  }
  // Offline test fixture: the selftest runs with no network, so it supplies
  // the facilitator /supported contract itself. Never set in production.
  if (env.X402_TEST_SUPPORTED_KINDS) {
    client.getSupported = async () => JSON.parse(env.X402_TEST_SUPPORTED_KINDS);
  }
  return client;
}

/** One RouteConfig per live item, from the curated index. */
function routeForStub(stub, payTo, network) {
  const url = `${CANONICAL_ORIGIN}/api/x402/${stub.slug || stub.sku}`;
  return {
    accepts: [
      {
        scheme: "exact",
        network,
        payTo,
        price: `$${Number(stub.price_usd).toFixed(stub.price_usd < 0.01 ? 3 : 2)}`,
      },
    ],
    description: `${stub.name} — ${String(stub.summary || "").slice(0, 140)}`,
    mimeType: "application/json",
    resource: url,
    serviceName: SERVICE_NAME,
    tags: [stub.kind, "aws", "x402"].filter(Boolean).slice(0, 5),
    iconUrl: `${CANONICAL_ORIGIN}/favicon.ico`,
    extensions: {
      ...toolBazaarExtension(stub),
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
    },
  };
}

/** Execution tools sell POST; object tools sell GET. */
function methodForStub(stub) {
  return stub.invoke_kind === "bedrock" ? "POST" : "GET";
}

/**
 * The payment middleware is rebuilt when the curated index changes; cached
 * per isolate for 60s so route lookups stay cheap without drifting from it.
 */
const paymentCache = { middleware: null, expires: 0 };

async function getPaymentMiddleware(env) {
  const now = Date.now();
  if (paymentCache.middleware && now < paymentCache.expires) return paymentCache.middleware;

  const payTo = activePayTo(env);
  if (!payTo) return null;

  const net = activeNetwork(env);
  const tools = await liveStubs(env);
  const routes = {};
  for (const stub of tools) {
    const route = routeForStub(stub, payTo, net.id);
    const method = methodForStub(stub);
    routes[`${method} /api/x402/${stub.slug || stub.sku}`] = route;
    if (stub.slug && stub.sku !== stub.slug) routes[`${method} /api/x402/${stub.sku}`] = route;
    if (stub.invoke_kind === "r2") {
      // The deliberate artifact fetch is gated at the same price.
      routes[`GET /api/x402/${stub.slug || stub.sku}/artifact`] = route;
      if (stub.slug && stub.sku !== stub.slug) routes[`GET /api/x402/${stub.sku}/artifact`] = route;
    }
  }
  if (Object.keys(routes).length === 0) {
    paymentCache.middleware = "empty";
    paymentCache.expires = now + 60_000;
    return "empty";
  }

  const resourceServer = new x402ResourceServer(facilitatorClient(env))
    .register(net.id, new ExactEvmScheme())
    // Ledger: the record of every settled sale stays in D1. Errors here must
    // never break delivery — the settlement already happened on-chain.
    .onAfterSettle(async (context) => {
      try {
        const paymentId = `pay_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const sku = skuFromResourceUrl(context.paymentPayload?.resource?.url) || "";
        await recordSettledSale(env, {
          id: paymentId,
          sku,
          price_usd: Number(context.requirements?.amount || 0) / 1_000_000,
          amount_usdc_micros: String(context.requirements?.amount || ""),
          payer: context.result?.payer || "",
          network: context.requirements?.network || "",
          scheme: context.requirements?.scheme || "exact",
          idempotency_key: `settle:${context.result?.transaction || crypto.randomUUID()}`,
          tx_hash: context.result?.transaction || "",
        });
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
  let inventoryOk = false;
  try {
    liveCount = await countLive(c.env);
    inventoryOk = Boolean(c.env.SW_DB);
  } catch {
    inventoryOk = false;
  }
  return c.json(
    {
      service: SERVICE_NAME,
      status: inventoryOk ? "live" : "degraded",
      tools_live: liveCount,
      payment: {
        rail: "x402",
        x402Version: 2,
        network: activeNetwork(c.env).id,
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
  const tools = await liveStubs(c.env);
  return c.json(
    {
      service: SERVICE_NAME,
      tagline: TAGLINE,
      total_live: tools.length,
      payment: { rail: "x402", network: activeNetwork(c.env).id, asset: "USDC", how: "GET any tool URL -> 402 -> sign -> retry with PAYMENT-SIGNATURE" },
      tools: tools.map((t) => ({
        sku: t.sku,
        name: t.name,
        kind: t.kind,
        service: t.service,
        price_usd: t.price_usd,
        summary: t.summary,
        url: `${CANONICAL_ORIGIN}/api/x402/${t.slug || t.sku}`,
      })),
    },
    200,
    { ...JSON_HEADERS, "Cache-Control": "public, max-age=300" }
  );
});

// Free: generated discovery documents (one source: the curated index).
app.get("/openapi.json", async (c) => discoveryJson(await buildOpenApi(c.env, new URL(c.req.url).origin)));
app.get("/v2/x402/discovery/resources", async (c) => discoveryJson(await buildX402Resources(c.env, new URL(c.req.url).origin)));
app.get("/.well-known/x402", async (c) => discoveryJson(await buildX402Resources(c.env, new URL(c.req.url).origin)));

// Paid surface — the OFFICIAL SDK middleware verifies before the handler and
// settles after it succeeds. A buyer is never charged for a failed response.
app.use("/api/x402/*", async (c, next) => {
  const middleware = await getPaymentMiddleware(c.env);
  if (!middleware) return c.json({ error: "payment_rail_not_configured" }, 503, JSON_HEADERS);
  if (middleware === "empty") return next(); // no live items: handler 404s below
  return middleware(c, next);
});

// Paid execution — Bedrock agents. Verified by the middleware above; a
// failed invocation returns >= 400, so the SDK cancels settlement and the
// buyer is never charged for a failed run.
app.post("/api/x402/:key", async (c) => {
  const item = await findItem(c.env, c.req.param("key"));
  if (!item) {
    return c.json({ error: "unknown_sku", tools: "/api/tools" }, 404, JSON_HEADERS);
  }
  if (item.invoke_kind !== "bedrock") {
    return c.json({ error: "method_not_allowed", hint: `This item resolves: GET /api/x402/${item.slug || item.sku}` }, 405, JSON_HEADERS);
  }
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json_body", hint: 'POST a JSON body: { "input": "the task", "sessionId": "optional" }' }, 400, JSON_HEADERS);
  }
  if (!body.input || typeof body.input !== "string") {
    return c.json({ error: "missing_input", hint: '"input" (string) is required' }, 400, JSON_HEADERS);
  }
  const run = await invokeAgent(c.env, item.invoke_key, { input: body.input, sessionId: body.sessionId });
  if (!run.ok) {
    return c.json({ error: run.error, sku: item.sku }, run.status, JSON_HEADERS);
  }
  return c.json({ sku: item.sku, completion: run.completion, sessionId: run.sessionId }, 200, JSON_HEADERS);
});

// Deliberate, secondary artifact fetch — reached through the resolved
// capability, same x402 gate. Never the front door.
app.get("/api/x402/:key/artifact", async (c) => {
  const item = await findItem(c.env, c.req.param("key"));
  if (!item || item.invoke_kind !== "r2") {
    return c.json({ error: "unknown_artifact", tools: "/api/tools" }, 404, JSON_HEADERS);
  }
  const object = await getArtifact(c.env, item);
  if (!object) {
    // Curated item whose artifact is missing — never charge for it: a 5xx
    // makes the SDK cancel settlement (verified, not settled).
    return c.json({ error: "artifact_missing", sku: item.sku }, 503, JSON_HEADERS);
  }
  return c.body(object.body, 200, {
    ...JSON_HEADERS,
    "Content-Type": item.mime_type || object.httpMetadata?.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${item.slug || item.sku}"`,
    "X-Content-Hash": item.content_hash || "",
  });
});

// The paid deliverable: the RESOLVED CAPABILITY — guidance (the voice),
// composition (the wired graph neighborhood), invocation. Not a file dump.
app.get("/api/x402/:key", async (c) => {
  const item = await findItem(c.env, c.req.param("key"));
  if (!item) {
    return c.json({ error: "unknown_sku", tools: "/api/tools" }, 404, JSON_HEADERS);
  }
  if (item.invoke_kind === "bedrock") {
    return c.json({ error: "method_not_allowed", hint: `This item executes: POST /api/x402/${item.slug || item.sku} with a JSON body { "input": "the task" }` }, 405, JSON_HEADERS);
  }
  const resolved = await resolveCapability(c.env, item, new URL(c.req.url).origin);
  return c.json(resolved, 200, JSON_HEADERS);
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
