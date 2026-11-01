# Cardinal Exchange

Development foundation for a QMS DEX and exchange-by-exchange swap aggregator. TypeScript/Node.js API; planned Next.js frontend and Solidity/Foundry contracts.

This is not a functioning exchange or a mainnet-ready release. A read-only QWAP quote adapter (direct and via WQMS) is available, disabled by default. Unsigned testnet swap preparation is available behind a separate flag. Cardinal pools exist only in the local fork harness; signing/broadcast endpoints do not exist. Unavailable or invalid sources fail closed.

## Run locally

Use Node.js 22 and npm. Run `npm ci`, then `npm run dev`. The API binds to 127.0.0.1:3001. Set PORT through the process environment or `.env` to change it. `npm run dev` and `npm start` load `.env` when present; existing process environment variables take precedence. Never provide private keys.

`npm run check` runs strict type checking, security-boundary tests and compilation. `npm start` runs the compiled API after a build. `npm run audit:dependencies` checks dependency advisories using the npm registry; it is not a code audit.

Example quote request:

```sh
curl -X POST http://127.0.0.1:3001/v1/quotes \
  -H 'Content-Type: application/json' \
  -d '{"chainId":19480,"tokenIn":"0x1111111111111111111111111111111111111111","tokenOut":"0x2222222222222222222222222222222222222222","amountIn":"1000000","slippageBps":50}'
```

These addresses are examples, not verified tokens. Expected result: 503 NO_VERIFIED_LIQUIDITY_ADAPTERS. `/health/live` returns 200; `/health/ready` returns 503 unless the enabled adapter has recently returned a verified quote.

## Design and security

- [Architecture and implementation milestones](docs/architecture.md)
- [Threat model and actual mitigation status](docs/threat-model.md)
- [Mainnet release gates](docs/mainnet-release.md)

Current controls include bounded bodies, non-coercing validation, testnet chain restriction, uint256 amount limits, rate limiting, security headers and sanitized errors. Production ingress, distributed rate limiting, frontend security, mainnet execution review and contract audits remain future work. This workspace currently has no usable Git repository; branch protection and hosted CI must be configured when it is connected to one.

## Live testnet quotes

Run `QWAP_QUOTES_ENABLED=true npm run dev` to enable read-only QWAP quotes. Retrieve supported tokens with `GET /v1/tokens`. Native QMS and arbitrary token addresses are not supported. See [QWAP integration and verification evidence](docs/qwap-integration.md) for a valid request, limitations, and the opt-in live smoke check. Quotes never include executable transactions.

## Unsigned testnet preparation

See [transaction preparation](docs/transaction-preparation.md) for the quote-ID workflow, allowance handling, simulation checks, and limitations. Enable explicitly with `QWAP_QUOTES_ENABLED=true SWAP_PREPARATION_ENABLED=true npm run dev`. A successful response requires sufficient test-token balance and allowance. No backend operation signs or sends a transaction.

## Real-contract integration tests

`npm run test:fork` runs the approval, preparation, simulation and swap flow on a localhost-only Anvil fork. Start the fork as described in [fork testing](docs/fork-testing.md). These tests never submit transactions to public QMS and restore the local snapshot afterward.

## Transaction tracking

`GET /v1/transactions/<hash>` reports pending, confirming, confirmed, reverted, reorged or not-found status on QMS testnet. Three confirmations are an application threshold, not finality. Replacement detection is not implemented. See [status semantics and limits](docs/transaction-status.md).

## Cardinal pool prototype

The candidate AMM uses pinned, unmodified Uniswap V2 artifacts. `npm run test:contracts` runs local Foundry unit, fuzz and stateful invariant tests. See [contract setup](contracts/README.md) and [AMM decision/provenance](docs/cardinal-amm.md). No Cardinal pools are deployed publicly or included in live quotes yet.

## Exchange comparison

Quotes now carry separate IDs per venue and are ranked by output before gas. Selected-venue preparation preserves its router and approval spender. Public QMS currently exposes QWAP only; `npm run test:cardinal-fork` exercises separate Cardinal pools alongside QWAP locally. See [comparison behavior and limits](docs/exchange-comparison.md).

## Pool and LP positions

Read a registered pool and optional wallet LP position with `GET /v1/pools/:venue?tokenA=<address>&tokenB=<address>&wallet=<address>`. QWAP reads use the quote enable flag. See [pool position semantics and limits](docs/pool-positions.md).

## Unsigned liquidity withdrawals

`POST /v1/liquidity/remove/prepare` verifies owned LP shares, requests exact allowance when needed, and simulates a withdrawal before returning unsigned calldata. Enable separately with `LIQUIDITY_PREPARATION_ENABLED=true` alongside the quote flag. See [withdrawal preparation](docs/liquidity-removal.md). Deposits into existing pools are also supported; see [deposit preparation](docs/liquidity-addition.md).

## Frontend capability discovery

`GET /v1/capabilities` reports enabled operations, registered venue IDs and testnet execution restrictions without contacting RPC. Configuration is separate from live readiness. See [capability discovery](docs/capabilities.md).

## Wallet balances

`GET /v1/wallets/:wallet/:venue?token=<address>` returns a registered token balance and allowance for that venue's router at one verified block. Enabled with the quote flag. See [wallet balances](docs/wallet-balances.md).

## Cardinal swap fees

An experimental [swap executor](docs/swap-executor.md) now supports an explicit input-token fee for registered V2 routes. Quotes and unsigned preparation account for the fee and executor spender. The local fork uses 0.10% for QWAP; the public server still uses direct QWAP execution with no Cardinal fee.

## Server network settings

Set `QMS_RPC_URL` and `QMS_CHAIN_ID` in the ignored `.env`. The example uses the public QMS RPC and chain `19480`; private provider URLs belong only in `.env` or deployment secrets. The server shares the configured RPC across all readers and checks its chain before listening. Other chain IDs are rejected because contract registries remain testnet-specific. When unset, settings default to the existing public testnet configuration. Deployment planning scripts also honor QMS_RPC_URL when provided in their process environment.

Set `CORS_ORIGIN` to the exact frontend origin, for example `https://app.example.com` or `http://localhost:3000` (no trailing slash or path). Blank or unset disables cross-origin browser access. Only GET/POST and the Content-Type request header are allowed; cookie credentials are disabled. CORS does not authenticate requests or restrict non-browser clients.
