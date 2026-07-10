#!/usr/bin/env node
/**
 * Gatekeeper self-test — runs the REAL Hono worker (official @x402/hono SDK)
 * against in-memory shims. No network, no payments.
 *
 * Product truth under test: the deliverable is the RESOLVED CAPABILITY
 * (guidance + composition graph + invocation), never a file dump. The free
 * surface carries stubs only — the suite FAILS if guidance or the graph ever
 * leaks onto a free surface (the paywalled-GitHub failure mode).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validateDiscoveryExtension, PAYMENT_IDENTIFIER } from "@x402/extensions";
import Ajv from "ajv";
import { PaymentRequiredSchema, DiscoveryResponseSchema } from "./spec-schemas.mjs";

// D1: the curated index + graph (single-sourced from the migration) + ledger.
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../migrations/0001_curation.sql", import.meta.url), "utf8"));
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

const GUIDANCE_MARKER = "GUIDANCE-ONLY-BEHIND-THE-PAYWALL";
db.exec(`
INSERT INTO items (sku, slug, name, kind, service, summary, guidance, price_usd, invoke_kind, invoke_key, input_schema, input_example, mime_type, source_repo, source_url, license_spdx, provenance, content_hash, status) VALUES
 ('AWS-0571','dynamodb-throttle-diagnostic','writes throttled on one key','tool','dynamodb',
  'ProvisionedThroughputExceededException: switch billing, shard hot keys, backoff with jitter.',
  '${GUIDANCE_MARKER}: Reach for this when writes spike on one partition key. Wire the CloudWatch alarm first; the gotcha is that on-demand switching takes effect per-table, not per-index.',
  0.15,'resolve','','','','','awslabs/amazon-dynamodb-tools','https://github.com/awslabs/amazon-dynamodb-tools','Apache-2.0','upstream','c3aff7883527f5bd','live'),
 ('AWS-0572','dynamodb-hot-key-sharder','one partition takes all writes','tool','dynamodb',
  'Write-sharding pattern for hot partition keys.',
  'Use AFTER the throttle diagnostic confirms a hot key. Prefix-shard by tenant, never randomly.',
  0.20,'resolve','','','','','awslabs/amazon-dynamodb-tools','https://github.com/awslabs','Apache-2.0','upstream','dd22dd22dd22dd22','live'),
 ('AWS-0900','dynamo-rescue-workflow','my table is throttled','workflow','dynamodb',
  'The full remediation path for a throttled DynamoDB table, wired in order.',
  'Run the steps in order; skip step 2 only if the diagnostic shows uniform load.',
  0.60,'resolve','','','','','','','','synthesized','ee33ee33ee33ee33','live'),
 ('AWS-1001','lambda-rescue-agent','my lambda loops forever','agent','lambda',
  'Bedrock agent that diagnoses and remediates runaway Lambda execution loops.',
  'Give it the function name and the symptom; it reads the logs itself.',
  0.05,'bedrock','AGENT12345/ALIAS1','{"properties":{"input":{"type":"string","description":"The task for the agent"},"sessionId":{"type":"string"}},"required":["input"]}','{"input":"my lambda is stuck in a retry loop"}','','','','','synthesized','aa11aa11aa11aa11','live'),
 ('AWS-0999','lambda-rescue-bundle','scripts to stop loops','artifact','lambda',
  'Zipped remediation scripts for runaway Lambda execution loops.',
  'The scripts assume Python 3.12 runtimes; read RUNBOOK.md inside first.',
  0.95,'r2','bundle:AWS-0999','','','application/zip','aws/aws-lambda-tools','https://github.com/aws','Apache-2.0','upstream','beefbeefbeefbeef','live'),
 ('AWS-0601','held-draft','held-draft','tool','s3','held item','not visible',0.05,'resolve','','','','','','','','upstream','ffffffffffffffff','draft');

INSERT INTO edges (from_sku, to_sku, relation, position, note) VALUES
 ('AWS-0571','AWS-0900','step_of',1,'Diagnose before touching capacity.'),
 ('AWS-0572','AWS-0900','step_of',2,'Shard only what the diagnostic implicates.'),
 ('AWS-0571','AWS-0572','composes_with',NULL,'The diagnostic tells you WHERE to shard.'),
 ('AWS-0900','AWS-1001','pairs_with',NULL,'Hand the workflow output to the agent for automated remediation.');
`);

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
  SW_R2: {
    async get(key) {
      if (key !== "bundle:AWS-0999") return null;
      return { body: "PK\x03\x04-fake-zip-bytes", httpMetadata: { contentType: "application/zip" } };
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

// 1. free surfaces — stubs only, from the curated index
const proof = await call("/api/proof");
const proofBody = await proof.json();
check("proof: 200 + live count from curated index", proof.status === 200 && proofBody.tools_live === 5, String(proofBody.tools_live));
check("proof: network from config (Sepolia)", proofBody.payment.network === "eip155:84532", proofBody.payment.network);

const tools = await call("/api/tools");
const toolsBody = await tools.json();
const toolsRaw = JSON.stringify(toolsBody);
check("tools: 200 with all live items", tools.status === 200 && toolsBody.total_live === 5);
check("tools: workflow + agent + artifact listed", toolsRaw.includes("dynamo-rescue-workflow") && toolsRaw.includes("lambda-rescue-agent") && toolsRaw.includes("lambda-rescue-bundle"));
check("tools: draft invisible", !toolsRaw.includes("held-draft"));
// Names are symptom hooks: <= 5 words, agent-relatable, never a slug echo.
check("GUARD: names are 4-5 word symptom hooks, not slugs", toolsBody.tools.every((t) => t.name !== t.sku && !t.name.includes("-") && t.name.split(" ").length >= 3 && t.name.split(" ").length <= 5), JSON.stringify(toolsBody.tools.map((t) => t.name)));
// THE GUARD: curation is the product — the free surface never carries it.
check("GUARD: no guidance on the free listing", !toolsRaw.includes(GUIDANCE_MARKER) && !toolsRaw.includes("guidance"));
check("GUARD: no graph on the free listing", !toolsRaw.includes("composition") && !toolsRaw.includes("composes_with"));
check("tools: banned vocabulary absent", !BANNED_WORDS.test(toolsRaw));

// 2. plumbing
const redir = await call("/api/catalog");
check("catalog: 308 -> /api/tools", redir.status === 308 && redir.headers.get("Location")?.endsWith("/api/tools"));
const post = await call("/api/tools", { method: "POST" });
check("wrong method: teaching 405", post.status === 405);
const head = await call("/api/proof", { method: "HEAD" });
check("HEAD mirrors GET", head.status === 200 && (await head.text()) === "");
const asset = await call("/llms.txt");
check("static assets pass through", asset.status === 200 && (await asset.text()) === "static-asset");

// 3. the paid surface — 402 emitted by the OFFICIAL SDK middleware
const unpaid = await call("/api/x402/dynamodb-throttle-diagnostic");
check("paid: unpaid -> 402 (SDK)", unpaid.status === 402, String(unpaid.status));
const pr = decodePaymentRequiredHeader(unpaid.headers.get("PAYMENT-REQUIRED"));
specCheck("§5.1 PaymentRequired (SDK-emitted header)", PaymentRequiredSchema, pr);
const a = pr.accepts[0];
check("402: scheme exact on Base Sepolia", a.scheme === "exact" && a.network === "eip155:84532", a.network);
check("402: Sepolia USDC asset", a.asset === "0x036CbD53842c5426634e7929541eC2318f3dCF7e", a.asset);
check("402: amount = $0.15 in micros", a.amount === "150000", String(a.amount));
// The helper carries output {type, example} only (spec: no output schema) —
// the resolved-capability shape is advertised through the example.
const outExample = pr.extensions?.bazaar?.info?.output?.example || {};
check("402: bazaar example advertises the RESOLVED capability", "guidance" in outExample && "composition" in outExample, Object.keys(outExample).join(","));
check("402: bazaar validates officially", validateDiscoveryExtension(pr.extensions?.bazaar || {})?.valid === true);
check("402: payment-identifier declared", pr.extensions?.[PAYMENT_IDENTIFIER]?.info?.required === false);
check("GUARD: 402 body carries no guidance", !(await unpaid.text()).includes(GUIDANCE_MARKER));

// 4. execution + artifact are paid on their own routes
const unpaidAgent = await call("/api/x402/lambda-rescue-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "help" }) });
check("agent: unpaid POST -> 402", unpaidAgent.status === 402, String(unpaidAgent.status));
const agentPr = decodePaymentRequiredHeader(unpaidAgent.headers.get("PAYMENT-REQUIRED"));
check("agent 402: bazaar advertises POST json body", agentPr.extensions?.bazaar?.info?.input?.method === "POST" && agentPr.extensions?.bazaar?.info?.input?.bodyType === "json");
const agentGet = await call("/api/x402/lambda-rescue-agent");
check("agent: GET teaches POST (no charge)", agentGet.status === 405 && (await agentGet.json()).hint.includes("POST"));
const unpaidArtifact = await call("/api/x402/lambda-rescue-bundle/artifact");
check("GUARD: artifact subpath is x402-gated", unpaidArtifact.status === 402, String(unpaidArtifact.status));
const unpaidResolved = await call("/api/x402/lambda-rescue-bundle");
check("artifact item: primary route is the resolved capability (402)", unpaidResolved.status === 402);

// 5. unknown -> 404
const missing = await call("/api/x402/nonexistent");
check("unknown item: 404 with pointer", missing.status === 404 && (await missing.json()).tools === "/api/tools");

// 6. the resolved capability itself (module-level — behind the paywall in serving)
const { resolveCapability, findItem } = await import("../src/lib/curation.js");
const workflow = await findItem(env, "dynamo-rescue-workflow");
const resolved = await resolveCapability(env, workflow, "https://secondwindai.com");
check("resolved: guidance present (the voice)", resolved.guidance.length > 0);
check("resolved: steps wired in order", resolved.composition.steps.length === 2 && resolved.composition.steps[0].sku === "AWS-0571" && resolved.composition.steps[1].sku === "AWS-0572");
check("resolved: step notes carry the WHY", resolved.composition.steps.every((s) => s.why.length > 0));
check("resolved: pairs_with the agent", resolved.composition.pairs_with.some((p) => p.sku === "AWS-1001"));
const tool = await findItem(env, "AWS-0571");
const resolvedTool = await resolveCapability(env, tool, "https://secondwindai.com");
check("resolved: tool knows its workflow membership", resolvedTool.composition.part_of.some((p) => p.sku === "AWS-0900"));
check("resolved: composes_with carries opinion", resolvedTool.composition.composes_with.some((e) => e.why.includes("WHERE to shard")));
const artifactItem = await findItem(env, "lambda-rescue-bundle");
const resolvedArtifact = await resolveCapability(env, artifactItem, "https://secondwindai.com");
check("resolved: artifact fetch is secondary via invoke", resolvedArtifact.invoke?.url?.endsWith("/artifact"));

// 7. discovery documents — stubs only, spec-shaped
const openapi = await (await call("/openapi.json")).json();
const openapiRaw = JSON.stringify(openapi);
check("openapi: ResolvedCapability schema present", Boolean(openapi.components.schemas.ResolvedCapability));
check("openapi: workflow + agent + artifact paths present", Boolean(openapi.paths["/api/x402/dynamo-rescue-workflow"]) && Boolean(openapi.paths["/api/x402/lambda-rescue-agent"]?.post) && Boolean(openapi.paths["/api/x402/lambda-rescue-bundle/artifact"]));
check("GUARD: no guidance text in openapi", !openapiRaw.includes(GUIDANCE_MARKER));
check("openapi: banned vocabulary absent", !BANNED_WORDS.test(openapiRaw), (openapiRaw.match(BANNED_WORDS) || [""])[0]);
const wellKnown = await (await call("/.well-known/x402")).json();
specCheck("§8 discovery resources document", DiscoveryResponseSchema, wellKnown);
check("resources: one item per live item", wellKnown.items.length === 5);
check("GUARD: no guidance in discovery resources", !JSON.stringify(wellKnown).includes(GUIDANCE_MARKER));
check("resources: Sepolia accepts everywhere", wellKnown.items.every((i) => i.accepts[0].network === "eip155:84532"));

// 8. no D1 binding -> graceful empty tool list, never an error
const bare = await worker.fetch(new Request("https://secondwindai.com/api/tools"), { ...env, SW_DB: undefined }, ctx);
check("no D1 binding: empty listing, 200", bare.status === 200 && (await bare.json()).total_live === 0);

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
check("bedrock: event-stream decode extracts completion", decodeEventStreamCompletion(stream) === chunkText);

const realFetch = globalThis.fetch;
let signedAuth = "";
globalThis.fetch = async (url, init) => {
  const u = typeof url === "string" ? url : url.url;
  if (u.includes("bedrock-agent-runtime")) {
    signedAuth = (init?.headers?.Authorization || new Headers(init?.headers).get("Authorization") || (url.headers && url.headers.get("Authorization"))) ?? "";
    return new Response(stream, { status: 200 });
  }
  throw new Error(`unexpected fetch: ${u}`);
};
const run = await invokeAgent({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" }, "AGENT12345/ALIAS1", { input: "help my lambda" });
globalThis.fetch = realFetch;
check("bedrock: invoke returns completion via SigV4 fetch", run.ok === true && run.completion === chunkText);
check("bedrock: request was SigV4-signed", /AWS4-HMAC-SHA256/.test(signedAuth), signedAuth.slice(0, 40));
const unconfigured = await invokeAgent({}, "A/B", { input: "x" });
check("bedrock: unconfigured -> 503 (never charge)", unconfigured.ok === false && unconfigured.status === 503);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
