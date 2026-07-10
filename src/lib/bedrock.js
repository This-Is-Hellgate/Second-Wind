/**
 * Bedrock Agents origin — the execution layer behind the paywall. The worker
 * verifies payment (middleware), invokes the agent with a SigV4-signed fetch
 * (aws4fetch — Workers-native), and only a successful response settles.
 *
 * InvokeAgent responds with an AWS event stream; completion text arrives as
 * "chunk" events carrying { bytes: base64 }. The minimal decoder below walks
 * the frames (CRCs skipped — transport integrity is TLS's job here) and
 * concatenates the chunks.
 */
import { AwsClient } from "aws4fetch";

export function bedrockConfigured(env) {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION);
}

/**
 * Invoke a Bedrock agent. `key` from the manifest stub: "agentId/agentAliasId".
 * Returns { ok: true, completion } or { ok: false, status, error }.
 */
export async function invokeAgent(env, key, { input, sessionId }) {
  if (!bedrockConfigured(env)) {
    return { ok: false, status: 503, error: "bedrock_not_configured" };
  }
  const [agentId, agentAliasId] = String(key).split("/");
  if (!agentId || !agentAliasId) {
    return { ok: false, status: 500, error: "invalid_agent_key" };
  }

  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION,
    service: "bedrock",
  });

  const session = sessionId || crypto.randomUUID();
  const url = `https://bedrock-agent-runtime.${env.AWS_REGION}.amazonaws.com/agents/${agentId}/agentAliases/${agentAliasId}/sessions/${session}/text`;

  let res;
  try {
    res = await aws.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputText: String(input || "") }),
    });
  } catch (err) {
    return { ok: false, status: 502, error: `bedrock_unreachable:${String(err?.message || err).slice(0, 120)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: 502, error: `bedrock_error:${res.status}:${detail.slice(0, 200)}` };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  const completion = decodeEventStreamCompletion(buf);
  return { ok: true, completion, sessionId: session };
}

/** Walk AWS event-stream frames; concatenate decoded "chunk" event bytes. */
export function decodeEventStreamCompletion(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  let completion = "";

  while (offset + 16 <= buf.byteLength) {
    const totalLength = view.getUint32(offset);
    const headersLength = view.getUint32(offset + 4);
    if (totalLength < 16 || offset + totalLength > buf.byteLength) break;

    const headersStart = offset + 12; // prelude (8) + prelude CRC (4)
    const payloadStart = headersStart + headersLength;
    const payloadEnd = offset + totalLength - 4; // trailing message CRC

    // Parse headers to find :event-type / :exception-type.
    let h = headersStart;
    let eventType = "";
    while (h < payloadStart) {
      const nameLen = buf[h];
      const name = decoder.decode(buf.subarray(h + 1, h + 1 + nameLen));
      h += 1 + nameLen;
      const valueType = buf[h];
      h += 1;
      if (valueType === 7) {
        const valueLen = view.getUint16(h);
        const value = decoder.decode(buf.subarray(h + 2, h + 2 + valueLen));
        h += 2 + valueLen;
        if (name === ":event-type" || name === ":exception-type") eventType = value;
      } else if (valueType === 0 || valueType === 1) {
        // boolean true/false — no value bytes
      } else if (valueType === 2) {
        h += 1;
      } else if (valueType === 3) {
        h += 2;
      } else if (valueType === 4) {
        h += 4;
      } else if (valueType === 5 || valueType === 8) {
        h += 8;
      } else if (valueType === 6) {
        const valueLen = view.getUint16(h);
        h += 2 + valueLen;
      } else if (valueType === 9) {
        h += 16;
      } else {
        break; // unknown header type — stop parsing this frame's headers
      }
    }

    if (eventType === "chunk" && payloadEnd > payloadStart) {
      try {
        const payload = JSON.parse(decoder.decode(buf.subarray(payloadStart, payloadEnd)));
        if (payload.bytes) {
          completion += decoder.decode(Uint8Array.from(atob(payload.bytes), (ch) => ch.charCodeAt(0)));
        }
      } catch {
        /* non-JSON chunk — skip */
      }
    }

    offset += totalLength;
  }

  return completion;
}
