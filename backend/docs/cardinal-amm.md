# Cardinal pool foundation: Uniswap V2 evaluation

Status: local prototype and initial security tests. Public deployment, Cardinal liquidity API integration and mainnet approval are not complete.

## Decision

Evaluate unmodified Uniswap V2 core and Router02 as Cardinal's initial constant-product AMM. Cardinal pools would be a separate factory deployment; they do not reuse QWAP's factory or liquidity. Users could supply liquidity to Cardinal pools, while the aggregator would compare Cardinal and QWAP quotes without preferential routing to Cardinal.

Use the published upstream creation artifacts, checked against pinned hashes, for this evaluation. Avoid rewriting swap, mint, burn or fee-accounting logic. The npm periphery version is named `1.1.0-beta.0`; its version label is preserved, not relabeled as a Cardinal production release. Prior upstream history or audits do not certify our deployment, integrations or operating procedures.

## Provenance

Official artifact usage guidance:
https://developers.uniswap.org/docs/protocols/v2/guides/getting-started

Source repositories:
- https://github.com/Uniswap/v2-core
- https://github.com/Uniswap/v2-periphery

Package versions and integrity are pinned in package-lock.json. `scripts/prepare-amm-artifacts.mjs` verifies exact package versions, license identifiers and these keccak256 creation-bytecode hashes before generating local test artifacts:

| Artifact | Creation bytecode hash |
| --- | --- |
| UniswapV2Factory | `0x8716c49c3c982e1d8b8beaab0a95d88cc5ec06681dded0f951fa1f3059c1e32a` |
| UniswapV2Pair | `0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f` |
| UniswapV2Router02 | `0x60ed3c9563fab19baceb6555668bf136db1f18d96b3b177f3726fccdb254f94b` |

The pair init-code hash is part of the router's deterministic address derivation. Tests prove the generated factory pair address matches that derivation and that router add/swap/remove operations work against the resulting pair. Recompiling, renaming or editing pair source can change this hash and requires a fresh integration review.

The local harness compiler is Solidity 0.8.30. On the initial run, the official compiler mirror failed; the compiler was retrieved from Solidity's GitHub v0.8.30 release and verified against the official solc-bin SHA-256 listing:
`f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7`.

## License and release handling

Both upstream packages declare GPL-3.0-or-later. Their source and license files remain in the pinned packages. Our artifact-reading test harness does not change upstream notices or grant a different license to those contracts. Before publishing contract artifacts or deploying the project, document distribution/source obligations and preserve the applicable notices and corresponding sources. This evaluation is not a license clearance for the entire Cardinal application, and the application has not been relicensed.

## Governance and safety constraints

- Pool, factory and router implementations are non-upgradeable in this design. The factory has fee-recipient and fee-authority setters, not an arbitrary user-fund withdrawal function.
- Initial local fixtures leave the protocol fee recipient disabled. Production fee configuration and its governance are undecided. Test fee authority is the test contract, not a proposed production EOA.
- Before any public deployment, choose and validate the fee-authority multisig and change policy. Publish the exact authority and privileges. Do not silently transfer admin authority or enable fees.
- Upstream pools do not provide a global pause switch. Disabling Cardinal's frontend/quoting cannot halt direct on-chain interactions. Incident procedures must reflect that fact and must not claim the ability to freeze pools.
- Standard ERC-20 tokens are the initial supported class. Rebasing, transfer-tax, callback, blacklisting, upgradeable or otherwise unusual token behavior requires separate review. A permissionless factory cannot prevent others creating unsupported pairs; the frontend/adapter registry must distinguish supported pools.
- Initial liquidity determines price. First deposits, locked minimum LP units, decimals and rounding require clear UI disclosures. Reserve spot prices must not be used as a manipulation-resistant external oracle.
- Before router deployment on QMS, validate the wrapped-native address and its deposit/withdraw semantics. Router02 calls its getter WETH even when configured with WQMS. This differs from QWAP's WQMS getter and must be handled explicitly in adapters.

## Verification and limitations

Foundry locally deploys the exact upstream artifacts and checks creation/address derivation, duplicate/invalid pairs, unauthorized fee changes, LP redemption and minimum-liquidity locking, deadline/minimum-output protection and reentrancy rejection. Two fuzz tests cover swap accounting/product growth and deposit-withdraw rounding across 18/6-decimal assets. Three stateful invariants check reserve/balance agreement, LP supply/locked shares, and token conservation through mixed liquidity and swap actions.

These tests use simple test-only tokens. The original stateful invariants exercise disabled protocol fees; a separate fee-accounting suite now covers enabled fees. Permit signatures, native wrapping in the Foundry harness, malicious token variants, MEV/economic attacks and full deployment reproducibility from source remain outside this coverage. Mainnet requires these reviews where relevant, independent assessment and the mainnet release gates.

## Next integration milestone

Deploy the candidate factory/router only on an isolated local QMS fork; record deployment/runtime identities and use the real WQMS/test tokens. Add a separate Cardinal adapter and exchange registry, then compare Cardinal and QWAP quote responses and preserve venue selection through preparation. No public registry address should be invented or promoted from a local deployment.

## Adapter integration update

A shared registry-driven V2 adapter and venue comparison service now support Cardinal on the local fork. The local harness deploys the checked artifacts, seeds a distinct pool, compares it with QWAP, and exercises venue-bound swap preparation and LP withdrawal. No public deployment or Cardinal production registry entry has been added. See exchange-comparison.md.

## Protocol-fee accounting verification

The fee suite runs the pinned upstream bytecode with protocol fees enabled in local fixtures only. It checks authority transfer and rejection of the former authority, exact fee-share minting during additions/removals, diluted LP redemption, fee-recipient changes, treasury withdrawal, disabled-fee baseline reset, re-enabling behavior and liquidity changes without swap growth. The fee fuzz test runs 256 combinations of trade size, direction and liquidity action; its square-root oracle uses binary search independently of the upstream implementation.

Operational findings:

- Fees accrue through pool growth but protocol LP shares are minted on liquidity mint/burn actions, not on each swap.
- Changing the fee recipient before the next liquidity action redirects accrued fee shares to the new recipient.
- Setting the fee recipient to zero does not immediately reset each pair's growth checkpoint. A subsequent liquidity action while fees are disabled resets it. Turning fees off and back on without such an action preserves the checkpoint, including growth during that interval.
- Pending protocol shares dilute withdrawals. Reserve-only position estimates cannot be treated as guaranteed redemption outputs.

The full Foundry suite passed 17 tests, including three fuzz tests at 256 runs each and three stateful invariants at 128 runs / 4096 calls each. This does not enable fees in deployment plans or prove mainnet readiness. Admin transitions and fee changes still need explicit governance review. These tests remain under the existing ignored `contracts/test/` directory and therefore will not be included in an ordinary Git commit unless that policy is changed.
