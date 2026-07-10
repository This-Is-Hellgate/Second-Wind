/**
 * Network configuration — CONFIG, not constants. The first proof runs Base
 * Sepolia (eip155:84532) with valueless test USDC via the public x402.org
 * facilitator; promotion to Base mainnet (eip155:8453) is an env swap:
 * X402_NETWORK, X402_FACILITATOR_URL, X402_PAYTO_PUBLIC.
 */

export const NETWORKS = {
  "eip155:8453": {
    id: "eip155:8453",
    label: "Base mainnet",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913",
    eip712: { name: "USD Coin", version: "2" },
  },
  "eip155:84532": {
    id: "eip155:84532",
    label: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    eip712: { name: "USDC", version: "2" },
  },
};

export function activeNetwork(env) {
  const id = env.X402_NETWORK || "eip155:84532";
  return NETWORKS[id] || { id, label: id, usdc: "", eip712: {} };
}

export function activePayTo(env) {
  return env.X402_PAYTO || env.X402_PAYTO_PUBLIC || "";
}

export function activeFacilitatorUrl(env) {
  return env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
}

export function isCdpFacilitator(url) {
  return /cdp\.coinbase\.com/.test(String(url));
}
