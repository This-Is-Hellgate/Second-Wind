import {
  DEFAULT_FETCH_TIMEOUT_MS,
  getCircuit,
  circuitAllows,
  circuitSuccess,
  circuitFailure,
  fetchWithTimeout,
} from "./resilience.js";
import { buildCdpAuthHeaders, facilitatorPaths } from "./cdp-auth.js";
import { CANONICAL_HOST } from "./brand.js";
import {
  resolveActiveNetworks,
  buildAcceptEntry,
  selectAcceptForPayload,
  payloadNetwork,
} from "./x402-networks.js";
import { allExtensions, headerDiscoveryExtensions } from "./x402-extensions.js";

const x402Circuit = () => getCircuit("x402_facilitator", { failureThreshold: 5, openMs: 30_000 });

export const X402_EXTENSION_URI = "https://github.com/google-a2a/a2a-x402/v0.1";

/**
 * MCP autopay client identity advertised inside every unpaid 402 body so a
 * walletless caller receives exact, machine-actionable setup instructions.
 * NOTE: version is duplicated from packages/secondeye-mcp/package.json until the
 * canonical service catalog + discovery generator (Phase 2/3) owns it — the
 * discovery:check drift gate must compare these two values.
 */
/**
 * Cheapest routable first purchase, advertised in every 402 so an undecided
 * agent has a $0.03 on-ramp instead of walking away. Cheapest live catalog
 * tier; the catalog endpoint itself is free.
 */
const CHEAPEST_FIRST_STEP = {
  name: "catalog",
  price_usd: 0,
  path: "/api/catalog",
  why: "Free full catalog with prices. Cheapest paid items are $0.03.",
};

/**
 * Machine-actionable conversion block for every unpaid 402 body. Tells a
 * paying client exactly what to do next (retry the SAME url with a signed
 * PAYMENT-SIGNATURE header) and tells a walletless client exactly how to become
 * payment-capable (MCP autopay package or raw @x402 REST stack). `requestUrl`
 * preserves query parameters on retry_url; falls back to the canonical
 * resource when a caller does not pass it.
 */
export function machineActionable402(requirements, origin, requestUrl) {
  const base = origin?.replace(/\/$/, "") || `https://${CANONICAL_HOST}`;
  let retryUrl =
    typeof requirements.resource === "string"
      ? requirements.resource
      : requirements.resource?.url || "";
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      retryUrl = `https://${CANONICAL_HOST}${u.pathname}${u.search}`;
    } catch {
      /* keep canonical resource fallback */
    }
  }
  return {
    access: "unpaid_invoice",
    paid_result_exposed: false,
    next_action: "retry_same_url_with_PAYMENT_SIGNATURE",
    retry_url: retryUrl,
    payment_header: "PAYMENT-SIGNATURE",
    requirements_header: "PAYMENT-REQUIRED",
    client_options: {
      rest_autopay: {
        packages: ["@x402/fetch", "@x402/evm", "viem"],
        network: "eip155:8453",
        asset: "USDC",
      },
    },
    cheapest_first_step: {
      name: CHEAPEST_FIRST_STEP.name,
      price_usd: CHEAPEST_FIRST_STEP.price_usd,
      url: `${base}${CHEAPEST_FIRST_STEP.path}`,
      why: CHEAPEST_FIRST_STEP.why,
    },
  };
}

export function usdToUsdcMicros(usd) {
  return String(Math.round(usd * 1_000_000));
}

/**
 * Build the v2 accepts[] for this env. Base (eip155:8453) is always accepts[0];
 * additional rails (Polygon, Solana) append only when an operator has configured
 * AND gated them — see functions/_lib/x402-networks.js. Returns null when no
 * payTo is configured at all (x402 not set up).
 */
function buildAccepts(amount, env) {
  const rails = resolveActiveNetworks(env);
  if (rails.length === 0) return null;
  return rails.map((rail) => buildAcceptEntry(rail, amount));
}

/** Synthesize a minimal Bazaar schema so every paid product is discoverable. */
function defaultBazaarSchema(product) {
  return {
    input: { type: "http", method: "GET", discoverable: true },
    output: {
      service: product.slug || product.id,
      access: "granted",
      scope: product.kind,
      paid_usd: product.priceUsd,
      note: "Paid survival service. Embed work_stamp in your deliverable.",
    },
  };
}

/** Absolute, canonical resource URL — CDP Bazaar catalogs by callable URL, not path. */
function canonicalResource(requestUrl) {
  const { pathname } = new URL(requestUrl);
  return `https://${CANONICAL_HOST}${pathname}`;
}

/** Matches @x402/extensions createQueryDiscoveryExtension() { info, schema } wire shape. */
function bazaarExtension(_resource, bazaarOutputSchema) {
  const { input, output } = bazaarOutputSchema;
  const method = (input.method || "GET").toUpperCase();

  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method,
          ...(input.headerFields ? { headers: input.headerFields } : {}),
        },
        ...(output ? { output: { type: "json", example: output } } : {}),
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: [method] },
            },
            required: ["type", "method"],
          },
          ...(output
            ? {
                output: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    example: { type: "object" },
                  },
                  required: ["type"],
                },
              }
            : {}),
        },
        required: ["input"],
      },
    },
  };
}

/**
 * Header-sized bazaar extension: x402scan's v2 parser REQUIRES
 * extensions.bazaar.info + schema.properties.input in the PAYMENT-REQUIRED
 * header. The schema (small, always kept) is what the parser validates; a
 * bulky output example is shed from the header variant when over budget.
 * The full example still rides the 402 body and the CDP settle echo.
 */
const HEADER_BAZAAR_BUDGET_BYTES = 3 * 1024;

function headerSizedBazaarExtension(resource, bazaarOutputSchema) {
  const full = bazaarExtension(resource, bazaarOutputSchema);
  if (JSON.stringify(full).length <= HEADER_BAZAAR_BUDGET_BYTES) return full;
  const slim = JSON.parse(JSON.stringify(full));
  if (slim.bazaar?.info?.output?.example) {
    slim.bazaar.info.output = { type: slim.bazaar.info.output.type || "json" };
  }
  return slim;
}

/**
 * Decode a base64 (or base64url) string to a UTF-8 JSON object. Exact inverse of
 * encodePaymentRequiredHeader (UTF-8 -> btoa): atob yields a binary string of bytes,
 * which we widen back to a Uint8Array and decode as UTF-8. Bare JSON.parse(atob(...))
 * corrupts every multibyte char (em-dash, ellipsis, accents, CJK) -> garbled discovery
 * metadata shipped to CDP. Returns null on any malformed input.
 */
export function decodeBase64Json(b64) {
  try {
    const normalized = b64.trim().replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const bin = atob(normalized + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Decode CDP settle EXTENSION-RESPONSES header → bazaar status object. */
export function parseExtensionResponses(header) {
  if (!header) return null;
  return decodeBase64Json(header)?.bazaar || null;
}

export function buildProductPaymentRequirements(product, requestUrl, env) {
  const resource = canonicalResource(requestUrl);
  const amount = usdToUsdcMicros(product.priceUsd);

  // x402 v2: accepts[] entries stay clean (CDP Bazaar indexer rejects v1-style
  // resource/description/mimeType/outputSchema inside accepts). Discovery
  // metadata lives top-level; only EIP-712 domain (name/version) goes in extra.
  // Base is accepts[0]; extra rails append only when configured + gated.
  const accepts = buildAccepts(amount, env);
  if (!accepts) return null;

  const requirements = {
    x402Version: 2,
    resource,
    description: product.description,
    mimeType: "application/json",
    maxAmountRequired: amount,
    accepts,
  };

  const schema = product.bazaarOutputSchema || defaultBazaarSchema(product);
  requirements.extensions = {
    ...bazaarExtension(resource, schema),
    ...allExtensions(product),
  };
  // Compact subset that rides the PAYMENT-REQUIRED header so the Coinbase Python
  // x402_action_provider populates discoveryInfo.extensions (it reads only the
  // decoded header). The full set above stays in the 402 body / settle echo.
  // Full bazaar extension (info + input/output schema) MUST ride the header:
  // x402scan's v2 parser reads extensions.bazaar.schema from the decoded
  // PAYMENT-REQUIRED header (SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING
  // otherwise). Compact listing identity rides alongside.
  requirements.headerExtensions = {
    ...headerSizedBazaarExtension(resource, schema),
    ...headerDiscoveryExtensions(product),
  };

  return requirements;
}

export function payment402BodyForProduct(requirements, product, error, origin, requestUrl) {
  const base = origin?.replace(/\/$/, "") || "";
  return {
    x402Version: 2,
    error: error || "Payment required",
    resource: requirements.resource,
    description: requirements.description,
    mimeType: requirements.mimeType,
    maxAmountRequired: requirements.maxAmountRequired,
    accepts: requirements.accepts,
    ...machineActionable402(requirements, origin, requestUrl),
    ...(requirements.extensions ? { extensions: requirements.extensions } : {}),
    product: {
      kind: product.kind,
      id: product.id,
      priceUsd: product.priceUsd,
      oneTime: product.oneTime || false,
    },
    on_payment_failure: {
      do_not_serve_degraded_paid_content: true,
      retry: "exponential_backoff_with_jitter",
      max_retries: 3,
      free_samples: {
        tool: `${base}/api/bar/tools/cursor-mcp-wiring`,
        tap: `${base}/api/bar/taps/cursor-mcp-minimal-config`,
      },
      catalog: `${base}/api/bar/catalog`,
    },
    lounge: {
      index: "/api/bar",
      laws: "/api/bar/laws",
      pricing: "/api/bar/pricing",
      enter: "/api/bar/enter",
      leave: "/api/bar/leave",
      receipt: "/api/bar/receipt",
      catalog: "/api/bar/catalog",
      proof: "/api/bar/proof",
      stats: "/api/bar/stats",
      bar_tab: "/api/access/purchase?plan=annual",
    },
  };
}

/**
 * Standard base64 (matches @x402/core safeBase64Encode: UTF-8 → btoa) of the v2
 * payment-required object. The @x402 client's Base64EncodedRegex is /^[A-Za-z0-9+/]*={0,2}$/.
 */
export function encodePaymentRequiredHeader(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Cap for resource.description inside the PAYMENT-REQUIRED header. The header is a
 * single HTTP header line; common intermediaries reject one above ~8KB (nginx
 * large_client_header_buffers default, Node's 16KB total-header parser budget,
 * undici/agent-runtime defaults). The full description still ships in the 402 JSON
 * body and the settle-time extension echo, so cataloging/discovery is unaffected —
 * see payment402BodyForProduct() + buildFacilitatorRequestBody()'s extensions echo.
 */
const HEADER_DESCRIPTION_MAX = 220;

function shortHeaderDescription(description) {
  const d = String(description || "");
  if (d.length <= HEADER_DESCRIPTION_MAX) return d;
  return d.slice(0, HEADER_DESCRIPTION_MAX - 1).trimEnd() + "…";
}

/**
 * The v2 resource object { url, description, mimeType }. `truncate` controls
 * whether the description is capped for header use (true) or kept full for the
 * 402 body / settle echo where there is no header-size constraint (false).
 */
function resourceObject(requirements, { truncate } = { truncate: false }) {
  const resourceUrl =
    typeof requirements.resource === "string"
      ? requirements.resource
      : requirements.resource?.url;
  const description = requirements.description || "";
  return {
    url: resourceUrl,
    description: truncate ? shortHeaderDescription(description) : description,
    mimeType: requirements.mimeType || "application/json",
  };
}

/**
 * Canonical x402 v2 payment-required object — the shape the official x402 client
 * decodes from the PAYMENT-REQUIRED header (see coinbase/agentkit x402ActionProvider:
 * "v2 sends requirements in PAYMENT-REQUIRED header; v1 sends in body").
 *
 * The Coinbase Python x402_action_provider (make_http_request) decodes this header,
 * reads accepts[] for the pay-path, AND extracts discoveryInfo from the SAME decoded
 * object: payment_data.get("description") / .get("mimeType") / .get("extensions").
 * Those live at the TOP LEVEL of the decoded object, not inside resource{} — so a
 * lean header carrying only {x402Version,error,resource,accepts} yields an EMPTY
 * discoveryInfo for a Python agent. To make the official provider's discoveryInfo
 * extraction work we surface a short top-level description, mimeType, and a COMPACT
 * extensions block (listing identity only — serviceName/tags/iconUrl).
 *
 * The header stays small: the description is truncated and `extensions` here is the
 * compact headerExtensions subset, NOT the full Bazaar input/output schema. The full
 * description + full extensions.bazaar still ride the 402 JSON body
 * (payment402BodyForProduct) and the CDP settle echo (buildFacilitatorRequestBody),
 * so cataloging is unchanged. The header-size gate (8KB ceiling) still holds — see
 * scripts/x402-header-size-selftest.mjs.
 */
export function paymentRequiredObject(requirements, error) {
  const resource = resourceObject(requirements, { truncate: true });
  const obj = {
    x402Version: 2,
    error: error || "PAYMENT-SIGNATURE header is required",
    resource,
    description: resource.description,
    mimeType: resource.mimeType,
    accepts: requirements.accepts,
  };
  if (requirements.headerExtensions && Object.keys(requirements.headerExtensions).length) {
    obj.extensions = requirements.headerExtensions;
  }
  return obj;
}

/**
 * Headers every 402 must carry so a real v2 agent can actually pay:
 *  - PAYMENT-REQUIRED: base64 v2 object (the ONLY place v2 clients read requirements)
 *  - Access-Control-Expose-Headers: lets browser/agent fetch read it cross-origin
 */
export function payment402Headers(requirements, error, extra = {}) {
  return {
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequiredObject(requirements, error)),
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    ...extra,
  };
}

export function readPaymentHeader(request) {
  return (
    request.headers.get("PAYMENT-SIGNATURE") ||
    request.headers.get("X-PAYMENT-SIGNATURE") ||
    request.headers.get("X-PAYMENT") ||
    ""
  );
}

/** Decode PAYMENT-SIGNATURE / X-PAYMENT (base64 JSON) per CDP verify/settle API. */
export function parsePaymentPayloadFromHeader(paymentHeader) {
  if (!paymentHeader) return null;
  const trimmed = paymentHeader.trim();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  return decodeBase64Json(trimmed);
}

/** CDP POST /platform/v2/x402/{verify,settle} body — see verify-a-payment OpenAPI. */
export function buildFacilitatorRequestBody(paymentHeader, requirement) {
  const paymentPayload = parsePaymentPayloadFromHeader(paymentHeader);
  if (!paymentPayload) return { ok: false, error: "invalid_payment_header" };

  // Select the accept the buyer actually signed for — with a multi-rail accepts[]
  // a Polygon/Solana signer must NOT be verified against the Base accept[0].
  const accept = selectAcceptForPayload(requirement.accepts, paymentPayload);
  if (!accept) {
    // Distinguish "buyer named a rail we don't advertise" from "no accepts at all"
    // so the failure log/diagnostics show which rail was signed for. Verifying a
    // declared-but-unmatched payload against accepts[0] is the multi-rail trap.
    const declared = payloadNetwork(paymentPayload);
    if (declared) {
      const offered = (requirement.accepts || []).map((a) => a.network);
      return {
        ok: false,
        error: "unsupported_payment_network",
        declaredNetwork: declared,
        offeredNetworks: offered,
      };
    }
    return { ok: false, error: "missing_payment_requirements" };
  }

  const x402Version =
    paymentPayload.x402Version ?? requirement.x402Version ?? 2;

  // v2 per-accept requirement is CLEAN (PaymentRequirementsV2Schema:
  // scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra) — no resource,
  // no maxAmountRequired. It must equal the buyer's paymentPayload.accepted.
  const paymentRequirements = { ...accept };

  // Pass the buyer's signed paymentPayload through to CDP verify UNMUTATED.
  // Rewriting resource/extensions here (PR #27) reshaped the signed payload so CDP
  // could classify it as neither x402V2PaymentPayload nor x402V1PaymentPayload
  // (HTTP 400, "must match one of [...]"). Resource enrichment for Bazaar cataloging
  // belongs on paymentRequirements and the 402 body / settle echo, not smuggled into
  // the signed payload sent to /verify. Spread so we never mutate the parsed object.
  const enrichedPayload = { ...paymentPayload };

  return {
    ok: true,
    accept,
    body: { x402Version, paymentPayload: enrichedPayload, paymentRequirements },
  };
}

function facilitatorVerifyFailed(verifyRes, verify) {
  if (!verifyRes.ok) return true;
  if (verify.isValid === false) return true;
  if (verify.valid === false) return true;
  return false;
}

function facilitatorVerifyError(verify) {
  return (
    verify.invalidMessage ||
    verify.invalidReason ||
    verify.error ||
    verify.message ||
    "Payment verification failed"
  );
}

/**
 * A CDP /verify error body is small and useful for diagnosis (invalidReason,
 * status, payer) but may echo back signature material. Keep only the diagnostic
 * fields, drop anything that looks like a signature/authorization, and bound the
 * size so an unexpected body can never blow up a log line.
 */
const REDACTED = "[redacted]";
const SECRET_KEY_RE = /signature|authorization|secret|privatekey|private_key|seed|mnemonic/i;

export function redactFacilitatorBody(body) {
  if (!body || typeof body !== "object") return body ?? null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else if (v && typeof v === "object") {
      out[k] = REDACTED;
    } else if (typeof v === "string") {
      out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** One structured, secret-free log line per verify failure — fires for EVERY caller. */
function logVerifyFailure(fields) {
  try {
    console.log(JSON.stringify({ event: "x402_verify_failed", ...fields }));
  } catch {
    console.log(JSON.stringify({ event: "x402_verify_failed", error: "log_serialize_failed" }));
  }
}

/** Verify a payment header against requirements without settling (for validate-before-settle doors). */
export async function verifyPaymentHeader(paymentHeader, requirement, env) {
  const facilitator = env.X402_FACILITATOR_URL;
  if (!facilitator) {
    return { ok: false, error: "X402_FACILITATOR_URL not configured" };
  }

  const circuit = x402Circuit();
  const allowed = circuitAllows(circuit);
  if (!allowed.ok) {
    return {
      ok: false,
      error: "payment_rail_degraded",
      degraded: true,
      retryAfter: allowed.retryAfter,
    };
  }

  const built = buildFacilitatorRequestBody(paymentHeader, requirement);
  if (!built.ok) {
    if (built.error === "unsupported_payment_network") {
      logVerifyFailure({
        stage: "select",
        error: built.error,
        declaredNetwork: built.declaredNetwork,
        offeredNetworks: built.offeredNetworks,
      });
      return {
        ok: false,
        error: built.error,
        stage: "select",
        invalidReason: "unsupported_payment_network",
        declaredNetwork: built.declaredNetwork,
        offeredNetworks: built.offeredNetworks,
      };
    }
    return { ok: false, error: built.error, stage: "parse" };
  }

  const accept = built.accept;
  const base = facilitator.replace(/\/$/, "");
  const paths = facilitatorPaths(base);

  let verifyAuth;
  try {
    verifyAuth = await buildCdpAuthHeaders(env, "POST", paths.verifyPath);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "cdp_auth_key_import_failed",
      stage: "auth",
    };
  }
  const headers = { "Content-Type": "application/json", ...verifyAuth };

  let verifyRes;
  try {
    verifyRes = await fetchWithTimeout(
      `${paths.base}${paths.verifyPath}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(built.body),
      },
      DEFAULT_FETCH_TIMEOUT_MS
    );
    circuitSuccess(circuit);
  } catch (err) {
    circuitFailure(circuit);
    return { ok: false, error: "payment_rail_timeout", degraded: true };
  }

  const verify = await verifyRes.json().catch(() => ({}));
  if (facilitatorVerifyFailed(verifyRes, verify)) {
    const redacted = redactFacilitatorBody(verify);
    logVerifyFailure({
      stage: "verify",
      network: accept.network,
      facilitatorStatus: verifyRes.status,
      invalidReason: verify.invalidReason || null,
      facilitatorBody: redacted,
    });
    return {
      ok: false,
      error: facilitatorVerifyError(verify),
      stage: "verify",
      network: accept.network,
      invalidReason: verify.invalidReason || null,
      facilitatorStatus: verifyRes.status,
      facilitatorResponse: redacted,
    };
  }

  return { ok: true, built: built.body, accept, requirement };
}

/** Settle a payment that already passed verify (same built body CDP returned ok for). */
export async function settleBuiltPayment(builtBody, accept, env) {
  const facilitator = env.X402_FACILITATOR_URL;
  if (!facilitator) {
    return { ok: false, error: "X402_FACILITATOR_URL not configured" };
  }

  const circuit = x402Circuit();
  const base = facilitator.replace(/\/$/, "");
  const paths = facilitatorPaths(base);

  let settleAuth;
  try {
    settleAuth = await buildCdpAuthHeaders(env, "POST", paths.settlePath);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "cdp_auth_key_import_failed",
      stage: "auth",
    };
  }
  const settleHeaders = { "Content-Type": "application/json", ...settleAuth };

  let settleRes;
  try {
    settleRes = await fetchWithTimeout(
      `${paths.base}${paths.settlePath}`,
      {
        method: "POST",
        headers: settleHeaders,
        body: JSON.stringify(builtBody),
      },
      DEFAULT_FETCH_TIMEOUT_MS
    );
    circuitSuccess(circuit);
  } catch (err) {
    circuitFailure(circuit);
    return { ok: false, error: "payment_rail_timeout", degraded: true };
  }

  const settle = await settleRes.json().catch(() => ({}));
  if (!settleRes.ok || settle.success === false) {
    return {
      ok: false,
      error: settle.errorReason || settle.error || "Payment settlement failed",
      stage: "settle",
    };
  }

  const extensionResponsesHeader = settleRes.headers.get("EXTENSION-RESPONSES");
  const bazaar = parseExtensionResponses(extensionResponsesHeader);

  return {
    ok: true,
    receipt: {
      success: true,
      transaction: settle.transaction || settle.txHash || "",
      network: settle.network || accept.network,
      payer: settle.payer || "",
    },
    bazaar,
    extensionResponsesHeader: extensionResponsesHeader || null,
  };
}

export function encodePaymentResponse(receipt) {
  return btoa(JSON.stringify(receipt));
}

/**
 * The v2 settlement-confirmation headers. The x402 v2 HTTP spec names the response
 * header PAYMENT-RESPONSE (base64 settlement confirmation); legacy CDP/agentkit
 * clients read X-PAYMENT-RESPONSE. Emit BOTH so a strict v2 client and an existing
 * client both find the receipt. Spread onto any post-settlement 200.
 */
export function paymentResponseHeaders(receipt) {
  const encoded = encodePaymentResponse(receipt);
  return {
    "PAYMENT-RESPONSE": encoded,
    "X-PAYMENT-RESPONSE": encoded,
    "Access-Control-Expose-Headers":
      "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-Second-Eye-Mark, X-Second-Eye-Patron, X-Second-Eye-Session, X-Second-Eye-Verify",
  };
}
