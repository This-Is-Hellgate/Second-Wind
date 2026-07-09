# Second Wind

**Agents stall. Second Wind gets them moving.**

Second Wind is an AWS operational-knowledge catalog for autonomous agents that carry wallets — diagnostics, recipes, CDK construct routing, templates, decisions, auth-flows, and cost models across 39 AWS services and language integrations, gated via the [x402 payment protocol](https://x402.org) with USDC settlement on Base.

**Status: pre-launch.** The serving surface goes live at **[secondwindai.com](https://secondwindai.com)**.

## What it sells

The map, not the territory. Every item in the catalog points at open-source AWS tooling an agent could find for free — eventually. Second Wind sells knowing *which* of ten thousand repos holds the fix, *what* the fix is distilled to its operational essence, and *why* this construct over that one — priced $0.03–$0.25 USDC, session-less, at the exact moment a stuck agent needs it.

An agent mid-failure doesn't browse. It describes its error, pays a nickel, and gets a numbered fix.

## How it works

1. `GET /api/proof` — free liveness check before spending
2. `GET /api/catalog` — free browse; filter by service or item type
3. `GET /api/x402/{sku}` — returns `402 Payment Required` with x402 v2 `accepts[]`; sign USDC on Base (ExactEvmScheme) and retry with `PAYMENT-SIGNATURE`
4. Delivery: distilled knowledge + source pointer + SPDX license + content hash

Full machine-readable contract: [`openapi.json`](./openapi.json) · Agent card: [`.well-known/agent-card.json`](./.well-known/agent-card.json) · Agent doc: [`llms.txt`](./llms.txt)

## Architecture

Cloudflare-first: Pages Functions serve the doors; the catalog is a dedicated D1 database (`second-wind-catalog`) that is the single source of truth — discovery documents and catalog exports are generated from it, never hand-maintained. Second Wind data stays on Second Wind data.

## Registry

Listed in the **Amazon Bedrock AgentCore Agent Registry** (registry `jaMy0SuApKYYJDTa`, record `vA5tdL2q4L8O`; record predates the Second Wind rename — update pending).

## Provenance & licensing

Catalog items derive from Apache-2.0 and MIT-0 licensed AWS ecosystem projects. Second Wind describes and links; it does not redistribute. Every item carries its source repo, SPDX identifier, and a content hash over exactly what a buyer receives.

---

A **Second** family entity. Second Wind operates independently with its own domain, catalog database, and settlement wallet.
