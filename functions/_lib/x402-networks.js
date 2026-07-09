/**
 * Second Wind payment rails — Base mainnet ONLY, by design. The multi-rail
 * machinery (Polygon activation gates, Solana descriptors) stays in Second
 * Eyes where its scar tissue was earned; Second Wind adds a rail the day a
 * settlement proof exists for it, not before. Interface preserved verbatim
 * from the proven Second Eyes implementation: resolveActiveNetworks,
 * buildAcceptEntry, selectAcceptForPayload, payloadNetwork.
 */

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913";

export const BASE_NETWORK = {
  key: "base",
  id: "eip155:8453",
  namespace: "eip155",
  kind: "evm",
  asset: USDC_BASE,
  extra: { name: "USD Coin", version: "2" },
  canonical: true,
  status: "active",
  settled_by: "cdp",
};

function canonicalBasePayTo(env) {
  return env?.X402_PAYTO || env?.X402_PAYTO_PUBLIC || null;
}

/** Active rails for this env: Base or nothing. */
export function resolveActiveNetworks(env) {
  const payTo = canonicalBasePayTo(env);
  if (!payTo) return [];
  return [{ network: BASE_NETWORK, payTo }];
}

/**
 * One accepts[] entry. EVM rails carry the EIP-712 domain in `extra`. Kept
 * minimal — the CDP Bazaar indexer rejects unexpected fields.
 */
export function buildAcceptEntry({ network, payTo }, amount) {
  const accept = {
    scheme: "exact",
    network: network.id,
    asset: network.asset,
    amount,
    payTo,
    maxTimeoutSeconds: 600,
  };
  if (network.extra) accept.extra = { ...network.extra };
  return accept;
}

/** CAIP-2 ids actually offered in accepts[] for this env. */
export function acceptedNetworkIds(env) {
  return resolveActiveNetworks(env).map((a) => a.network.id);
}

/** Config sanity warnings, surfaced on /api/proof. */
export function x402ConfigWarnings(env) {
  if (!env) return [];
  const warnings = [];
  if (!canonicalBasePayTo(env)) {
    warnings.push({ code: "no_payto", message: "X402_PAYTO_PUBLIC is not set — every paid door will return payment_rail_not_configured." });
  }
  if (!env.X402_FACILITATOR_URL) {
    warnings.push({ code: "no_facilitator", message: "X402_FACILITATOR_URL is not set — payments cannot verify or settle." });
  }
  return warnings;
}

/** The rail CAIP-2 a v2 buyer signed for, or null if the payload names none. */
export function payloadNetwork(paymentPayload) {
  return (
    paymentPayload?.accepted?.network ||
    paymentPayload?.network ||
    paymentPayload?.accepted?.[0]?.network ||
    null
  );
}

/**
 * Find the accept entry matching the rail a buyer actually signed for.
 * Buyer named a network present in accepts[] -> that accept. Named one NOT
 * in accepts[] -> null (caller MUST reject — verifying a foreign-rail
 * signature against the Base requirement fails at the facilitator with no
 * receipt). Named none -> accepts[0].
 */
export function selectAcceptForPayload(accepts, paymentPayload) {
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const chosen = payloadNetwork(paymentPayload);
  if (chosen) {
    return accepts.find((a) => a.network === chosen) || null;
  }
  return accepts[0];
}
