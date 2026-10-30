# QWAP read-only testnet integration

## Provenance and scope

QMS's official onboarding article links https://testnet.qwap.xyz:
https://qms.finance/news/welcome-to-qms-testnet

The public app's testnet configuration was inspected in:
https://testnet.qwap.xyz/_next/static/chunks/3tosnwbsdg5t4.js

The app publishes chain 19480, router 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619, factory 0x93AFD9aC50822F82c7C4f2Ec8Ec2463b086Fb878, wrapped QMS and the current test USDC/WETH addresses. Deployment configuration was cross-checked through read-only RPC calls at the block recorded in [evidence](evidence/qwap-testnet.json). The router's factory() and WQMS() getters match the registry. Token symbols and decimals were read on-chain. These are test assets, not representations of redeemable real USDC or ETH.

Explorer source verification and runtime bytecode were checked for both router and factory:
- https://testnet.qmsscan.io/api/v2/smart-contracts/0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619
- https://testnet.qmsscan.io/api/v2/smart-contracts/0x93AFD9aC50822F82c7C4f2Ec8Ec2463b086Fb878

Both reported verified source and runtime bytecode matching RPC. Router name: QwapRouter, compiler 0.6.6. Its published QwapLibrary uses the 997/1000 constant-product fee calculation. No Solidity source was copied into Cardinal. Explorer license metadata is `none`; this is not permission to fork QWAP contracts. License review remains necessary before reusing any implementation.

This establishes integration identity, not an audit. Code hashes cannot detect every mutable-storage or proxy implementation change. The current API does not produce executable transactions or approval data. Mainnet or transaction building requires additional token/pool implementation review.

## Behavior

Set `QWAP_QUOTES_ENABLED=true` in the process environment to enable the adapter. Default is disabled. The RPC URL is fixed; no user-controlled URL or destination is accepted. `GET /v1/tokens` lists the three supported ERC-20 test tokens. Native QMS is not accepted; WQMS is supported explicitly.

POST /v1/quotes accepts integer base-unit input amounts. For each request:
1. Verify chain ID and a recent block (maximum 120 seconds old, maximum 15 seconds ahead of server clock).
2. Compare router, factory and selected token runtime hashes against the checked-in registry at that block.
3. Check router factory/wrapped-native getters and resolve the direct pool and, for non-WQMS endpoints, both pools on a route through WQMS.
4. Verify each pool factory and token identity, read reserves, and fetch getAmountsOut for each candidate path at the same block number.
5. Independently compare every intermediate and final router output with the published fee formula. Select the highest-output valid route (shorter path on ties) and compute minimum output with integer rounding down.
6. Re-read the snapshot block hash to detect a reorg during collection. Return a 15-second indicative quote with no calldata.

Quotes compare the direct path with the two-hop path through WQMS when neither endpoint is WQMS. This is bounded routing, not an exhaustive search, cross-DEX comparison, or guaranteed execution price. Confirmed absent or empty pools can be skipped. RPC/integrity failures invalidate the comparison. Ranking uses output before gas; a two-hop route can cost more gas. `priceImpactIncludingFeeBps` compares output to the product of the hop reserve spot prices, includes each hop’s 30 bps LP fee and rounds up. Gas is null because execution is not built/simulated. `executable` is always false. No output should be interpreted as an approval request.

RPC calls have a 8-second timeout and no retries. A quote has an 20-second response budget. At most four quote computations are admitted per process. The work retains its slot until outstanding adapter work settles after a response deadline. These process-local limits do not replace shared limits at production ingress. Client disconnect cancellation and distributed RPC budgeting remain future work.

Readiness is 503 before any successful quote; it becomes 200 for 30 seconds after success and is cleared by upstream/verification failure. This is recent quote readiness, not an independent continuous network health probe. Unknown token requests return 422 without invoking RPC. Contract hash changes, resets, stale blocks, reorgs and invalid responses fail closed. Never auto-update hashes to bypass failure; re-verify provenance and update the evidence after review.

## Verification

`npm run check` runs offline deterministic API and adapter tests. `npm run build && node scripts/smoke-qwap.mjs` performs an opt-in read-only live quote through Fastify injection. If the environment requires an outbound proxy, use Node's `--use-env-proxy` flag. The smoke check requires a functioning public RPC and does not spend funds.

Sample payload for one test USDC to WQMS:

```json
{"chainId":19480,"tokenIn":"0xDd4D61DF875cc613E1372c78827a5F4C2741bf11","tokenOut":"0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34","amountIn":"1000000","slippageBps":50}
```

Live API verification succeeded with HTTP 200 at block 234752 (hash `0x8d4f73bf3f9f8496debf4878d48c626ff2265678cf4706f32e02bd17a48cc71a`): 1,000,000 test USDC base units returned 1,995,055,451,349,166,615 WQMS base units through pool `0xc9c07DC80B9381615ef5a575c333125F711465eD`. This historical observation is not a current quote. Earlier smoke attempts timed out and correctly returned 503 with no quotes; the live RPC remains an external availability dependency.

## Multi-hop response fields

`path` and `pools` describe the chosen route in order. `pool` remains populated only for a one-pool route; it is null for two hops. `alternatives` contains the other successfully verified route, if present. `routesChecked` counts candidate paths and `routesAvailable` counts paths with valid quotes. `selectionBasis` is `highest-output-before-gas`; `poolFeeBps` is explicitly per hop (`feeScope`). `routeScope` is `direct-and-via-wqms`. There is still one top-level quote per exchange, preserving the planned exchange-selection UI.

Use `node --use-env-proxy scripts/smoke-qwap.mjs --multi-hop` after building to compare USDC→WETH directly and via WQMS on testnet. No funds are moved.

Multi-hop live verification returned HTTP 200 at block 234887 (`0x2bdef89602cb1a051141ab67c450824c1d97449678f4297380b0a1c4dbff0489`). The API checked two candidate paths; only USDC→WQMS→WETH was available. One test USDC yielded an indicative 448,033,905,486,527 WETH base units. Both pool identities and each intermediate router amount passed validation. The first live attempt timed out at chain-ID retrieval and returned 503; the retry succeeded. This is historical test evidence, not a current executable quote.
