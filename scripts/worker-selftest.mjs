#!/usr/bin/env node
/**
 * Gatekeeper self-test — runs the REAL Hono worker (official @x402/hono SDK)
 * against in-memory shims of the production bindings. No network, no
 * payments. The storage truth under test: THE TOOLS ARE OBJECTS — the KV
 * manifest + KV/R2 objects drive every surface; D1 is ledger only.
 */
import { DatabaseSync } from "node:sqlite";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validateDiscoveryExtension, PAYMENT_IDENTIFIER } from "@x402/extensions";
import Ajv from "ajv";
import { PaymentRequiredSchema, DiscoveryResponseSchema } from "./spec-schemas.mjs";

// D1: ledger tables only — the serving path reads NO tool data from D1.
const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE payments (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL, price_usd REAL NOT NULL, amount_usdc_micros TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '', tx_hash TEXT NOT NULL DEFAULT '', network TEXT NOT NULL DEFAULT '',
  scheme TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  facilitator_ref TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT '', settled_at TEXT
);
CREATE TABLE deliveries (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, sku TEXT NOT NULL, content_hash TEXT NOT NULL, delivered_at TEXT DEFAULT '');
CREATE TABLE request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, sku TEXT, method TEXT, status INTEGER, ua_class TEXT, created_at TEXT DEFAULT '');
`);

// KV: the manifest + the tool objects. This IS the inventory.
const manifest = [
  {
    sku: "AWS-0571",
    slug: "dynamodb-throttle-diagnostic",
    name: "dynamodb-throttle-diagnostic",
    item_type: "diagnostic",
    service: "dynamodb",
    price_usd: 0.15,
    summary: "ProvisionedThroughputExceededException: switch billing, shard hot keys, backoff with jitter.",
    source: {
      repo: "awslabs/amazon-dynamodb-tools",
      path: "",
      url: "https://github.com/awslabs/amazon-dynamodb-tools",
      license_spdx: "Apache-2.0",
      provenance: "upstream",
    },
    content_hash: "c3aff7883527f5bd",
    version: 1,
    updated_at: "2026-07-10T12:00:00.000Z",
    store: "kv",
    key: "tool:AWS-0571",
  },
  {
    sku: "AWS-0999",
    slug: "lambda-rescue-bundle",
    name: "lambda-rescue-bundle",
    item_type: "bundle",
    service: "lambda",
    price_usd: 0.95,
    summary: "Zipped remediation scripts for runaway Lambda execution loops.",
    source: { repo: "aws/aws-lambda-tools", path: "", url: "https://github.com/aws", license_spdx: "Apache-2.0", provenance: "upstream" },
    content_hash: "beefbeefbeefbeef",
    version: 1,
    updated_at: "2026-07-10T12:00:00.000Z",
    store: "r2",
    key: "bundle:AWS-0999",
    mime_type: "application/zip",
  },
  {
    sku: "AWS-1001",
    slug: "lambda-rescue-agent",
    name: "lambda-rescue-agent",
    item_type: "agent",
    service: "lambda",
    price_usd: 0.05,
    summary: "Bedrock agent that diagnoses and remediates runaway Lambda execution loops.",
    source: { repo: "", path: "", url: "", license_spdx: "", provenance: "synthesized" },
    content_hash: "aa11aa11aa11aa11",
    version: 1,
    updated_at: "2026-07-10T12:00:00.000Z",
    store: "bedrock",
    key: "AGENT12345/ALIAS1",
    input_example: { input: "my lambda is stuck in a retry loop" },
    input_schema: { properties: { input: { type: "string", description: "The task for the agent" }, sessionId: { type: "string" } }, required: ["input"] },
  },
];
const kvData = new Map([
  ["manifest", JSON.stringify(manifest)],
  ["tool:AWS-0571", "# The goods\nShard the hot key. Switch to on-demand billing. Backoff with jitter."],
]);

const env = {
  X402_PAYTO_PUBLIC: "0xa395b99E69A77479e3882320bea9bFC6972EEc14",
  // FIRST PROOF config: Base Sepolia + public x402.org facilitator.
  X402_NETWORK: "eip155:84532",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  // Offline facilitator /supported fixture — the test runs with no network.
  X402_TEST_SUPPORTED_KINDS: JSON.stringify({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
    extensions: [],
    signers: { "eip155:*": ["0x0000000000000000000000000000000000000000"] },
  }),
  SW_KV: {
    async get(key, type) {
      const value = kvData.get(key) ?? null;
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
  },
  SW_R2: {
    async get(key) {
      if (key !== "bundle:AWS-0999") return null;
      return { body: "PK\x03\x04-fake-zip-bytes", httpMetadata: { contentType: "application/zip" } };
    },
  },
  SW_DB: {
    prepare(sql) {
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      const stmt = db.prepare(sql.replace(/\?\d+/g, "?"));
      const remap = (args) => (order.length ? order.map((n) => args[n - 1]) : args);
      const wrap = (args) => ({
        async first() { return stmt.get(...remap(args)) ?? null; },
        async all() { return { results: stmt.all(...remap(args)) }; },
        async run() { return stmt.run(...remap(args)); },
      });
      return { bind: (...args) => wrap(args), ...wrap([]) };
    },
  },
  ASSETS: { fetch: async () => new Response("static-asset", { status: 200 }) },
};

const worker = (await import("../src/worker.js")).default;
const ctx = { waitUntil() {} };
const call = (path, init = {}) => worker.fetch(new Request(`https://secondwindai.com${path}`, init), env, ctx);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
const ajv = new Ajv({ strict: false, allErrors: true });
const specCheck = (name, schema, value) => {
  const validate = ajv.compile(schema);
  const ok = validate(value);
  check(`SPEC ${name}`, ok, ok ? "" : JSON.stringify(validate.errors?.slice(0, 3)));
};
const BANNED_WORDS = /"[^"]*\b(catalog|shelf|shelves|lounge|door)\b[^"]*"/i;

// 1. free surfaces — driven by the KV manifest
const proof = await call("/api/proof");
const proofBody = await proof.json();
check("proof: 200 + tools_live from manifest", proof.status === 200 && proofBody.tools_live === 3, String(proofBody.tools_live));
check("proof: network from config (Sepolia)", proofBody.payment.network === "eip155:84532", proofBody.payment.network);
check("proof: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(proofBody)));

const tools = await call("/api/tools");
const toolsBody = await tools.json();
check("tools: 200 with all objects listed", tools.status === 200 && toolsBody.total_live === 3);
check("tools: bundle + agent listed alongside text tool", JSON.stringify(toolsBody).includes("lambda-rescue-bundle") && JSON.stringify(toolsBody).includes("lambda-rescue-agent"));

// 2. redirect + 405 + HEAD + assets
const redir = await call("/api/catalog");
check("catalog: 308 -> /api/tools", redir.status === 308 && redir.headers.get("Location")?.endsWith("/api/tools"));
const post = await call("/api/tools", { method: "POST" });
check("wrong method: teaching 405", post.status === 405 && (await post.json()).hint.includes("GET"));
const head = await call("/api/proof", { method: "HEAD" });
check("HEAD mirrors GET", head.status === 200 && (await head.text()) === "");
const asset = await call("/llms.txt");
check("static assets pass through", asset.status === 200 && (await asset.text()) === "static-asset");

// 3. the paid surface — 402 emitted by the OFFICIAL SDK middleware
const unpaid = await call("/api/x402/dynamodb-throttle-diagnostic");
check("paid: unpaid -> 402 (SDK)", unpaid.status === 402, String(unpaid.status));
const prHeader = unpaid.headers.get("PAYMENT-REQUIRED");
check("paid: PAYMENT-REQUIRED header present", Boolean(prHeader));
let pr = null;
try {
  pr = decodePaymentRequiredHeader(prHeader);
  check("402 header: decodes via official @x402/core", true);
} catch (err) {
  check("402 header: decodes via official @x402/core", false, String(err?.message || err));
}
if (pr) {
  specCheck("§5.1 PaymentRequired (SDK-emitted header)", PaymentRequiredSchema, pr);
  const a = pr.accepts[0];
  check("402: scheme exact on Base Sepolia", a.scheme === "exact" && a.network === "eip155:84532", a.network);
  check("402: Sepolia USDC asset", a.asset === "0x036CbD53842c5426634e7929541eC2318f3dCF7e", a.asset);
  check("402: payTo is the configured wallet", (a.payTo || "").toLowerCase() === env.X402_PAYTO_PUBLIC.toLowerCase());
  check("402: amount = $0.15 in micros", a.amount === "150000", String(a.amount));
  check("402: EIP-712 extra present", Boolean(a.extra?.name && a.extra?.version));
  check("402: resource.serviceName set", pr.resource?.serviceName === "Second Wind");
  const bazaarValidation = validateDiscoveryExtension(pr.extensions?.bazaar || {});
  check("402: bazaar validates officially", bazaarValidation?.valid === true, JSON.stringify(bazaarValidation?.errors || ""));
  check("402: payment-identifier declared", pr.extensions?.[PAYMENT_IDENTIFIER]?.info?.required === false);
}

// 4. sku path and R2 bundle route are paid too
const unpaidSku = await call("/api/x402/AWS-0571");
check("paid: SKU path also 402", unpaidSku.status === 402);
const unpaidBundle = await call("/api/x402/lambda-rescue-bundle");
check("paid: R2 bundle route also 402", unpaidBundle.status === 402);
const bundlePr = decodePaymentRequiredHeader(unpaidBundle.headers.get("PAYMENT-REQUIRED"));
check("bundle 402: amount = $0.95 in micros", bundlePr.accepts[0].amount === "950000", bundlePr.accepts[0].amount);

// 5. the execution tool — POST is the paid method; the bazaar block carries
//    bodyType json + input schema; GET teaches POST without charging
const unpaidAgent = await call("/api/x402/lambda-rescue-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "help" }) });
check("agent: unpaid POST -> 402", unpaidAgent.status === 402, String(unpaidAgent.status));
const agentPr = decodePaymentRequiredHeader(unpaidAgent.headers.get("PAYMENT-REQUIRED"));
specCheck("§5.1 PaymentRequired (execution tool)", PaymentRequiredSchema, agentPr);
check("agent 402: bazaar advertises POST json body", agentPr.extensions?.bazaar?.info?.input?.method === "POST" && agentPr.extensions?.bazaar?.info?.input?.bodyType === "json");
check("agent 402: bazaar validates officially", validateDiscoveryExtension(agentPr.extensions?.bazaar || {})?.valid === true);
const agentGet = await call("/api/x402/lambda-rescue-agent");
check("agent: GET teaches POST (no charge)", agentGet.status === 405 && (await agentGet.json()).hint.includes("POST"));

// 6. not in the manifest -> not for sale -> 404
const missing = await call("/api/x402/nonexistent-tool");
check("unknown tool: 404 with pointer", missing.status === 404 && (await missing.json()).tools === "/api/tools");

// 7. discovery documents — generated from the manifest
const openapi = await (await call("/openapi.json")).json();
check("openapi: components.schemas present", Object.keys(openapi.components?.schemas || {}).length >= 6);
check("openapi: all object paths present", Boolean(openapi.paths["/api/x402/dynamodb-throttle-diagnostic"]) && Boolean(openapi.paths["/api/x402/lambda-rescue-bundle"]) && Boolean(openapi.paths["/api/x402/lambda-rescue-agent"]));
check("openapi: bundle delivers binary", JSON.stringify(openapi.paths["/api/x402/lambda-rescue-bundle"].get.responses["200"]).includes("octet-stream"));
check("openapi: agent is POST with requestBody", Boolean(openapi.paths["/api/x402/lambda-rescue-agent"].post?.requestBody));
check("openapi: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(openapi)), (JSON.stringify(openapi).match(BANNED_WORDS) || [""])[0]);
const wellKnown = await (await call("/.well-known/x402")).json();
specCheck("§8 discovery resources document", DiscoveryResponseSchema, wellKnown);
check("resources: one item per object", wellKnown.items.length === 3);
check("resources: Sepolia accepts everywhere", wellKnown.items.every((i) => i.accepts[0].network === "eip155:84532" && i.accepts[0].asset === "0x036CbD53842c5426634e7929541eC2318f3dCF7e"));

// 8. no KV binding -> graceful empty inventory, never an error
const bare = await worker.fetch(new Request("https://secondwindai.com/api/tools"), { ...env, SW_KV: undefined }, ctx);
check("no KV binding: empty listing, 200", bare.status === 200 && (await bare.json()).total_live === 0);

// 9. Bedrock origin units — event-stream decode + signed invoke (fetch stubbed)
const { decodeEventStreamCompletion, invokeAgent } = await import("../src/lib/bedrock.js");
const encoder = new TextEncoder();
function frame(eventType, payloadObj) {
  const name = encoder.encode(":event-type");
  const value = encoder.encode(eventType);
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  let o = 0;
  headers[o++] = name.length;
  headers.set(name, o); o += name.length;
  headers[o++] = 7; // string type
  new DataView(headers.buffer).setUint16(o, value.length); o += 2;
  headers.set(value, o);
  const payload = encoder.encode(JSON.stringify(payloadObj));
  const total = 12 + headers.length + payload.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(payload, 12 + headers.length);
  return out;
}
const chunkText = "Shard the hot key.";
const stream = new Uint8Array([...frame("chunk", { bytes: btoa(chunkText) }), ...frame("trace", { note: "ignored" })]);
check("bedrock: event-stream decode extracts completion", decodeEventStreamCompletion(stream) === chunkText, JSON.stringify(decodeEventStreamCompletion(stream)));

const realFetch = globalThis.fetch;
let signedAuth = "";
globalThis.fetch = async (url, init) => {
  const u = typeof url === "string" ? url : url.url;
  if (u.includes("bedrock-agent-runtime")) {
    signedAuth = (init?.headers?.Authorization || init?.headers?.get?.("Authorization") || new Headers(init?.headers).get("Authorization") || (url.headers && url.headers.get("Authorization"))) ?? "";
    return new Response(stream, { status: 200 });
  }
  throw new Error(`unexpected fetch: ${u}`);
};
const bedrockEnv = { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" };
const run = await invokeAgent(bedrockEnv, "AGENT12345/ALIAS1", { input: "help my lambda" });
globalThis.fetch = realFetch;
check("bedrock: invoke returns completion via SigV4 fetch", run.ok === true && run.completion === chunkText, JSON.stringify(run).slice(0, 120));
check("bedrock: request was SigV4-signed", /AWS4-HMAC-SHA256/.test(signedAuth), signedAuth.slice(0, 40));
const unconfigured = await invokeAgent({}, "A/B", { input: "x" });
check("bedrock: unconfigured -> 503 (never charge)", unconfigured.ok === false && unconfigured.status === 503);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
