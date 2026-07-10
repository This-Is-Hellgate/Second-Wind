/**
 * Second Wind discovery — openapi.json, the x402 resources document, and
 * /.well-known/x402 are ALL generated here from the live rows in the database
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

function toolPath(item) {
  // Advertise the slug, not the SKU: in a marketplace listing the URL is the
  // headline, and an agent ranking many resources matches on the path before
  // it reads a description. The handler accepts BOTH (sku OR slug), so every
  // previously advertised SKU URL keeps working forever.
  return `/api/x402/${item.slug}`;
}

function toolGuidance(item) {
  return {
    call_when: item.summary,
    price_usd: item.price_usd,
    first_call: `GET ${toolPath(item)} returns 402 with a PAYMENT-REQUIRED header (base64 JSON payment requirements).`,
    pay: "Sign USDC on Base (eip155:8453) via the exact scheme (@x402/fetch) and retry the SAME request with the PAYMENT-SIGNATURE header.",
    inputs: "GET only — the answer is a pure function of the SKU; no query or body inputs.",
    idempotent: "Deterministic: same SKU, same answer on every retry. A retried signed payment is never charged twice — re-delivery is free.",
  };
}

/** JSON Schemas for every response shape this service returns. */
function componentSchemas() {
  return {
    ToolStub: {
      type: "object",
      description: "One live tool as listed on the free tools listing.",
      properties: {
        sku: { type: "string" },
        name: { type: "string" },
        item_type: { type: "string" },
        service: { type: "string" },
        price_usd: { type: "number" },
        summary: { type: "string" },
        url: { type: "string", format: "uri", description: "The paid endpoint for this tool." },
      },
      required: ["sku", "name", "price_usd", "summary", "url"],
    },
    ToolsListing: {
      type: "object",
      description: "Free listing of every live tool.",
      properties: {
        service: { type: "string" },
        tagline: { type: "string" },
        total_live: { type: "integer" },
        payment: {
          type: "object",
          properties: {
            rail: { type: "string", const: "x402" },
            network: { type: "string", const: "eip155:8453" },
            asset: { type: "string", const: "USDC" },
            how: { type: "string" },
          },
        },
        tools: { type: "array", items: { $ref: "#/components/schemas/ToolStub" } },
      },
      required: ["service", "total_live", "tools"],
    },
    Proof: {
      type: "object",
      description: "Free liveness proof: database reachability, live tool count, payment rail configuration.",
      properties: {
        service: { type: "string" },
        status: { type: "string", enum: ["live", "degraded"] },
        tools_live: { type: ["integer", "null"] },
        payment: {
          type: "object",
          properties: {
            rail: { type: "string", const: "x402" },
            x402Version: { type: "integer", const: 2 },
            network: { type: "string", const: "eip155:8453" },
            asset: { type: "string", const: "USDC" },
            payTo_configured: { type: "boolean" },
            facilitator_configured: { type: "boolean" },
          },
        },
        discovery: {
          type: "object",
          properties: {
            tools: { type: "string", format: "uri" },
            openapi: { type: "string", format: "uri" },
            x402_resources: { type: "string", format: "uri" },
            well_known: { type: "string", format: "uri" },
          },
        },
      },
      required: ["service", "status"],
    },
    Deliverable: {
      type: "object",
      description: "The paid response: the tool content plus source, license, provenance, content hash, and settlement receipt.",
      properties: {
        sku: { type: "string" },
        name: { type: "string" },
        item_type: { type: "string" },
        service: { type: "string" },
        summary: { type: "string" },
        source: {
          type: "object",
          properties: {
            repo: { type: "string" },
            path: { type: "string" },
            url: { type: "string" },
            license_spdx: { type: "string" },
            provenance: { type: "string" },
          },
        },
        content_hash: { type: "string" },
        version: { type: "integer" },
        receipt: {
          type: ["object", "null"],
          description: "Settlement receipt: on-chain transaction reference when settled.",
          properties: { transaction: { type: "string" } },
        },
        redelivery: { type: "boolean", description: "True when a retried signed payment was re-delivered free." },
      },
      required: ["sku", "name", "summary", "content_hash"],
    },
    PaymentRequired402: {
      type: "object",
      description:
        "x402 v2 unpaid response body (application data; the protocol object rides base64-encoded in the PAYMENT-REQUIRED header).",
      properties: {
        x402Version: { type: "integer", const: 2 },
        error: { type: "string" },
        resource: { type: "string", format: "uri" },
        description: { type: "string" },
        mimeType: { type: "string" },
        maxAmountRequired: { type: "string", description: "Price in USDC atomic units (micros)." },
        accepts: {
          type: "array",
          description: "Accepted payment methods per the x402 v2 core spec.",
          items: {
            type: "object",
            properties: {
              scheme: { type: "string" },
              network: { type: "string", description: "CAIP-2 network id, e.g. eip155:8453." },
              amount: { type: "string" },
              asset: { type: "string" },
              payTo: { type: "string" },
              maxTimeoutSeconds: { type: "integer" },
              extra: { type: "object" },
            },
            required: ["scheme", "network"],
          },
        },
        extensions: {
          type: "object",
          description: "x402 extensions: bazaar (discovery) and payment-identifier (client idempotency).",
        },
        next_action: { type: "string" },
        retry_url: { type: "string", format: "uri" },
        links: {
          type: "object",
          properties: {
            tools: { type: "string", format: "uri" },
            proof: { type: "string", format: "uri" },
            openapi: { type: "string", format: "uri" },
            llms: { type: "string", format: "uri" },
          },
        },
      },
      required: ["x402Version", "accepts"],
    },
    NotFound: {
      type: "object",
      description: "Unknown SKU or slug.",
      properties: {
        error: { type: "string", const: "unknown_sku" },
        tools: { type: "string", description: "Path of the free tools listing." },
      },
      required: ["error"],
    },
    MethodNotAllowed: {
      type: "object",
      description: "Teaching 405: every surface is GET.",
      properties: {
        error: { type: "string", const: "method_not_allowed" },
        method: { type: "string" },
        path: { type: "string" },
        hint: { type: "string" },
        docs: {
          type: "object",
          properties: {
            openapi: { type: "string", format: "uri" },
            tools: { type: "string", format: "uri" },
          },
        },
      },
      required: ["error", "method", "path"],
    },
  };
}

function jsonContent(ref) {
  return { "application/json": { schema: { $ref: ref } } };
}

/** Shared response set for every paid tool endpoint. */
function paidResponses() {
  return {
    200: {
      description: "Paid. Body carries the tool: source repo, exact path, summary, license, provenance, content hash, and the settlement receipt.",
      content: jsonContent("#/components/schemas/Deliverable"),
    },
    402: {
      description:
        "Unpaid. PAYMENT-REQUIRED header carries base64 JSON payment requirements (x402 v2); retry the same URL with PAYMENT-SIGNATURE.",
      headers: {
        "PAYMENT-REQUIRED": {
          description: "Base64-encoded x402 v2 PaymentRequired object.",
          schema: { type: "string" },
        },
      },
      content: jsonContent("#/components/schemas/PaymentRequired402"),
    },
    404: {
      description: "Unknown SKU or slug.",
      content: jsonContent("#/components/schemas/NotFound"),
    },
    405: {
      description: "Wrong method. Every surface is GET.",
      content: jsonContent("#/components/schemas/MethodNotAllowed"),
    },
  };
}

export async function buildOpenApi(env, origin = CANONICAL_ORIGIN) {
  const items = await liveItems(env);
  const paths = {};

  for (const item of items) {
    paths[toolPath(item)] = {
      get: {
        operationId: `${item.slug}_get`,
        summary: item.summary.slice(0, 120),
        description: `${item.summary} Session-less x402 paid endpoint — pay once (USDC on Base) and receive the tool. ~$${item.price_usd} USDC.`,
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
          scheme: "exact",
        },
        security: [{ x402Payment: [] }],
        "x-guidance": toolGuidance(item),
        responses: paidResponses(),
      },
    };
  }

  // The template path documents the paid surface shape even when no tools are
  // live yet; per-tool paths above appear as tools go live.
  paths["/api/x402/{sku}"] = {
    get: {
      operationId: "tool_by_sku_get",
      summary: "Paid tool by SKU or slug (x402).",
      description:
        "Session-less paid endpoint. First call returns 402 with payment requirements in the PAYMENT-REQUIRED header; sign USDC on Base and retry the same URL with PAYMENT-SIGNATURE.",
      tags: ["paid", "x402"],
      parameters: [
        {
          name: "sku",
          in: "path",
          required: true,
          description: "Tool SKU or slug — both resolve.",
          schema: { type: "string" },
        },
      ],
      security: [{ x402Payment: [] }],
      responses: paidResponses(),
    },
  };

  paths["/api/tools"] = {
    get: {
      operationId: "tools_get",
      summary: "Free listing of every live tool with SKU, type, service, price, and summary.",
      description: "Free, unpaid surface. The place to browse before paying.",
      tags: ["free", "discovery"],
      security: [],
      responses: {
        200: { description: "The live tools listing.", content: jsonContent("#/components/schemas/ToolsListing") },
        405: { description: "Wrong method.", content: jsonContent("#/components/schemas/MethodNotAllowed") },
      },
    },
  };

  paths["/api/proof"] = {
    get: {
      operationId: "proof_get",
      summary: "Free liveness proof: live tool count, payment rail configuration, database reachability.",
      description: "Free, unpaid surface. Confirm the service is live before spending.",
      tags: ["free", "discovery"],
      security: [],
      responses: {
        200: { description: "Liveness proof.", content: jsonContent("#/components/schemas/Proof") },
        405: { description: "Wrong method.", content: jsonContent("#/components/schemas/MethodNotAllowed") },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: `${SERVICE_NAME} — AWS tools for agents, paid per call`,
      summary: TAGLINE,
      description:
        "Second Wind sells small, specific AWS tools to autonomous agents: exact source coordinates and the operational knowledge to use them. Every paid endpoint is session-less: discover, pay USDC on Base via x402 v2, use.",
      version: "1.1.0",
      "x-audience": "autonomous_agents",
      contact: { url: `${origin}/llms.txt` },
    },
    servers: [{ url: origin }],
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        x402Payment: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description:
            "x402 v2. First call returns 402 + PAYMENT-REQUIRED header (base64 JSON). Sign USDC on Base (eip155:8453, exact scheme) and retry the same URL with PAYMENT-SIGNATURE.",
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
    payment: { rail: "x402", network: "eip155:8453", asset: "USDC", scheme: "exact" },
    resources: items.map((item) => ({
      resource: `${origin}${toolPath(item)}`,
      type: "http",
      method: "GET",
      methods: ["GET"],
      x402: true,
      accepts: ["eip155:8453"],
      network: "eip155:8453",
      asset: "USDC",
      scheme: "exact",
      price_usd: item.price_usd,
      slug: item.slug,
      item_type: item.item_type,
      service: item.service_slug,
      summary: item.summary,
    })),
    links: { openapi: `${origin}/openapi.json`, tools: `${origin}/api/tools`, llms: `${origin}/llms.txt` },
  };
}
