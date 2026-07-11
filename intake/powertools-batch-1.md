# Intake batch 1 — Lambda Powertools (4 runtimes)

Source repos (all MIT-0, verified 2026-07-10):
- aws-powertools/powertools-lambda-python (3.3k★) · docs.aws.amazon.com/powertools/python/latest
- aws-powertools/powertools-lambda-typescript (1.8k★)
- aws-powertools/powertools-lambda-java (318★)
- aws-powertools/powertools-lambda-dotnet (180★)

Structure per Mike: logger / tracer / metrics / parameters are MULTI tools (all
four runtimes in one item's guidance); the rest are SINGLES. One workflow wires
the observability multis in order. Nothing here is published — this is the
draft batch awaiting per-item judgment.

Status: DRAFT — awaiting approval per item.

---

## Multis (4 runtimes each) — $0.25

### SW-PT-0001 · "lambda logs are unsearchable" · `lambda-powertools-logger` · tool
**Summary:** Structured JSON logging for Lambda with request context injected — stop grepping plain-text CloudWatch streams.
**Guidance (paid):** Reach for this the moment you're eyeballing raw CloudWatch text. Wire: Python `Logger()` + `@logger.inject_lambda_context`; TypeScript `new Logger()` + `injectLambdaContext` middy middleware; Java `@Logging` annotation on the handler; .NET `[Logging]` attribute. Every entry becomes queryable JSON with cold-start flag, function context, and your correlation id. The gotcha: set the correlation id path on ingest (API Gateway request id, or your own header) or cross-service search never joins; and sampling (`POWERTOOLS_LOGGER_SAMPLE_RATE`) is per-environment config, not code.
**Edges:** step_of → workflow (1, "searchable logs before anything else") · composes_with tracer ("correlation ids ride trace ids")

### SW-PT-0002 · "cannot trace across services" · `lambda-powertools-tracer` · tool
**Summary:** X-Ray tracing wrapped for Lambda handlers and SDK calls — see one request cross functions, queues, and tables.
**Guidance (paid):** Use when a request dies somewhere between three Lambdas and a queue and nobody knows where. Wire: Python `Tracer()` + `@tracer.capture_lambda_handler` (SDK calls auto-patched); TypeScript `captureLambdaHandler` middleware + `captureAWSv3Client`; Java `@Tracing`; .NET `[Tracing]`. Annotations mark business keys (`tracer.put_annotation("orderId", ...)`) so you can filter traces by YOUR ids, not AWS's. Gotcha: X-Ray must be enabled on the function (`Tracing: Active`) or everything silently no-ops; and async Python functions need `capture_method` explicitly.
**Edges:** step_of → workflow (2, "traces make the logs navigable")

### SW-PT-0003 · "metrics without extra api calls" · `lambda-powertools-metrics` · tool
**Summary:** Custom CloudWatch metrics via Embedded Metric Format — emitted inline with logs, zero PutMetricData calls, zero added latency.
**Guidance (paid):** Use when you want business metrics (orders, payments, tool sales) without paying PutMetricData latency and cost per invocation. Wire: Python `Metrics()` + `@metrics.log_metrics`; TypeScript `logMetrics` middleware; Java `@Metrics`; .NET `[Metrics]`. Metrics serialize into the log stream as EMF and CloudWatch extracts them asynchronously. Gotchas: EMF hard-caps 100 metrics per blob and dimensions are cardinality bombs — never put a user/request id in a dimension; put it in metadata. `raise_on_empty_metrics` off in prod or a quiet invocation throws.
**Edges:** step_of → workflow (3, "EMF rides the logs you just structured") · composes_with logger ("metrics travel through the log stream")

### SW-PT-0004 · "secrets fetched every invocation" · `lambda-powertools-parameters` · tool
**Summary:** Cached reads from SSM, Secrets Manager, AppConfig, and DynamoDB — stop hammering the parameter APIs on every cold path.
**Guidance (paid):** Use when SSM throttling or Secrets Manager cost shows up in your bill or your p99. Wire: Python `parameters.get_parameter(..., max_age=300)`; TypeScript `getParameter`/`getSecret` from `@aws-lambda-powertools/parameters`; Java `ParamManager`; .NET `ParametersManager`. Default cache is 5s — tune `max_age` per value volatility. Gotchas: caching is per-container, so a fleet cold-starting still stampedes (pre-warm or raise SSM throughput); `get_secret` returns the raw string — JSON secrets need `transform="json"`; IAM needs `ssm:GetParameter` AND `kms:Decrypt` for SecureString or you get AccessDenied that looks like a missing parameter.
**Edges:** required_by feature flags ("flags ride the AppConfig provider")

---

## Workflow — $0.50

### SW-PT-0005 · "lambda is a black box" · `lambda-observability-workflow` · workflow
**Summary:** The three-step instrumentation path for any Lambda: structured logs, then traces, then inline metrics — wired in the order that compounds.
**Guidance (paid):** Run the steps in order; each rides the previous. Logger first (everything else attaches to structured entries), tracer second (correlation ids join logs to traces), metrics third (EMF serializes into the already-structured stream). All three are one decorator/middleware/annotation each in all four runtimes — a full observability retrofit is under an hour per function. Skip nothing: metrics without the logger loses EMF context; traces without correlation ids strand your log search.
**Edges:** steps 1–3 = SW-PT-0001/0002/0003 (above) · pairs_with parameters ("config reads show up in traces once tracer wraps the SDK")

---

## Singles — $0.10

### SW-PT-0006 · "retries double charge customers" · `lambda-powertools-idempotency` · tool
**Summary:** Idempotent handlers backed by DynamoDB — a retried event returns the first result instead of executing twice.
**Guidance (paid):** Mandatory for anything that moves money or writes downstream — Lambda retries, SQS redrives, and at-least-once delivery WILL re-run your handler. Wire: `@idempotent` (Python) / `makeIdempotent` (TS) / `@Idempotent` (Java) / `[Idempotency]` (.NET) with a DynamoDB persistence table and an event key path (`event_key_jmespath="body.orderId"`). Gotchas: the key must be the BUSINESS key, not the Lambda request id (that changes per retry — useless); set `expires_after_seconds` to your real dedup window; in-flight executions lock, so long handlers need `raise_on_no_idempotency_key` thinking. Available in all four runtimes.
**Edges:** composes_with batch ("partial-failure replays are exactly what idempotency absorbs")

### SW-PT-0007 · "one bad record kills batch" · `lambda-powertools-batch` · tool
**Summary:** Partial-failure handling for SQS, Kinesis, and DynamoDB Streams — process what succeeds, report only what failed.
**Guidance (paid):** Without this, one poison record fails the whole batch and everything retries — including the records that succeeded. Wire: `BatchProcessor` + `process_partial_response` (Python; equivalents in TS/Java/.NET) and set `ReportBatchItemFailures` on the event source mapping — BOTH sides, or failures are silently total. Gotcha: FIFO queues stop at first failure by design (ordering); use `SqsFifoPartialProcessor`. All four runtimes.
**Edges:** composes_with idempotency (see 0006)

### SW-PT-0008 · "api routing boilerplate everywhere" · `lambda-powertools-event-handler` · tool
**Summary:** Decorator-style routing for API Gateway, ALB, Function URLs, AppSync, and Bedrock Agents inside one handler.
**Guidance (paid):** Use when your handler is a growing if/elif over `event["path"]`. Wire: Python `APIGatewayRestResolver()` + `@app.get("/orders/<id>")`; .NET has the equivalent; (Java/TS: not offered — route with framework middleware instead, note before you commit). Bonus most agents miss: `BedrockAgentResolver` turns the same style into Bedrock Agent action groups — and generates the OpenAPI schema the agent console demands. Gotcha: resolver validation errors return 422s your API Gateway model validation never sees; pick one validation layer.
**Edges:** pairs_with parser ("typed request bodies inside routes")

### SW-PT-0009 · "event shapes keep surprising me" · `lambda-powertools-parser` · tool
**Summary:** Pydantic/Zod-backed parsing of Lambda event envelopes into typed models — fail loud at the boundary, not deep in business logic.
**Guidance (paid):** Use when you've been burned by `event["Records"][0]["body"]` being a string of JSON of a string. Wire: Python `@event_parser(model=Order, envelope=envelopes.SqsEnvelope)` — the envelope unwraps the transport, the model types the payload; TypeScript parser uses Zod schemas + built-in envelopes. Java/.NET: not offered; use validation (0010) there. Gotcha: envelopes are the whole point — without one you're typing AWS's wrapper, not your data.
**Edges:** alternative_to validation ("typed models vs plain JSON Schema — pick one boundary") · pairs_with event handler

### SW-PT-0010 · "reject malformed events early" · `lambda-powertools-validation` · tool
**Summary:** JSON Schema validation for inbound events and responses — the contract check without model classes.
**Guidance (paid):** The lighter alternative to parser when you want a contract, not types. Wire: `@validator(inbound_schema=SCHEMA)` (Python), similar in TS/Java/.NET (broadest availability of the two approaches). Use JMESPath envelopes to validate the payload inside the transport wrapper. Gotcha: schema failures raise before your code runs — pair with the event handler's exception mapping or your API returns bare 500s for what are really 400s.
**Edges:** alternative_to parser (see 0009)

### SW-PT-0011 · "toggle features without redeploying" · `lambda-powertools-feature-flags` · tool
**Summary:** Rule-based feature flags evaluated from AppConfig — per-tenant/per-context rollouts with no deploy.
**Guidance (paid):** Python only — commit accordingly. Wire: `FeatureFlags(store=AppConfigStore(...))` + `evaluate(name="beta_tool", context={"tenant": t}, default=False)`. Rules match on context (tenant id, region, percentage rollout). Gotchas: it rides the Parameters AppConfig provider, so cache age applies to flag freshness (default 5s is usually right); a malformed rules JSON evaluates to your DEFAULT, silently — alarm on AppConfig deployment errors.
**Edges:** requires parameters ("flags ride the AppConfig provider")

### SW-PT-0012 · "secrets leak into logs" · `lambda-powertools-data-masking` · tool
**Summary:** Erase or encrypt sensitive fields in payloads before they hit logs or downstream — with KMS-backed reversibility when you need it.
**Guidance (paid):** Python only. Use before the compliance audit, not after. Wire: `DataMasking()` + `erase(payload, fields=["card.number"])` for one-way, or KMS-backed `encrypt`/`decrypt` for reversible masking. Fields are JMESPath — nested and wildcard paths work. Gotcha: masking at the log call is too late if an exception serializes the raw payload first — mask at ingest, log the masked object only.
**Edges:** composes_with logger ("mask before you log")

### SW-PT-0013 · "dataset exceeds lambda memory" · `lambda-powertools-streaming` · tool
**Summary:** Stream and transform S3 objects bigger than your function's RAM — gzip/CSV/zip transforms on the fly.
**Guidance (paid):** Python only. Use when the naive `get_object().read()` OOMs your function. Wire: `S3Object(bucket=..., key=...)` with chained transforms (`GzipTransform`, `CsvTransform`) — iterate rows, never hold the file. Gotcha: it's seekable but seeking backwards re-fetches ranges — design forward-only; and Lambda's 10GB ephemeral disk is NOT involved, this is pure memory streaming.
**Edges:** (none first pass)

---

## Deliberately NOT in batch 1
Middleware factory, typing, event source data classes, JMESPath functions
(low agent pain / subsumed by parser guidance), Kafka consumer (batch 2
candidate with the TS/Java coverage), circuit breaker (alpha — revisit when
stable). Digestibility over completeness.

## Pricing summary
4 multis × $0.25 · 1 workflow × $0.50 · 8 singles × $0.10 = 13 items, full
shelf value $2.30 per complete walk. All ≤ $1.00 cap. (Sepolia test dollars
until mainnet promotion.)
