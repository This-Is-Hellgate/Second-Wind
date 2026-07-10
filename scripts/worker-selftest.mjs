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
];
const kvData = new Map([
  ["manifest", JSON.stringify(manifest)],
  ["tool:AWS-0571", "# The goods\nShard the hot key. Switch to on-demand billing. Backoff with jitter."],
]);

const env = {
  X402_PAYTO_PUBLIC: "0xa395b99E69A77479e3882320bea9bFC6972EEc14",
  X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  // Offline facilitator /supported fixture — the test runs with no network.
  X402_TEST_SUPPORTED_KINDS: JSON.stringify({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
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
check("proof: 200 + tools_live from manifest", proof.status === 200 && proofBody.tools_live === 2, String(proofBody.tools_live));
check("proof: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(proofBody)));

const tools = await call("/api/tools");
const toolsBody = await tools.json();
check("tools: 200 with both objects listed", tools.status === 200 && toolsBody.total_live === 2);
check("tools: bundle listed alongside text tool", JSON.stringify(toolsBody).includes("lambda-rescue-bundle"));

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
  check("402: scheme exact on Base mainnet", a.scheme === "exact" && a.network === "eip155:8453");
  check("402: payTo is Second Wind wallet", (a.payTo || "").toLowerCase() === env.X402_PAYTO_PUBLIC.toLowerCase());
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

// 5. not in the manifest -> not for sale -> 404
const missing = await call("/api/x402/nonexistent-tool");
check("unknown tool: 404 with pointer", missing.status === 404 && (await missing.json()).tools === "/api/tools");

// 6. discovery documents — generated from the manifest
const openapi = await (await call("/openapi.json")).json();
check("openapi: components.schemas present", Object.keys(openapi.components?.schemas || {}).length >= 6);
check("openapi: both object paths present", Boolean(openapi.paths["/api/x402/dynamodb-throttle-diagnostic"]) && Boolean(openapi.paths["/api/x402/lambda-rescue-bundle"]));
check("openapi: bundle delivers binary", JSON.stringify(openapi.paths["/api/x402/lambda-rescue-bundle"].get.responses["200"]).includes("octet-stream"));
check("openapi: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(openapi)), (JSON.stringify(openapi).match(BANNED_WORDS) || [""])[0]);
const wellKnown = await (await call("/.well-known/x402")).json();
specCheck("§8 discovery resources document", DiscoveryResponseSchema, wellKnown);
check("resources: one item per object", wellKnown.items.length === 2);

// 7. no KV binding -> graceful empty inventory, never an error
const bare = await worker.fetch(new Request("https://secondwindai.com/api/tools"), { ...env, SW_KV: undefined }, ctx);
check("no KV binding: empty listing, 200", bare.status === 200 && (await bare.json()).total_live === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
