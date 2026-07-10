#!/usr/bin/env node
/**
 * Second Wind self-test — runs the real handlers against an in-memory SQLite
 * mirror of the production database. No network, no payments: proves the 402
 * envelope (decoded with the OFFICIAL @x402/core functions), discovery
 * generation, extension conformance (validated with @x402/extensions), the
 * vocabulary ban, and the structural double-charge guard before anything
 * deploys. Requires node >= 22.5 (node:sqlite).
 */
import { DatabaseSync } from "node:sqlite";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  declareDiscoveryExtension,
  declarePaymentIdentifierExtension,
  validateDiscoveryExtension,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions";

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
      // D1 numbered params (?1, ?2, ...) can appear in any order in the SQL
      // text; remap bind args to the positional order they appear in.
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
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

const BANNED_WORDS = /"[^"]*\b(catalog|shelf|shelves|lounge|door)\b[^"]*"/i;

// 1. store: only live rows visible
const { liveItems, recordVerifiedPayment, markFailed } = await import("../functions/_lib/store.js");
const items = await liveItems(env);
check("store: draft rows invisible", items.length === 2, `live=${items.length}`);

// 2. paid endpoint: bare GET returns a 402 the OFFICIAL SDK can decode
const paidEndpoint = await import("../functions/api/x402/[sku].js");
const res402 = await paidEndpoint.onRequestGet({ env, params: { sku: "AWS-0571" }, request: new Request("https://secondwindai.com/api/x402/AWS-0571") });
check("paid: unpaid -> 402", res402.status === 402);
const prHeader = res402.headers.get("PAYMENT-REQUIRED");
check("paid: PAYMENT-REQUIRED header present", Boolean(prHeader));

let prBody = null;
try {
  prBody = decodePaymentRequiredHeader(prHeader);
  check("402 header: decodes via official @x402/core", true);
} catch (err) {
  check("402 header: decodes via official @x402/core", false, String(err?.message || err));
  prBody = JSON.parse(atob(prHeader));
}
check("402: x402Version 2", prBody.x402Version === 2);
check("402: accepts is array", Array.isArray(prBody.accepts) && prBody.accepts.length > 0);
const a = prBody.accepts[0];
check("402: CAIP-2 network", a.network === "eip155:8453", a.network);
check("402: scheme is 'exact'", a.scheme === "exact", a.scheme);
check("402: payTo is Second Wind wallet", (a.payTo || "").toLowerCase() === env.X402_PAYTO_PUBLIC.toLowerCase());
check("402: EIP-712 extra present", Boolean(a.extra?.name && a.extra?.version));
check("402: amount = $0.15 in micros", a.amount === "150000", String(a.amount));

// 3. ResourceInfo object with optional v2 fields
const r = prBody.resource;
check("402: resource is ResourceInfo object", r && typeof r === "object" && typeof r.url === "string");
check("402: resource.serviceName <= 32 ASCII", typeof r?.serviceName === "string" && r.serviceName.length <= 32);
check("402: resource.iconUrl absolute http(s)", /^https?:\/\//.test(r?.iconUrl || ""));
check("402: resource.tags <= 5", !r?.tags || (Array.isArray(r.tags) && r.tags.length <= 5));

// 4. Extensions: bazaar validates against ITS OWN schema (official Ajv check),
//    matches the official helper shape, and payment-identifier is declared.
const ext = prBody.extensions || {};
check("ext: bazaar present in header", Boolean(ext.bazaar?.info && ext.bazaar?.schema));
const bazaarValidation = validateDiscoveryExtension(ext.bazaar || {});
check("ext: bazaar passes official validateDiscoveryExtension", bazaarValidation?.valid === true, JSON.stringify(bazaarValidation?.errors || ""));
const helperShape = declareDiscoveryExtension({ type: "http", method: "GET" });
check(
  "ext: bazaar input matches official helper output",
  JSON.stringify(ext.bazaar?.info?.input) === JSON.stringify(helperShape.bazaar.info.input)
);
const declaredPi = declarePaymentIdentifierExtension(false);
check(
  "ext: payment-identifier declared per spec",
  JSON.stringify(ext[PAYMENT_IDENTIFIER]?.info) === JSON.stringify(declaredPi.info)
);

// 5. 402 body: resource object, plain links, no banned vocabulary
const body402 = await res402.clone().json();
check("402 body: resource is object", body402.resource && typeof body402.resource === "object");
check("402 body: links.tools present", body402.links?.tools?.endsWith("/api/tools"));
check("402 body: no lounge/bar leftovers", !("lounge" in body402) && !JSON.stringify(body402).includes("/api/bar/"));
check("402 body: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(body402)), (JSON.stringify(body402).match(BANNED_WORDS) || [""])[0]);

// 6. held sku -> 404 pointing at /api/tools
const res404 = await paidEndpoint.onRequestGet({ env, params: { sku: "AWS-0602" }, request: new Request("https://secondwindai.com/api/x402/AWS-0602") });
check("paid: held draft -> 404", res404.status === 404);
const body404 = await res404.json();
check("404 body: points at /api/tools", body404.tools === "/api/tools");

// 7. structural double-charge guard + failed-settlement retry path
const p = { id: "pay_a", sku: "AWS-0571", price_usd: 0.15, amount_usdc_micros: "150000", payer: "0x1", network: "eip155:8453", scheme: "exact", idempotency_key: "same-key" };
const first = await recordVerifiedPayment(env, p);
const second = await recordVerifiedPayment(env, { ...p, id: "pay_b" });
check("guard: first insert accepted", first.inserted === true);
check("guard: duplicate rejected by DB", second.inserted === false && second.existing?.id === "pay_a");
await markFailed(env, "pay_a", "facilitator_unreachable");
const third = await recordVerifiedPayment(env, { ...p, id: "pay_c" });
check("guard: failed payment visible for retry", third.inserted === false && third.existing?.status === "failed", third.existing?.status);

// 8. tools listing endpoint
const toolsEndpoint = await import("../functions/api/tools.js");
const resTools = await toolsEndpoint.onRequestGet({ env });
const toolsBody = await resTools.json();
check("tools: 200 with live tools", resTools.status === 200 && toolsBody.total_live === 2);
check("tools: entries carry sku+price+url", toolsBody.tools.every((t) => t.sku && t.price_usd > 0 && t.url.includes("/api/x402/")));
check("tools: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(toolsBody)));

// 9. proof endpoint
const proofEndpoint = await import("../functions/api/proof.js");
const resProof = await proofEndpoint.onRequestGet({ env });
const proofBody = await resProof.json();
check("proof: tools_live count", proofBody.tools_live === 2, String(proofBody.tools_live));
check("proof: discovery.tools link", proofBody.discovery?.tools?.endsWith("/api/tools"));
check("proof: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(proofBody)));

// 10. discovery: openapi + resources built from the same live rows, full schemas
const { buildOpenApi, buildX402Resources } = await import("../functions/_lib/discovery.js");
const spec = await buildOpenApi(env);
const toolOps = Object.keys(spec.paths).filter((p2) => p2.startsWith("/api/x402/") && !p2.includes("{"));
check("openapi: one path per live item", toolOps.length === 2, `paths=${toolOps.length}`);
check("openapi: template path present", Boolean(spec.paths["/api/x402/{sku}"]));
check("openapi: components.schemas defined", Object.keys(spec.components?.schemas || {}).length >= 6, String(Object.keys(spec.components?.schemas || {}).length));
check(
  "openapi: every operation carries response schemas",
  Object.values(spec.paths).every((p2) => {
    const responses = p2.get?.responses || {};
    return Object.values(responses).every((resp) => !resp.content || resp.content["application/json"]?.schema);
  })
);
check("openapi: free surfaces security []", spec.paths["/api/proof"].get.security.length === 0);
check("openapi: banned vocabulary absent", !BANNED_WORDS.test(JSON.stringify(spec)), (JSON.stringify(spec).match(BANNED_WORDS) || [""])[0]);
// Discovery resources document per core spec §8: {x402Version, items[],
// pagination}; items carry FULL PaymentRequirements in accepts[], a numeric
// lastUpdated, per-item x402Version, and a validating bazaar extension.
const resources = await buildX402Resources(env);
check("resources: top-level x402Version 2", resources.x402Version === 2);
check("resources: one item per live tool", resources.items.length === 2);
check("resources: pagination present", resources.pagination?.total === 2 && typeof resources.pagination.limit === "number");
const urls = resources.items.map((r2) => r2.resource);
check("resources: no duplicate URLs", new Set(urls).size === urls.length);
check("resources: links.tools present", resources.links.tools.endsWith("/api/tools"));
check(
  "resources: items are spec-shaped (§8.3)",
  resources.items.every(
    (r2) =>
      r2.type === "http" &&
      r2.x402Version === 2 &&
      typeof r2.lastUpdated === "number" &&
      Array.isArray(r2.accepts) &&
      r2.accepts.every(
        (acc) =>
          acc.scheme === "exact" &&
          /^eip155:\d+$/.test(acc.network) &&
          typeof acc.amount === "string" &&
          typeof acc.asset === "string" &&
          typeof acc.payTo === "string" &&
          typeof acc.maxTimeoutSeconds === "number"
      )
  )
);
check(
  "resources: per-item bazaar validates officially",
  resources.items.every((r2) => validateDiscoveryExtension(r2.extensions?.bazaar || {})?.valid === true)
);
check(
  "resources: accepts amount matches price",
  resources.items.every((r2) => Number(r2.accepts[0].amount) === Math.round(r2.metadata.price_usd * 1_000_000))
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
