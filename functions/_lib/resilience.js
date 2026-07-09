/** Fail small: rate limits, load shedding, timeouts, circuit breakers. Stateless per request. */

const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const CONNECT_BUDGET_MS = 1000;

/** Per-isolate counters — shed load before D1/payment cascades. */
const state = globalThis.__secondEyeResilience ??= {
  inFlight: 0,
  maxInFlight: 60,
  buckets: new Map(),
  circuits: new Map(),
};

/** Route tiers — requests per 60s window per client key. */
const LIMITS = {
  proof: { windowMs: 60_000, max: 6 },
  enter: { windowMs: 60_000, max: 12 },
  paid: { windowMs: 60_000, max: 30 },
  write: { windowMs: 60_000, max: 20 },
  read: { windowMs: 60_000, max: 180 },
};

const INFLIGHT_PATHS = new Set([
  "/api/bar/proof",
  "/api/bar/enter",
  "/api/access/purchase",
  "/api/a4a",
]);

export function clientKey(request) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  const agent =
    request.headers.get("X-Agent-Id") ||
    request.headers.get("X-Second-Eye-Agent-Id") ||
    "";
  const wallet =
    request.headers.get("PAYMENT-SIGNATURE")?.slice(0, 16) ||
    request.headers.get("X-PAYMENT-SIGNATURE")?.slice(0, 16) ||
    "";
  return [ip, agent, wallet].filter(Boolean).join(":");
}

function routeTier(pathname, method) {
  if (pathname === "/api/bar/proof") return "proof";
  if (pathname === "/api/bar/enter") return "enter";
  if (pathname.startsWith("/api/access/purchase") || pathname === "/api/a4a") return "paid";
  if (method === "POST") return "write";
  if (pathname.startsWith("/api/bar/taps/") || pathname.startsWith("/api/bar/tools/")) {
    return "paid";
  }
  return "read";
}

function slidingWindow(key, { windowMs, max }) {
  const now = Date.now();
  let bucket = state.buckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    state.buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const retryAfter = Math.ceil((windowMs - (now - bucket.start)) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1), limit: max, windowMs };
  }
  return { ok: true };
}

export function enforceRateLimit(request, pathname) {
  const tier = routeTier(pathname, request.method);
  const limit = LIMITS[tier] || LIMITS.read;
  const key = `rl:${tier}:${clientKey(request)}:${pathname.split("/").slice(0, 4).join("/")}`;
  return slidingWindow(key, limit);
}

export function loadShedCheck(request, pathname) {
  if (!INFLIGHT_PATHS.has(pathname)) return { ok: true };

  if (state.inFlight >= state.maxInFlight) {
    return {
      ok: false,
      status: 503,
      code: "load_shed",
      message: "Bar is at safe concurrency. Retry shortly.",
      retryAfter: 5,
    };
  }
  return { ok: true };
}

export function trackInFlight(run) {
  state.inFlight += 1;
  return Promise.resolve(run()).finally(() => {
    state.inFlight = Math.max(0, state.inFlight - 1);
  });
}

export function jsonError(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

export function rateLimitResponse(result) {
  const status = result.status || 429;
  return jsonError(
    {
      error: result.code || "rate_limited",
      message: result.message || "Too many requests. Shed load early — retry with backoff.",
      retry_after_seconds: result.retryAfter,
      bar: {
        catalog: "/api/bar/catalog",
        free_tool: "/api/bar/tools/cursor-mcp-wiring",
        free_tap: "/api/bar/taps/cursor-mcp-minimal-config",
      },
    },
    status,
    { "Retry-After": String(result.retryAfter || 60) }
  );
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`fetch_timeout:${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Circuit breaker for external dependencies (per-isolate). */
export function getCircuit(name, { failureThreshold = 5, openMs = 30_000, halfOpenMs = 10_000 } = {}) {
  let circuit = state.circuits.get(name);
  if (!circuit) {
    circuit = {
      name,
      failureThreshold,
      openMs,
      halfOpenMs,
      failures: 0,
      state: "closed",
      openedAt: 0,
      lastFailure: 0,
    };
    state.circuits.set(name, circuit);
  }
  return circuit;
}

export function circuitAllows(circuit) {
  const now = Date.now();
  if (circuit.state === "closed") return { ok: true };
  if (circuit.state === "open") {
    if (now - circuit.openedAt >= circuit.openMs) {
      circuit.state = "half-open";
      return { ok: true, halfOpen: true };
    }
    const retryAfter = Math.ceil((circuit.openMs - (now - circuit.openedAt)) / 1000);
    return {
      ok: false,
      retryAfter: Math.max(retryAfter, 1),
      code: "circuit_open",
      dependency: circuit.name,
    };
  }
  return { ok: true, halfOpen: true };
}

export function circuitSuccess(circuit) {
  circuit.failures = 0;
  circuit.state = "closed";
}

export function circuitFailure(circuit) {
  circuit.failures += 1;
  circuit.lastFailure = Date.now();
  if (circuit.state === "half-open" || circuit.failures >= circuit.failureThreshold) {
    circuit.state = "open";
    circuit.openedAt = Date.now();
    circuit.failures = 0;
  }
}

export async function withCircuit(circuit, fn) {
  const gate = circuitAllows(circuit);
  if (!gate.ok) return { ok: false, circuit: gate };

  try {
    const result = await fn();
    circuitSuccess(circuit);
    return { ok: true, result };
  } catch (err) {
    circuitFailure(circuit);
    return { ok: false, error: String(err.message || err), circuit: gate };
  }
}

export function paymentDegradedBody(origin, extra = {}) {
  const base = origin?.replace(/\/$/, "") || "";
  return {
    error: "payment_rail_degraded",
    message: "Billing is temporarily unavailable. Serving continues via free samples and catalog.",
    retry_with: "exponential_backoff_with_jitter",
    do_not_serve_degraded_paid_content: true,
    free_samples: {
      tool: `${base}/api/bar/tools/cursor-mcp-wiring`,
      tap: `${base}/api/bar/taps/cursor-mcp-minimal-config`,
    },
    catalog: `${base}/api/bar/catalog`,
    proof: `${base}/api/bar/proof`,
    ...extra,
  };
}

export const CACHE = {
  catalog: "public, max-age=300, stale-while-revalidate=600",
  staticPack: "public, max-age=3600, stale-while-revalidate=86400",
  stats: "public, max-age=15, stale-while-revalidate=30",
  noStore: "no-store",
  payment402: "no-store",
};

export { DEFAULT_FETCH_TIMEOUT_MS, CONNECT_BUDGET_MS };
