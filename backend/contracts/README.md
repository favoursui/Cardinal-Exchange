# Cardinal AMM prototype

The initial pool foundation uses unmodified **Uniswap V2** factory, pair and Router02 creation artifacts. It is deployed only inside local Foundry tests and the isolated QMS fork harness. There is no public Cardinal deployment or active public Cardinal quote source yet.

Pinned dependencies:

- `@uniswap/v2-core@1.0.1`
- `@uniswap/v2-periphery@1.1.0-beta.0`

Both packages declare GPL-3.0-or-later and include their license texts and Solidity sources. No upstream implementation has been copied or modified. See [AMM decision and provenance](../docs/cardinal-amm.md) before deployment or redistribution.

## Tests

Install Node.js dependencies with `npm ci`, install Foundry, then run:

```sh
npm run test:contracts
```

This verifies package versions and creation bytecode hashes, generates ignored `artifacts/upstream.json`, and runs Foundry. The test harness uses Solidity 0.8.30 and the Prague EVM target; it does **not** recompile upstream 0.5.16/0.6.6 bytecode with that compiler.

If automatic compiler download is unavailable, supply a checksum-verified local Solidity 0.8.30 binary:

```sh
npm run test:contracts -- --use /absolute/path/to/solc-0.8.30
```

Tests cover pool address derivation, creation rules, fee authority, LP deposits/withdrawals, locked minimum liquidity, swaps, slippage/deadline rejection, reentrancy rejection, rounding, reserves and token/LP supply. Fuzz tests run 256 cases each. Three stateful invariants run 128 sequences of 32 handler calls each. The handler models supported standard tokens and bounded deposits, swaps and withdrawals; this is not exhaustive adversarial-token or economic analysis.

`TestToken`, `ReentrantBorrower` and `LiquidityHandler` are test-only contracts. They must never be deployed as production tokens or components. The wrapped-native address in these tests is a placeholder standard token; native wrapping is not covered by this suite.

Test directories remain ignored by Git at the owner's request. Restore them before expecting a fresh clone or CI to reproduce these checks.
