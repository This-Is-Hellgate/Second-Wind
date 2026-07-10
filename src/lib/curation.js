/**
 * Curation — the product substrate. The tool list is small and opinionated:
 * D1 holds the curated index (items: stub + guidance + invocation) and the
 * relationship graph (edges: how things fit together, with the one-line WHY).
 * That judgment is the deliverable; raw files (R2) are a supporting store for
 * genuine artifacts, never the front door.
 *
 * What a buyer receives is a RESOLVED CAPABILITY: guidance + the item's graph
 * neighborhood, wired — not a blob. Bulk raw access deliberately does not
 * exist; the free surface carries stubs only.
 */

const STUB_COLS = "sku, slug, name, kind, service, price_usd, summary, updated_at, invoke_kind, input_schema, input_example, mime_type, content_hash";
const FULL_COLS = `${STUB_COLS}, guidance, invoke_key, source_repo, source_path, source_url, license_spdx, provenance, version`;

/** Live stubs — the free listing and every generated surface come from this. */
export async function liveStubs(env) {
  if (!env.SW_DB) return [];
  try {
    const { results } = await env.SW_DB.prepare(
      `SELECT ${STUB_COLS} FROM items WHERE status = 'live' ORDER BY kind, service, sku`
    ).all();
    return results || [];
  } catch {
    return []; // curation tables absent -> empty tool list, never an error
  }
}

export async function countLive(env) {
  return (await liveStubs(env)).length;
}

/** One live item, by SKU or slug — both resolve, advertised URLs never break. */
export async function findItem(env, key) {
  if (!env.SW_DB) return null;
  try {
    return await env.SW_DB.prepare(
      `SELECT ${FULL_COLS} FROM items WHERE status = 'live' AND (sku = ?1 OR slug = ?1)`
    )
      .bind(key)
      .first();
  } catch {
    return null;
  }
}

/**
 * The graph neighborhood for one item — the moat, shipped only inside paid
 * resolved responses. Outbound edges plus inbound step_of membership.
 */
export async function neighborhood(env, sku) {
  if (!env.SW_DB) return [];
  try {
    const { results } = await env.SW_DB.prepare(
      `SELECT e.relation, e.position, e.note, e.from_sku, e.to_sku,
              i.sku, i.slug, i.name, i.kind, i.price_usd, i.summary
       FROM edges e
       JOIN items i ON i.sku = (CASE WHEN e.from_sku = ?1 THEN e.to_sku ELSE e.from_sku END)
       WHERE (e.from_sku = ?1 OR e.to_sku = ?1) AND i.status = 'live'
       ORDER BY e.relation, e.position, i.sku`
    )
      .bind(sku)
      .all();
    return results || [];
  } catch {
    return [];
  }
}

/**
 * Build the paid deliverable: the resolved capability. Guidance (the voice) +
 * composition (the wired neighborhood) + invocation instructions.
 */
export async function resolveCapability(env, item, origin) {
  const edges = await neighborhood(env, item.sku);

  const related = { steps: [], composes_with: [], requires: [], alternatives: [], pairs_with: [], part_of: [] };
  for (const e of edges) {
    const other = {
      sku: e.sku,
      name: e.name,
      kind: e.kind,
      price_usd: e.price_usd,
      summary: e.summary,
      why: e.note || "",
      url: `${origin}/api/x402/${e.slug || e.sku}`,
    };
    const outbound = e.from_sku === item.sku;
    if (e.relation === "step_of") {
      if (outbound) related.part_of.push(other);
      else related.steps.push({ ...other, position: e.position ?? null });
    } else if (e.relation === "composes_with" || e.relation === "pairs_with") {
      (e.relation === "composes_with" ? related.composes_with : related.pairs_with).push(other);
    } else if (e.relation === "requires" && outbound) {
      related.requires.push(other);
    } else if (e.relation === "alternative_to") {
      related.alternatives.push(other);
    }
  }
  related.steps.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const invoke =
    item.invoke_kind === "bedrock"
      ? {
          how: "POST",
          url: `${origin}/api/x402/${item.slug || item.sku}`,
          body_schema: parseMaybeJson(item.input_schema) || { properties: { input: { type: "string" } }, required: ["input"] },
          body_example: parseMaybeJson(item.input_example) || { input: "describe the task" },
          note: "Paid execution: the agent runs against AWS behind this endpoint; you are charged only when the run succeeds.",
        }
      : item.invoke_kind === "r2"
        ? {
            how: "GET",
            url: `${origin}/api/x402/${item.slug || item.sku}/artifact`,
            mime_type: item.mime_type || "application/octet-stream",
            note: "Deliberate artifact fetch — secondary to this resolved capability, same purchase price.",
          }
        : null;

  return {
    sku: item.sku,
    name: item.name,
    kind: item.kind,
    service: item.service,
    summary: item.summary,
    guidance: item.guidance || "",
    composition: related,
    ...(invoke ? { invoke } : {}),
    source: {
      repo: item.source_repo || "",
      path: item.source_path || "",
      url: item.source_url || "",
      license_spdx: item.license_spdx || "",
      provenance: item.provenance || "",
    },
    content_hash: item.content_hash || "",
    version: item.version ?? 1,
  };
}

/** Fetch a genuine artifact from R2 — reached only through a resolved response. */
export async function getArtifact(env, item) {
  if (!env.SW_R2 || !item.invoke_key) return null;
  const object = await env.SW_R2.get(item.invoke_key);
  return object || null;
}

export function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
