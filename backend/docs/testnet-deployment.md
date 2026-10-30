# Cardinal public testnet deployment preparation

Status: unsigned planner implemented; public deployer and fee authority remain unset. Nothing has been publicly deployed. This tooling rejects mainnet and contains no signing or broadcasting code.

## Tower research and decision boundary

Reviewed Tower's official documentation on 2026-10-30:

- https://docs.tower.exchange/developer-console/api-reference/build-swap-tx documents unsigned approval/swap transactions through a TowerSwapExecutor.
- https://docs.tower.exchange/fundamentals/security states client-side wallet signing, manual code review, and third-party audits planned before mainnet. This is their published statement, not independently verified audit evidence.
- https://docs.tower.exchange/developer-console/api-reference/list-dex-routers describes an authenticated venue catalog. Its example contains conspicuous placeholder-style factory/quoter addresses; examples are not deployment provenance.

The reviewed pages do not establish Tower's actual factory fee authority, multisig owners/threshold, upgrade admin, or verified deployment procedure. Do not copy sample addresses into Cardinal's registry or infer that Tower has a particular multisig configuration. Cardinal currently uses direct selected-venue routers, whereas Tower documents an executor; adding an executor requires separate design and security review.

Our proposed fee-authority policy is a separate reviewed multisig, with protocol fees initially disabled. This is a Cardinal recommendation, not an assertion about Tower. No signer set, threshold or admin address has been chosen. A deployed contract having code does not prove it is a safe multisig. Verify its implementation, owners, threshold, modules/guards, signer custody and chain deployment separately before release.

## Prepare a reviewable plan

Create a JSON configuration containing exactly `chainId` (19480), `deployer` (public EOA address), `feeAuthority` (separate public multisig address), and `nonce` (decimal string). No private keys, seed phrases or RPC overrides are accepted. The nonce must be safe for the RPC library's number representation and leave room for two sequential transactions.

```sh
npm run deployment:plan -- --config /path/to/public-config.json --out /path/to/new-plan.json
```

The command verifies the pinned upstream package versions/licenses and three creation-code hashes, then checks the fixed QMS testnet RPC chain ID and recent block. It verifies wrapped-native runtime identity, requires code at the nominated authority, rejects code at the deployer (only ordinary EOA CREATE supported), checks the configured nonce against both snapshot and pending nonce, rejects existing code at the predicted contract addresses, checks a nonzero gas balance, and rechecks the snapshot hash.

The result contains exact factory and router constructor calldata, predicted CREATE addresses, sequential nonces, authority, wrapped-native address, pinned creation-code hashes and block evidence. It refuses to overwrite an existing plan. No actual-address plan can be produced until Cardinal's addresses are provided. `npm run test:deployment` validates deterministic planning and rejection of invalid configuration/artifact changes using clearly synthetic addresses locally.

This is a preflight, not deployment authorization or a complete funding check. Gas estimation/fees, signer review, multisig semantics, reproducible source verification, GPL release obligations and final wrapped-native behavior review remain outstanding. Runtime checks attest to one RPC snapshot; obtain independent evidence before broadcast. Any intervening deployer transaction changes predicted addresses. Regenerate and review the plan if nonce/network state changes. Submit factory first, verify its successful deployment and runtime/state, then submit the router at the planned next nonce. Do not submit the router after a failed factory deployment.

## Required post-deployment evidence

Before enabling Cardinal publicly, record receipts, actual deployed addresses, runtime hashes and independently verified source/compiler settings. Check factory feeToSetter equals the chosen authority, feeTo remains zero, allPairsLength starts at zero, router factory points to this factory, and router WETH getter equals verified WQMS. Prove factory/pair init-code compatibility and standard-token add/swap/remove behavior on testnet. Review initial pool tokens, liquidity and price separately; the planner creates no pools or liquidity.

Register addresses only after evidence is complete. Local-fork fixture addresses must not be promoted. Public testnet completion does not satisfy the separate mainnet release gates.

## Read-only post-deployment verification

After separately reviewed public testnet deployment, run:

```sh
npm run deployment:verify -- --plan /path/to/plan.json --factory-tx 0xFACTORY_TRANSACTION_HASH --router-tx 0xROUTER_TRANSACTION_HASH --out /path/to/new-evidence.json
```

The verifier reconstructs the entire core plan from pinned creation artifacts and the configured deployer/authority/nonce, rejecting modifications to calldata, predicted addresses, wrapped-native configuration or plan constraints. It checks both successful contract-creation transactions against the exact sender, nonce, zero value and constructor data. Each receipt must be canonical, have at least three confirmations at a fresh snapshot, and report the predicted address. The router transaction must follow factory creation.

At that snapshot, it compares each deployed runtime with the output of a read-only constructor simulation using the pinned creation data. The reviewed factory and Router02 constructors do not call external contracts; the latter embeds the factory and wrapped-native addresses in its runtime. This avoids treating every constructor-patched router as one universal runtime hash. The verifier records the resulting runtime hashes, verifies factory fee authority/zero fee recipient/zero initial pairs and router linkage, checks wrapped-native identity and authority code presence, then rechecks both receipt block hashes and the snapshot hash.

This is an initial, **pre-liquidity** verification step: any existing pool causes it to fail. It writes evidence with exclusive creation and never updates the API registry. Three confirmations are an application threshold, not finality. Runtime matching is not source reproduction, explorer verification, multisig-owner review, audit or mainnet approval; the output explicitly leaves those gates incomplete. State changes after verification require further review. Use an independently trusted RPC/source review before promoting a deployment.

### Local verification test

```sh
anvil --host 127.0.0.1 --port 18546 --chain-id 19480 --silent
npm run test:deployment-local
```

This integration test requires a localhost Anvil instance, uses unlocked local accounts without private keys, and restores its snapshot. It deploys a one-byte dummy STOP contract as both authority and wrapped-address fixture, followed by the exact pinned factory/router. The dummy is neither a multisig nor a wrapped token and must never be used as a public configuration. The test verifies actual creation transactions, runtime constructor comparison and initial state. It passed locally; no public deployment has occurred. Stop Anvil afterward.

`npm run check` includes the offline planner/verifier regression suites, covering tampered plans, wrong network, confirmation depth, missing or mismatched code, wrong transaction data, reverted creation, incorrect admin/linkage, existing pairs and reorgs. The current checks passed 75 backend tests and seven deployment-tool tests, plus type checking and compilation.
