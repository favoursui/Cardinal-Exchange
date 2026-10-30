# API capability discovery

`GET /v1/capabilities` lets the frontend discover the configured operations on the running API. It performs no RPC calls, requires no wallet, and returns `Cache-Control: no-store`. It does not expose RPC endpoints, environment contents, secrets, or private registry hashes.

The response includes `apiVersion: "v1"`, `chainId: 19480`, `testnet: true`, and these operation objects:

| Operation | Enabled when | Venue scope |
| --- | --- | --- |
| `quotes` | Quote source is configured | Quote adapter IDs |
| `swapPreparation` | Quote source and swap execution reader exist | Quote adapter IDs |
| `poolReads` | Pool adapters are configured | Pool adapter IDs |
| `liquidityAddition` | Addition preparer is configured | Pool adapter IDs |
| `liquidityRemoval` | Removal preparer is configured | Pool adapter IDs |
| `transactionTracking` | Tracker is configured | No venue list; chain-wide |

Each venue-aware operation contains `enabled` and `venues`. A disabled operation has an empty venue list. A custom injected quote source that provides no venue metadata returns `venues: null`; clients must treat that as unknown, not as all venues supported. The built-in adapters and multi-venue service always provide their registered IDs. Lists are sorted, and quote/pool scopes remain independent. The public server registers QWAP alone; local test injection may register Cardinal without making it a public deployment.

The `restrictions` object describes the currently implemented policies: unsigned transactions only; no backend signing/broadcasting, native-token operations, pool creation, or split routing; deposits require existing pools; no enforced minimum minted LP shares; quote ranking before gas; maximum slippage of 500 bps. This ceiling is not a recommended slippage default.

`availability.basis` is `configuration`. An enabled capability is **not a successful RPC check, a live quote, a guarantee of available liquidity, or mainnet approval**. `/health/ready` still describes recent read-only quote success only, not readiness to execute every operation. Use each actual operation's response to handle unavailable liquidity, expiry, approval requirements and upstream errors.

Frontend flow: read capabilities, verify the expected chain, show controls only for supported operations, obtain tokens from `/v1/tokens`, and request actual quotes/pool state before wallet review. Configuration discovery never replaces independent validation of transaction destination, token amounts, spender, recipient, deadline and chain. The frontend is not implemented yet.

Server flags are unchanged: `QWAP_QUOTES_ENABLED` enables quotes and pool reads, `SWAP_PREPARATION_ENABLED` enables swap preparation, and `LIQUIDITY_PREPARATION_ENABLED` enables both deposit and withdrawal preparation. Execution flags require quotes. Tracking is configured independently and remains enabled in the public server even when trading features are disabled.
