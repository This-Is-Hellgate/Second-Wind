/**
 * Discovery generation — openapi.json, the x402 resources document, and
 * /.well-known/x402 are ALL generated from the KV manifest (inventory.js).
 * One source; surfaces cannot drift: what is in the object store is what is
 * advertised.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { SERVICE_NAME, TAGLINE, CANONICAL_ORIGIN } from "./brand.js";
import { listTools } from "./inventory.js";
import { activeNetwork, activePayTo } from "./networks.js";

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

function toolPath(stub) {
  return `/api/x402/${stub.slug || stub.sku}`;
}

/** The bazaar discovery block for one tool — official helper output only. */
export function toolBazaarExtension(stub) {
  // Execution tools (Bedrock agents) are POST with a JSON body; the manifest
  // stub carries the input schema and example the bazaar block advertises.
  if (stub.store === "bedrock") {
    return declareDiscoveryExtension({
      type: "http",
      method: "POST",
      bodyType: "json",
      input: stub.input_example || { input: "describe the task" },
      inputSchema: stub.input_schema || {
        properties: { input: { type: "string", description: "The task for the agent" }, sessionId: { type: "string" } },
        required: ["input"],
      },
      output: {
        type: "json",
        example: { sku: stub.sku, completion: "agent response text", sessionId: "uuid" },
        schema: {
          type: "object",
          properties: {
            sku: { type: "string" },
            completion: { type: "string" },
            sessionId: { type: "string" },
          },
          required: ["sku", "completion"],
        },
      },
    });
  }
  return declareDiscoveryExtension({
    type: "http",
    method: "GET",
    output: {
      type: stub.store === "r2" ? "binary" : "json",
      example: {
        sku: stub.sku,
        name: stub.name,
        item_type: stub.item_type,
        service: stub.service,
        summary: String(stub.summary || "").slice(0, 200),
        content_hash: stub.content_hash,
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
  });
}

function usdToMicros(usd) {
  return String(Math.round(usd * 1_000_000));
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
            network: { type: "string" },
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
      description: "Free liveness proof: inventory reachability, live tool count, payment rail configuration.",
      properties: {
        service: { type: "string" },
        status: { type: "string", enum: ["live", "degraded"] },
        tools_live: { type: ["integer", "null"] },
        payment: {
          type: "object",
          properties: {
            rail: { type: "string", const: "x402" },
            x402Version: { type: "integer", const: 2 },
            network: { type: "string" },
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
      description: "The paid response for a text tool: the content plus source, license, provenance, and content hash.",
      properties: {
        sku: { type: "string" },
        name: { type: "string" },
        item_type: { type: "string" },
        service: { type: "string" },
        summary: { type: "string" },
        content: { type: "string", description: "The tool itself (markdown or JSON)." },
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
      },
      required: ["sku", "name", "summary", "content_hash"],
    },
    PaymentRequired402: {
      type: "object",
      description:
        "x402 v2 unpaid response body (the protocol object rides base64-encoded in the PAYMENT-REQUIRED header).",
      properties: {
        x402Version: { type: "integer", const: 2 },
        error: { type: "string" },
        resource: { type: "object" },
        accepts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scheme: { type: "string" },
              network: { type: "string" },
              amount: { type: "string" },
              asset: { type: "string" },
              payTo: { type: "string" },
              maxTimeoutSeconds: { type: "integer" },
              extra: { type: "object" },
            },
            required: ["scheme", "network"],
          },
        },
        extensions: { type: "object" },
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
        docs: { type: "object" },
      },
      required: ["error", "method", "path"],
    },
  };
}

function jsonContent(ref) {
  return { "application/json": { schema: { $ref: ref } } };
}

function paidResponses(stub) {
  return {
    200: {
      description:
        stub?.store === "r2"
          ? "Paid. Body is the bundle itself (binary)."
          : "Paid. Body carries the tool: content, source, license, provenance, and content hash.",
      content: stub?.store === "r2" ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } } : jsonContent("#/components/schemas/Deliverable"),
    },
    402: {
      description:
        "Unpaid. PAYMENT-REQUIRED header carries base64 JSON payment requirements (x402 v2); retry the same URL with PAYMENT-SIGNATURE.",
      headers: {
        "PAYMENT-REQUIRED": { description: "Base64-encoded x402 v2 PaymentRequired object.", schema: { type: "string" } },
      },
      content: jsonContent("#/components/schemas/PaymentRequired402"),
    },
    404: { description: "Unknown SKU or slug.", content: jsonContent("#/components/schemas/NotFound") },
    405: { description: "Wrong method. Every surface is GET.", content: jsonContent("#/components/schemas/MethodNotAllowed") },
  };
}

export async function buildOpenApi(env, origin = CANONICAL_ORIGIN) {
  const tools = await listTools(env);
  const paths = {};

  for (const stub of tools) {
    if (stub.store === "bedrock") {
      paths[toolPath(stub)] = {
        post: {
          operationId: `${stub.slug || stub.sku}_post`,
          summary: String(stub.summary || "").slice(0, 120),
          description: `${stub.summary} Paid execution endpoint — pay per invocation (USDC via x402), the agent runs, the response returns. Settlement happens only when execution succeeds. ~$${stub.price_usd} USDC.`,
          tags: ["paid", "x402", "execution", stub.item_type, stub.service].filter(Boolean),
          "x-price-usd": stub.price_usd,
          security: [{ x402Payment: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: stub.input_schema || {
                  type: "object",
                  properties: {
                    input: { type: "string", description: "The task for the agent" },
                    sessionId: { type: "string", description: "Optional session continuity id" },
                  },
                  required: ["input"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Paid and executed. Body carries the agent completion.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { sku: { type: "string" }, completion: { type: "string" }, sessionId: { type: "string" } },
                    required: ["sku", "completion"],
                  },
                },
              },
            },
            402: paidResponses(stub)[402],
            404: paidResponses(stub)[404],
            405: paidResponses(stub)[405],
          },
        },
      };
      continue;
    }
    paths[toolPath(stub)] = {
      get: {
        operationId: `${stub.slug || stub.sku}_get`,
        summary: String(stub.summary || "").slice(0, 120),
        description: `${stub.summary} Session-less x402 paid endpoint — pay once (USDC) and receive the tool. ~$${stub.price_usd} USDC.`,
        tags: ["paid", "x402", stub.item_type, stub.service].filter(Boolean),
        "x-price-usd": stub.price_usd,
        security: [{ x402Payment: [] }],
        responses: paidResponses(stub),
      },
    };
  }

  paths["/api/x402/{sku}"] = {
    get: {
      operationId: "tool_by_sku_get",
      summary: "Paid tool by SKU or slug (x402).",
      description:
        "Session-less paid endpoint. First call returns 402 with payment requirements in the PAYMENT-REQUIRED header; sign USDC on Base and retry the same URL with PAYMENT-SIGNATURE.",
      tags: ["paid", "x402"],
      parameters: [
        { name: "sku", in: "path", required: true, description: "Tool SKU or slug — both resolve.", schema: { type: "string" } },
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
      summary: "Free liveness proof: live tool count, payment rail configuration, inventory reachability.",
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
        "Second Wind sells small, specific AWS tools to autonomous agents: the tool object itself plus source, license, and content hash. Every paid endpoint is session-less: discover, pay USDC on Base via x402 v2, use.",
      version: "1.2.0",
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

/**
 * Discovery resources document per core spec §8: {x402Version, items[],
 * pagination}; each item {resource, type, x402Version, accepts:
 * [PaymentRequirements], lastUpdated, extensions}.
 */
export async function buildX402Resources(env, origin = CANONICAL_ORIGIN) {
  const tools = await listTools(env);
  const payTo = activePayTo(env);
  const net = activeNetwork(env);

  const items = tools.map((stub) => ({
    resource: `${origin}${toolPath(stub)}`,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: net.id,
        amount: usdToMicros(stub.price_usd),
        asset: net.usdc,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { ...net.eip712 },
      },
    ],
    lastUpdated: stub.updated_at ? Math.floor(Date.parse(stub.updated_at) / 1000) || Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000),
    extensions: toolBazaarExtension(stub),
    metadata: {
      sku: stub.sku,
      slug: stub.slug,
      item_type: stub.item_type,
      service: stub.service,
      price_usd: stub.price_usd,
      summary: stub.summary,
    },
  }));

  return {
    x402Version: 2,
    items,
    pagination: { limit: items.length, offset: 0, total: items.length },
    links: { openapi: `${origin}/openapi.json`, tools: `${origin}/api/tools`, llms: `${origin}/llms.txt` },
  };
}
