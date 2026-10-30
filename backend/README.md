# Cardinal Exchange

Development foundation for a QMS DEX and exchange-by-exchange swap aggregator. TypeScript/Node.js API; planned Next.js frontend and Solidity/Foundry contracts.

This is not a functioning exchange or a mainnet-ready release. A read-only QWAP quote adapter (direct and via WQMS) is available, disabled by default. Unsigned testnet swap preparation is available behind a separate flag. Cardinal pools and signing/broadcast endpoints do not exist. Unavailable or invalid sources fail closed.

## Run locally

Use Node.js 22 and npm. Run `npm ci`, then `npm run dev`. The API binds to 127.0.0.1:3001. Set PORT through the process environment to change it; .env files are not automatically loaded. Never provide private keys.

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
