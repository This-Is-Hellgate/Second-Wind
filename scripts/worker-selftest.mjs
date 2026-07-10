#!/usr/bin/env node
/**
 * Gatekeeper self-test — runs the REAL Hono worker (official @x402/hono SDK)
 * against an in-memory SQLite mirror of the production database. No network,
 * no payments: proves the SDK-emitted 402 envelope against the spec schemas,
 * the free surfaces, redirects, teaching 405s, HEAD mirroring, and the
 * vocabulary ban. Requires node >= 22.5 (node:sqlite).
 */
import { DatabaseSync } from "node:sqlite";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validateDiscoveryExtension, PAYMENT_IDENTIFIER } from "@x402/extensions";
import Ajv from "ajv";
import { PaymentRequiredSchema, DiscoveryResponseSchema } from "./spec-schemas.mjs";

const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE catalog_items (
  sku TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, item_type TEXT NOT NULL,
  service_slug TEXT NOT NULL, category_slug TEXT NOT NULL, price_usd REAL NOT NULL, summary TEXT NOT NULL,
  source_repo TEXT NOT NULL DEFAULT '', source_path TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
  license_spdx TEXT NOT NULL DEFAULT '', provenance TEXT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, yard_artifact_id TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', published_at TEXT
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL, price_usd REAL NOT NULL, amount_usdc_micros TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '', tx_hash TEXT NOT NULL DEFAULT '', network TEXT NOT NULL DEFAULT '',
  scheme TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  facilitator_ref TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT '', settled_at TEXT
);
CREATE UNIQUE INDEX idx_payments_idem ON payments(idempotency_key) WHERE idempotency_key != '';
CREATE TABLE deliveries (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, sku TEXT NOT NULL, content_hash TEXT NOT NULL, delivered_at TEXT DEFAULT '');
CREATE TABLE request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, sku TEXT, method TEXT, status INTEGER, ua_class TEXT, created_at TEXT DEFAULT '');
INSERT INTO catalog_items (sku, slug, name, item_type, service_slug, category_slug, price_usd, summary, source_repo, source_url, license_spdx, provenance, content_hash, status)
VALUES
 ('AWS-0571','dynamodb-throttle-diagnostic','dynamodb-throttle-diagnostic','diagnostic','dynamodb','operations/diagnostics',0.15,'ProvisionedThroughputExceededException: switch billing, shard hot keys, backoff with jitter.','awslabs/amazon-dynamodb-tools','https://github.com/awslabs/amazon-dynamodb-tools','Apache-2.0','upstream','c3aff7883527f5bd','live'),
 ('AWS-0602','aws-s3-service-overview','aws-s3-service-overview','tool','s3','storage_data/object-storage',0.05,'held item','awslabs/mcp','https://github.com/awslabs/mcp','Apache-2.0','upstream','e773c3cefd69ca8c','draft');
`);

const env = {
  X402_PAYTO_PUBLIC: "0xa395b99E69A77479e3882320bea9bFC6972EEc14",
  X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  // Offline facilitator /supported fixture — the test runs with no network.
  X402_TEST_SUPPORTED_KINDS: JSON.stringify({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
    extensions: [],
    signers: { "eip155:*": ["0x0000000000000000000000000000000000000000"] },
  }),
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
  SW_KV: { get: async (key) => (key === "tool:AWS-0571" ? "# The goods\nShard the hot key." : null) },
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

// 1. free surfaces
const proof = await call("/api/proof");
const proofBody = await proof.json();
check("proof: 200 + tools_live", proof.status === 200 && proofBody.tools_live === 1, String(proofBody.tools_live));
check("proof: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(proofBody)));

const tools = await call("/api/tools");
const toolsBody = await tools.json();
check("tools: 200 with 1 live tool", tools.status === 200 && toolsBody.total_live === 1);
check("tools: draft invisible", !JSON.stringify(toolsBody).includes("AWS-0602"));

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

// 4. sku path serves the same paid route
const unpaidSku = await call("/api/x402/AWS-0571");
check("paid: SKU path also 402", unpaidSku.status === 402);

// 5. unknown + draft tools -> 404 (no payment demanded for nothing)
const missing = await call("/api/x402/nonexistent-tool");
check("unknown tool: 404 with pointer", missing.status === 404 && (await missing.json()).tools === "/api/tools");
const draft = await call("/api/x402/aws-s3-service-overview");
check("draft tool: 404 (not for sale)", draft.status === 404);

// 6. discovery documents
const openapi = await (await call("/openapi.json")).json();
check("openapi: components.schemas present", Object.keys(openapi.components?.schemas || {}).length >= 6);
check("openapi: live tool path present", Boolean(openapi.paths["/api/x402/dynamodb-throttle-diagnostic"]));
check("openapi: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(openapi)), (JSON.stringify(openapi).match(BANNED_WORDS) || [""])[0]);
const wellKnown = await (await call("/.well-known/x402")).json();
specCheck("§8 discovery resources document", DiscoveryResponseSchema, wellKnown);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
