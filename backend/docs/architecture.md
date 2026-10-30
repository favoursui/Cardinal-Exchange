# Cardinal architecture — initial decision record

Status: development foundation; no trading or production deployment.

## Product and stack

Cardinal combines its own AMM pools with exchange-by-exchange quotes from verified external venues. The interface lists Cardinal, QWAP and future supported venues individually, highlights the best comparable quote, and preserves the user's venue selection through execution. Split routing is a later, explicitly labeled option.

Use Next.js/TypeScript for the planned frontend, Node.js/Fastify/TypeScript for the API, Viem for EVM access, Solidity and Foundry for contracts. The frontend is not implemented. An unmodified V2 contract candidate is exercised in local tests. Amounts are base-unit decimal strings over JSON and bigint in calculations. Never use floating point for balances, quotes, minimum output, or approvals.

## Trust boundaries

1. Browser and wallet: browser requests quotes; wallet owns keys and signs. Treat both API results and all user input as untrusted. Independently check chain, selected venue, recipient, amount, spender and transaction destination before requesting signatures. This protects against malformed responses, not a fully compromised frontend; deployment integrity is also essential.
2. Public API: validates bounded requests; never accepts private keys, arbitrary RPC URLs, caller-provided execution destinations or arbitrary calldata. It has no wallet signing capability. Origins are not authentication.
3. Adapter and RPC layer: each adapter uses a reviewed chain-specific registry of factory/router addresses, ABI versions, code hashes and token policy. Verify RPC chain ID at startup. Bound concurrency, timeouts and retries. Attribute quotes to block number/hash and retrieval time. Do not combine stale snapshots silently.
4. EVM execution: token and DEX contracts are external code. Atomic execution must enforce minimum output, deadline and recipient. API validation cannot replace these protections. The user signs exact amounts and the selected route.
5. Operations: TLS ingress, restricted proxy trust, secrets management and deployment provenance are production requirements. Current API is loopback-only; process-local rate limiting is a development control.

## Quote and execution lifecycle (target)

Validate request -> obtain comparable venue quotes concurrently -> discard stale/invalid sources -> present source status and quotes -> user selects venue -> refresh that venue -> construct and independently decode transaction -> simulate -> review allowance -> wallet signs -> track receipt and confirmations/reorgs.

Quote records must bind chain ID, venue, token pair, amount in, output, gas estimate, snapshot block, expiry and fee disclosure. The transaction-build request adds a validated wallet and selected quote identifier; the initial implementation fixes the recipient to that wallet. Never silently substitute a venue or recipient. Store quote records server-side or integrity-protect them; expiry and all execution limits are rechecked during transaction construction. Server signatures do not replace on-chain limits.

Label “best price” by output for the same input, pair and snapshot; label net-of-gas separately and only when a trustworthy conversion exists. Missing/failed sources cannot be described as compared. Minimum output rounds down. Display token addresses and decimals from a curated registry; native-token wrapping is explicit. Fee-on-transfer, rebasing and callback tokens are unsupported until specifically reviewed and tested.

## Contract approach

Select a mature, license-compatible AMM implementation after reviewing its version, deployed history, dependency graph and known findings. Existing audits do not cover our changes or deployment. Avoid new token custody and generic arbitrary-call routers. Decide whether direct venue transactions suffice before introducing a Cardinal executor. Own pools require a separate economic review of LP shares, fees, rounding, initial liquidity and manipulation resistance.

Document admin powers, upgradeability, fee authority and withdrawal behavior before choosing implementations. Proposed default: minimal admin authority, no unrestricted fund movement, multisig for any necessary administration and timelocks for non-emergency changes. Pausing must not unnecessarily trap LP withdrawals. No deployment or mainnet network configuration exists yet.

## Current API

- GET /health/live: process liveness only.
- GET /health/ready: 503 until an enabled adapter has recently returned a successful quote.
- POST /v1/quotes: strict testnet input validation; optional read-only QWAP direct and WQMS-mediated quotes. See qwap-integration.md for the implemented scope.

QMS testnet chain ID is 19480. Verify published network details and actual RPC chain ID before integration. No mainnet chain ID is accepted. Slippage request policy is initially 0–500 basis points; this is a ceiling, not a recommended default. Unknown body properties, numeric amounts, zero addresses, identical token pairs and uint256 overflow are rejected.

## Next milestones

1. Verify QWAP's current deployment addresses, ABIs, token registry and licensing from authoritative sources and on-chain bytecode; record evidence.
2. Implement a read-only quote adapter and pinned-block integration tests, with RPC timeout and partial-failure coverage.
3. Build the quote-selection UI, preserving source identity and separating indicative from executable quotes.
4. Review AMM choice and execution design; add contract fuzz/invariant and fork tests before wallet execution.
5. Complete mainnet gates separately. Testnet acceptance is not mainnet readiness.

References: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ ; https://qms.finance/news/introducing-qms-builder-program

## Implementation update

QWAP provenance verification and the read-only adapter with direct and two-hop WQMS route comparison are now implemented. Registry hashes are rechecked at the snapshot block per request, with a final block-hash recheck. The execution lifecycle above remains a target: unsigned transaction construction and block-pinned simulation are now implemented behind a default-off testnet flag. Wallet integration, routes through other intermediates, cross-venue routing and durable indexing are not implemented. Read-only receipt/confirmation tracking with bounded in-memory reorg observations is now available; see transaction-status.md.

Unsigned preparation status and remaining execution gates: [transaction preparation](transaction-preparation.md).

## Cardinal AMM evaluation

Unmodified Uniswap V2 core and Router02 artifacts are now pinned and exercised in local Foundry tests. See cardinal-amm.md for bytecode provenance, GPL licensing notes, admin/pause constraints and remaining integration work. This is an evaluated candidate, not a public deployment or production approval.

## Exchange comparison update

Separate registry configurations now drive quote verification and preparation for multiple V2 venues. Comparisons pin a common snapshot, expose per-venue availability and rank output without favoring Cardinal. Quote IDs bind the selected router, and preparation refreshes that venue only. The public server registers QWAP alone; Cardinal registry values exist only in the local-fork harness. See exchange-comparison.md.

## Pool read update

Registered V2 venues now expose block-pinned reserves and optional wallet LP positions through `GET /v1/pools/:venue`. Public configuration enables QWAP only. Estimates are indicative; unsigned withdrawal preparation is now available behind a separate flag; deposits into existing pools are also supported. See [deposit preparation](liquidity-addition.md). See [withdrawal preparation](liquidity-removal.md). See [pool positions](pool-positions.md).

## Capability discovery

`GET /v1/capabilities` exposes configured operation and venue scopes for future frontend integration. It performs no RPC work and makes no liquidity or execution-readiness claim. See [capabilities](capabilities.md).
