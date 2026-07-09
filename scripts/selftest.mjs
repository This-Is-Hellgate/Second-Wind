#!/usr/bin/env node
/**
 * Second Wind self-test — runs the real handlers against an in-memory SQLite
 * mirror of second-wind-catalog. No network, no payments: proves the 402
 * envelope, catalog/discovery generation, and the structural double-charge
 * guard before anything deploys. Requires: node --experimental-sqlite (22.x)
 * or plain node >= 22.5.
 */
import { DatabaseSync } from "node:sqlite";

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
INSERT INTO catalog_items (sku, slug, name, item_type, service_slug, category_slug, price_usd, summary, source_repo, source_path, source_url, license_spdx, provenance, content_hash, status)
VALUES
 ('AWS-0571','dynamodb-throttle-diagnostic','dynamodb-throttle-diagnostic','diagnostic','dynamodb','operations/diagnostics',0.15,'ProvisionedThroughputExceededException: switch billing, shard hot keys, backoff with jitter.','awslabs/amazon-dynamodb-tools','','https://github.com/awslabs/amazon-dynamodb-tools','Apache-2.0','upstream','c3aff7883527f5bd','live'),
 ('AWS-0631','cdk-lambda','cdk-lambda','construct','lambda','compute_runtime/serverless',0.05,'CDK L2 constructs for Lambda.','aws/aws-cdk','packages/aws-cdk-lib/aws-lambda','https://github.com/aws/aws-cdk','Apache-2.0','upstream','45904f3ba8fd7f79','live'),
 ('AWS-0602','aws-s3-service-overview','aws-s3-service-overview','tool','s3','storage_data/object-storage',0.05,'held item','awslabs/mcp','src','https://github.com/awslabs/mcp','Apache-2.0','upstream','e773c3cefd69ca8c','draft');
`);

// D1-shaped shim over node:sqlite
const env = {
  X402_PAYTO_PUBLIC: "0xa395b99E69A77479e3882320bea9bFC6972EEc14",
  X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  SW_DB: {
    prepare(sql) {
      const stmt = db.prepare(sql.replaceAll("?1", "?").replaceAll("?2", "?").replaceAll("?3", "?").replaceAll("?4", "?").replaceAll("?5", "?").replaceAll("?6", "?").replaceAll("?7", "?").replaceAll("?8", "?"));
      const wrap = (args) => ({
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { return stmt.run(...args); },
      });
      return { bind: (...args) => wrap(args), ...wrap([]) };
    },
  },
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// 1. store: only live rows visible
const { liveItems, recordVerifiedPayment } = await import("../functions/_lib/store.js");
const items = await liveItems(env);
check("store: draft rows invisible", items.length === 2, `live=${items.length}`);

// 2. door: bare GET returns a 402 with a decodable PAYMENT-REQUIRED header
const door = await import("../functions/api/x402/[sku].js");
const res402 = await door.onRequestGet({ env, params: { sku: "AWS-0571" }, request: new Request("https://secondwindai.com/api/x402/AWS-0571") });
check("door: unpaid -> 402", res402.status === 402);
const prHeader = res402.headers.get("PAYMENT-REQUIRED");
check("door: PAYMENT-REQUIRED header present", Boolean(prHeader));
const prBody = JSON.parse(atob(prHeader));
check("402: x402Version 2", prBody.x402Version === 2);
check("402: accepts is array", Array.isArray(prBody.accepts) && prBody.accepts.length > 0);
const a = prBody.accepts[0];
check("402: CAIP-2 network", a.network === "eip155:8453", a.network);
check("402: payTo is Second Wind wallet", (a.payTo || "").toLowerCase() === env.X402_PAYTO_PUBLIC.toLowerCase());
check("402: EIP-712 extra present", Boolean(a.extra?.name && a.extra?.version));
check("402: amount = $0.15 in micros", a.amount === "150000" || prBody.maxAmountRequired === "150000", String(a.amount));

// 3. held sku -> 404
const res404 = await door.onRequestGet({ env, params: { sku: "AWS-0602" }, request: new Request("https://secondwindai.com/api/x402/AWS-0602") });
check("door: held draft -> 404", res404.status === 404);

// 4. structural double-charge guard
const p = { id: "pay_a", sku: "AWS-0571", price_usd: 0.15, amount_usdc_micros: "150000", payer: "0x1", network: "eip155:8453", scheme: "ExactEvmScheme", idempotency_key: "same-key" };
const first = await recordVerifiedPayment(env, p);
const second = await recordVerifiedPayment(env, { ...p, id: "pay_b" });
check("guard: first insert accepted", first.inserted === true);
check("guard: duplicate rejected by DB", second.inserted === false && second.existing?.id === "pay_a");

// 5. discovery: openapi + resources built from the same live rows
const { buildOpenApi, buildX402Resources } = await import("../functions/_lib/discovery.js");
const spec = await buildOpenApi(env);
const doorOps = Object.keys(spec.paths).filter((p2) => p2.startsWith("/api/x402/"));
check("openapi: one path per live item", doorOps.length === 2, `paths=${doorOps.length}`);
check("openapi: x-guidance on every door", doorOps.every((p2) => spec.paths[p2].get["x-guidance"]));
check("openapi: free surfaces security []", spec.paths["/api/proof"].get.security.length === 0);
const resources = await buildX402Resources(env);
check("resources: one entry per live item", resources.resources.length === 2);
const urls = resources.resources.map((r) => r.resource);
check("resources: no duplicate URLs", new Set(urls).size === urls.length);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
