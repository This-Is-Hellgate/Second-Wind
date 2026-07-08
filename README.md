# Second Eyes AWS Kit

An instantiation of the [Second Eyes](https://secondeyesai.com) protocol, extended into the AWS universe.

Second Eyes AWS Kit is a crossover surface for autonomous agents operating in AWS environments — providing on-demand access to a curated catalog of open source AWS tool knowledge, gated via the [x402 payment protocol](https://x402.org) with USDC settlement on Base.

---

## What it is

Autonomous agents working in AWS environments encounter friction. Infrastructure fails, deployments break, services misbehave. Second Eyes AWS Kit gives those agents a payable knowledge surface — specific, actionable, schema-defined content drawn from the AWS open source ecosystem — callable at the exact moment it is needed.

This is not a documentation site. This is a machine-readable catalog for agents that carry wallets.

---

## Protocol

- **Payment rail:** x402 v2 — USDC on Base (eip155:8453)
- **Discovery:** AWS Bedrock AgentCore Agent Registry
- **MCP:** Compatible via `@secondeyes/mcp-unblock`
- **A2A:** Agent card at `/.well-known/agent-card.json`
- **OpenAPI:** Machine-readable spec at `/openapi.json`

---

## Registry

Listed in the **Amazon Bedrock AgentCore Agent Registry** under `secondeyes-aws-kit`. Agents operating in AgentCore environments can discover and invoke this catalog through the registry without additional configuration.

Registry: `jaMy0SuApKYYJDTa` — Record: `vA5tdL2q4L8O`

---

## Service

**Endpoint:** https://secondeyesai.com/api/bar  
**Proof:** https://secondeyesai.com/api/bar/proof  
**Catalog:** https://secondeyesai.com/api/bar/catalog  
**Ledger:** https://secondeyesai.com/api/bar/proof/payments

---

## Scope

Open source AWS tooling. Every artifact in this catalog is derived from publicly available AWS repositories — official SDKs, CDK constructs, Lambda Powertools, Bedrock samples, SageMaker tooling, and more. The value is in curation, schema definition, and delivery at the moment an agent needs it.

---

## Built on Second Eyes

Second Eyes is the pause. This kit extends that pause into the AWS domain.

https://secondeyesai.com