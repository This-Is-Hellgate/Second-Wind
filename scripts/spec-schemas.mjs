/**
 * JSON Schemas transcribed from specs/x402-specification-v2.md field tables
 * (x402-foundation/x402). These encode the SPEC, not this implementation —
 * the conformance suite validates every emitted object against them, so a
 * product that drifts from the spec fails the suite even if it agrees with
 * itself. Section numbers reference the spec document.
 *
 * `additionalProperties` is left open where the spec's tables define required
 * fields but do not forbid extras (the spec's own examples carry extras like
 * `metadata`); it is closed where the spec constrains the object fully.
 */

/** §5.1.2 PaymentRequirements (one entry of accepts[]). */
export const PaymentRequirementsSchema = {
  type: "object",
  properties: {
    scheme: { type: "string", minLength: 1 },
    network: { type: "string", pattern: "^[a-z0-9-]+:[a-zA-Z0-9._-]+$" }, // CAIP-2 namespace:reference (§11.1)
    amount: { type: "string", pattern: "^[0-9]+$" }, // atomic units
    asset: { type: "string", minLength: 1 }, // token contract address or ISO 4217 code
    payTo: { type: "string", minLength: 1 }, // wallet address or role constant
    maxTimeoutSeconds: { type: "number" },
    extra: { type: "object" },
  },
  required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
};

/** §5.1.2 ResourceInfo. */
export const ResourceInfoSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1 },
    description: { type: "string" },
    mimeType: { type: "string" },
    serviceName: { type: "string", maxLength: 32, pattern: "^[\\x20-\\x7E]*$" }, // printable ASCII, ≤32
    tags: {
      type: "array",
      maxItems: 5,
      items: { type: "string", maxLength: 32, pattern: "^[\\x20-\\x7E]*$" },
    },
    iconUrl: { type: "string", maxLength: 2048, pattern: "^https?://" },
  },
  required: ["url"],
};

/** §5.1.2 Extensions map: EVERY value must carry info AND schema. */
export const ExtensionsSchema = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      info: { type: "object" },
      schema: { type: "object" },
    },
    required: ["info", "schema"],
  },
};

/** §5.1 PaymentRequired (the decoded PAYMENT-REQUIRED header object). */
export const PaymentRequiredSchema = {
  type: "object",
  properties: {
    x402Version: { type: "number", const: 2 },
    error: { type: "string" },
    resource: ResourceInfoSchema,
    accepts: { type: "array", minItems: 1, items: PaymentRequirementsSchema },
    extensions: ExtensionsSchema,
  },
  required: ["x402Version", "resource", "accepts"],
};

/** §5.3.2 SettlementResponse (the decoded PAYMENT-RESPONSE header object). */
export const SettlementResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    errorReason: { type: "string" },
    payer: { type: "string" },
    transaction: { type: "string" }, // required; empty string when failed
    network: { type: "string", pattern: "^[a-z0-9-]+:[a-zA-Z0-9._-]+$" },
    amount: { type: "string" },
    extensions: { type: "object" },
  },
  required: ["success", "transaction", "network"],
  allOf: [
    {
      // failed settlements: transaction must be the empty string
      if: { properties: { success: { const: false } }, required: ["success"] },
      then: { properties: { transaction: { const: "" } }, required: ["errorReason"] },
    },
  ],
};

/** §8.3 Discovered resource item. */
export const DiscoveryItemSchema = {
  type: "object",
  properties: {
    resource: { type: "string", minLength: 1 },
    type: { type: "string" },
    x402Version: { type: "number" },
    accepts: { type: "array", minItems: 1, items: PaymentRequirementsSchema },
    lastUpdated: { type: "number" },
    extensions: { type: "object" },
  },
  required: ["resource", "type", "x402Version", "accepts", "lastUpdated"],
};

/** §8.1 Discovery resources response. */
export const DiscoveryResponseSchema = {
  type: "object",
  properties: {
    x402Version: { type: "number", const: 2 },
    items: { type: "array", items: DiscoveryItemSchema },
    pagination: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
        total: { type: "number" },
      },
      required: ["limit", "offset", "total"],
    },
  },
  required: ["x402Version", "items", "pagination"],
};

/** §7.1 facilitator verify/settle request body. */
export const FacilitatorRequestSchema = {
  type: "object",
  properties: {
    x402Version: { type: "number", const: 2 },
    paymentPayload: {
      type: "object",
      properties: {
        x402Version: { type: "number" },
        resource: { type: "object" },
        accepted: PaymentRequirementsSchema,
        payload: { type: "object" },
        extensions: { type: "object" },
      },
      required: ["x402Version", "accepted", "payload"],
    },
    paymentRequirements: PaymentRequirementsSchema,
  },
  required: ["x402Version", "paymentPayload", "paymentRequirements"],
};
