/** Fail small: fetch timeouts and circuit breakers. Stateless per request. */

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/** Per-isolate circuit state. */
const state = (globalThis.__secondWindResilience ??= {
  circuits: new Map(),
});

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

export { DEFAULT_FETCH_TIMEOUT_MS };
