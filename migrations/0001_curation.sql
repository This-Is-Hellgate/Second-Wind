-- Second Wind curation graph — the moat. NOT applied to production without
-- Mike's explicit approval; local/test application is fine.
--
-- The product is the resolved, invocable capability plus the judgment around
-- it: items carry the stub (few words), the guidance (the voice), and how to
-- invoke; edges carry the OPINION about how items fit together. A raw file
-- dump has no equivalent of this graph.

CREATE TABLE IF NOT EXISTS items (
  sku            TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('tool','workflow','guide','artifact','agent')),
  service        TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL,                 -- stub: what/when/how in a few words (free)
  guidance       TEXT NOT NULL DEFAULT '',      -- the voice: when to reach for it, wiring, gotchas (paid)
  price_usd      REAL NOT NULL CHECK (price_usd > 0 AND price_usd <= 1.00),
  invoke_kind    TEXT NOT NULL DEFAULT 'resolve' CHECK (invoke_kind IN ('resolve','bedrock','r2')),
  invoke_key     TEXT NOT NULL DEFAULT '',      -- bedrock "agentId/aliasId" or R2 object key
  input_schema   TEXT NOT NULL DEFAULT '',      -- JSON Schema (execution kinds)
  input_example  TEXT NOT NULL DEFAULT '',      -- JSON example body (execution kinds)
  mime_type      TEXT NOT NULL DEFAULT '',      -- artifact delivery type (r2 kind)
  source_repo    TEXT NOT NULL DEFAULT '',
  source_path    TEXT NOT NULL DEFAULT '',
  source_url     TEXT NOT NULL DEFAULT '',
  license_spdx   TEXT NOT NULL DEFAULT '',
  provenance     TEXT NOT NULL DEFAULT '',
  content_hash   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','retired')),
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The relationship graph: first-class curation, not a README.
CREATE TABLE IF NOT EXISTS edges (
  from_sku   TEXT NOT NULL REFERENCES items(sku),
  to_sku     TEXT NOT NULL REFERENCES items(sku),
  relation   TEXT NOT NULL CHECK (relation IN ('composes_with','requires','step_of','alternative_to','pairs_with','supersedes')),
  position   INTEGER,                            -- ordering for step_of (workflow steps)
  note       TEXT NOT NULL DEFAULT '',           -- one line of WHY — the opinion
  PRIMARY KEY (from_sku, to_sku, relation)
);

CREATE INDEX IF NOT EXISTS idx_items_live ON items(status, kind, service);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_sku);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_sku);
