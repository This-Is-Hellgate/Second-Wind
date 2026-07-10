/**
 * Second Wind root middleware. Day-one lessons from Second Eyes baked in:
 * - /.well-known/x402 serves the discovery document (same builder as /v2 —
 *   cannot drift; 337/day probed this on Second Eyes before it existed)
 * - HEAD mirrors GET everywhere (Pages binds route method before middleware,
 *   so function paths self-fetch as GET; static paths convert via next())
 * - a wrong method teaches instead of dead-ending (2.6k/day on Second Eyes)
 * - every /api request is logged to request_log (fire-and-forget)
 */
import { buildX402Resources, discoveryJson } from "./_lib/discovery.js";
import { logRequest } from "./_lib/store.js";

function methodNotAllowedResponse(url, method) {
  return new Response(
    JSON.stringify(
      {
        error: "method_not_allowed",
        method,
        path: url.pathname,
        hint: "All Second Wind surfaces are GET. Paid tools: GET /api/x402/{sku}. The exact method per path is declared in openapi.json.",
        docs: { openapi: `${url.origin}/openapi.json`, tools: `${url.origin}/api/tools` },
      },
      null,
      2
    ),
    { status: 405, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
}

function uaClass(request) {
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  if (!ua) return "none";
  if (/bot|crawl|spider|scan|probe|monitor/.test(ua)) return "crawler";
  if (/python|node|curl|wget|go-http|axios|fetch/.test(ua)) return "agent";
  return "browser";
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // The old listing path stays reachable for anything that indexed it, but the
  // canonical URL is /api/tools.
  if (url.pathname === "/api/catalog") {
    return Response.redirect(`${url.origin}/api/tools${url.search}`, 308);
  }

  if (url.pathname === "/.well-known/x402" && (context.request.method === "GET" || context.request.method === "HEAD")) {
    const doc = discoveryJson(await buildX402Resources(context.env, `${url.protocol}//${url.host}`));
    if (context.request.method === "HEAD") return new Response(null, { status: doc.status, headers: doc.headers });
    return doc;
  }

  const isHead = context.request.method === "HEAD";
  const runNext = () =>
    isHead
      ? context.next(new Request(context.request.url, { method: "GET", headers: context.request.headers }))
      : context.next();
  const runNextApi = () =>
    isHead
      ? fetch(new Request(context.request.url, { method: "GET", headers: context.request.headers }))
      : context.next();

  if (!url.pathname.startsWith("/api/")) {
    const response = await runNext();
    if (isHead) return new Response(null, { status: response.status, headers: response.headers });
    if (response.status === 405) return methodNotAllowedResponse(url, context.request.method);
    return response;
  }

  const response = await runNextApi();

  if (context.request.method !== "OPTIONS" && typeof context.waitUntil === "function") {
    const sku = url.pathname.startsWith("/api/x402/") ? url.pathname.split("/").pop() : "";
    context.waitUntil(
      logRequest(context.env, {
        path: url.pathname,
        sku,
        method: context.request.method,
        status: response.status,
        uaClass: uaClass(context.request),
      })
    );
  }

  if (isHead) return new Response(null, { status: response.status, headers: response.headers });
  if (response.status === 405) return methodNotAllowedResponse(url, context.request.method);
  return response;
}
