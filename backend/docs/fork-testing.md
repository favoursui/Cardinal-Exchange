# Local QMS fork integration test

This test exercises deployed contract bytecode and state through the actual API and Viem readers. It complements deterministic unit/API tests; it is not an audit or proof of mainnet safety.

## Start an isolated fork

Requires Node.js 22, npm dependencies, and Foundry's `anvil`. In a separate terminal:

```sh
anvil --host 127.0.0.1 --port 18545 --chain-id 19480 --accounts 1 --balance 100 \
  --fork-url https://rpc.testnet.qms.finance --silent --no-storage-caching
```

Then run:

```sh
npm run test:fork
```

Stop Anvil when finished. Optional `--fork-block-number 237720` pins the historical block used for the initial successful run; the remote RPC must retain its state. Testnet resets or changed deployment hashes can invalidate old tests. Verify the registry before updating it.

The script hardcodes `http://127.0.0.1:18545`, verifies Anvil client identity, verifies the fork metadata chain ID, and uses only its unlocked synthetic account. It accepts no external transaction URL and no private key. Fork data comes from read-only upstream RPC calls. Transactions are submitted solely to Anvil. Do not use a fork shared with unrelated work: the script takes a snapshot and restores it in `finally`.

The production server still uses the fixed QMS RPC. Only in-process reader factories accept client injection for local testing; HTTP clients cannot choose an RPC endpoint.

## What runs

1. Snapshot the local fork and align its next block timestamp with the local clock.
2. Deposit synthetic native QMS into the existing WQMS contract.
3. Warm lazily fetched fork code/storage, then run normal quote checks without disabling identity, expiry, slippage or simulation checks.
4. Request a WQMS→USDC quote through Fastify.
5. Confirm that preparation returns exact allowance instructions and no transaction before approval.
6. Approve the precise input amount on the fork and request a new quote.
7. Prepare, decode/check, simulate and estimate gas through production code.
8. Independently verify the actual router rejects excessive minimum output and an expired deadline using `eth_call`.
9. Send the exact prepared calldata locally, inspect the successful receipt, confirm input debit and recipient output, and confirm the exact allowance was consumed.
10. Repeat approval/preparation/execution for USDC→WQMS→WETH, then restore the snapshot.

For environments requiring outbound access approval, Anvil needs network access to fetch state. The Node script only needs localhost connectivity. Cold fork state can be slow; the script explicitly warms relevant pool state rather than weakening API timeout limits.

## Observed successful run

Fork source block: **237720**. Both local transactions succeeded:

| Route | Input base units | Received base units | Gas used |
| --- | ---: | ---: | ---: |
| WQMS → USDC | 1000000000000000000 | 496894 | 113685 |
| USDC → WQMS → WETH | 10000 | 4490264200773 | 168895 |

The wallet received at least each preparation's minimum output, and allowances returned to zero. Minimum-output and deadline rejection tests passed. The local snapshot was restored successfully. These numbers are historical test observations, not current quotes.

## Remaining limits

No browser wallet UX, public testnet broadcast, transaction replacement tracking, mainnet deployment, contract audit, token source review or production deployment is covered. A fork reproduces a snapshot and local execution, not QMS's live consensus/reorg behavior. Code hashes and local success cannot establish all safety properties of token or pool implementations.
