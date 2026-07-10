import { SignJWT, importJWK, importPKCS8 } from "jose";

const CDP_HOST = "api.cdp.coinbase.com";

function normalizeSecret(raw) {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function isPemSecret(secret) {
  return secret.trimStart().startsWith("-----BEGIN");
}

function decodeBase64ToBytes(base64Secret) {
  const binary = atob(base64Secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Ed25519 CDP keys: base64(32-byte seed || 32-byte public key) → 64 bytes. */
async function importEd25519SigningKey(base64Secret) {
  const decoded = decodeBase64ToBytes(base64Secret);
  if (decoded.length !== 64) {
    throw new Error(`invalid_ed25519_key_length:${decoded.length}`);
  }

  const seed = decoded.subarray(0, 32);
  const publicKey = decoded.subarray(32, 64);
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: b64urlBytes(seed),
    x: b64urlBytes(publicKey),
  };

  return importJWK(jwk, "EdDSA");
}

function b64urlBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** EC CDP keys: PKCS#8 PEM only (Workers-safe — no node:crypto SEC1 conversion). */
async function importEcSigningKey(pemSecret) {
  if (pemSecret.includes("BEGIN EC PRIVATE KEY")) {
    throw new Error("ec_sec1_pem_requires_pkcs8_conversion");
  }
  return importPKCS8(pemSecret, "ES256");
}

async function loadCdpSigningKey(keySecret) {
  const secret = normalizeSecret(keySecret);
  if (isPemSecret(secret)) {
    return { key: await importEcSigningKey(secret), alg: "ES256" };
  }
  return { key: await importEd25519SigningKey(secret), alg: "EdDSA" };
}

/** JWT `uri` claim must include the full CDP route (with `/platform`). */
export function cdpJwtRequestPath(httpPath) {
  const path = httpPath.startsWith("/") ? httpPath : `/${httpPath}`;
  return path.startsWith("/platform/") ? path : `/platform${path}`;
}

/** CDP Secret API key JWT — valid ~2 minutes per request. */
export async function buildCdpAuthHeaders(env, method, requestPath) {
  const keyName = env.CDP_API_KEY_NAME || env.CDP_API_KEY_ID;
  const keySecret = env.CDP_API_KEY_SECRET;

  if (keyName && keySecret) {
    const uri = `${method.toUpperCase()} ${CDP_HOST}${cdpJwtRequestPath(requestPath)}`;
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const { key, alg } = await loadCdpSigningKey(keySecret);

    const jwt = await new SignJWT({ sub: keyName, uri, aud: ["cdp_service"] })
      .setProtectedHeader({ alg, kid: keyName, typ: "JWT", nonce })
      .setIssuer("cdp")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(key);

    return { Authorization: `Bearer ${jwt}` };
  }

  if (env.CDP_API_KEY) {
    return { Authorization: `Bearer ${env.CDP_API_KEY}` };
  }

  return {};
}

/**
 * Build the CDP facilitator verify/settle routes for a configured base URL,
 * tolerating however much of the canonical path the operator already baked in.
 *
 * The canonical CDP route is `<origin>/platform/v2/x402/{verify,settle}`. Operators
 * configure FACILITATOR_URL_BASE inconsistently — some give the origin, some
 * `<origin>/platform`, and some the fully-qualified `<origin>/platform/v2/x402`.
 * The old builder only special-cased a trailing `/platform`; a fully-qualified base
 * produced `<base>/platform/v2/x402/verify` → a DUPLICATED path when concatenated.
 *
 * We normalize by stripping any trailing `/platform`, `/platform/v2`, or
 * `/platform/v2/x402` from the base, then always append the full canonical suffix.
 * Returns `{ base, verifyPath, settlePath }`:
 *   - `base` is the normalized origin-ish prefix; callers MUST concatenate against
 *     THIS base, not the raw input, so the URL is correct regardless of input shape.
 *   - `verifyPath`/`settlePath` always start with `/platform/...` so the JWT `uri`
 *     claim (which requires the full CDP route) stays valid.
 */
export function facilitatorPaths(baseUrl) {
  const base = String(baseUrl)
    .replace(/\/$/, "")
    .replace(/\/platform(\/v2(\/x402)?)?$/, "");
  return {
    base,
    verifyPath: "/platform/v2/x402/verify",
    settlePath: "/platform/v2/x402/settle",
  };
}
