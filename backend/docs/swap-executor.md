# Cardinal swap fee executor

Status: experimental local implementation, not audited or publicly deployed. The public QWAP registry remains direct-router and collects no Cardinal fee. No fee is enabled through an environment variable.

## Revenue flow

`contracts/src/CardinalSwapExecutor.sol` wraps standard ERC-20 V2-router swaps. The caller approves the executor for the gross input. `swap(router, amountIn, minimumOut, path, deadline)` pulls that amount from the caller, swaps the net amount through an allowlisted router, sends output directly to the caller and transfers the input-token fee to the treasury. The whole operation is atomic: any failure reverts the fee, swap and transfers, apart from network gas paid for a reverted transaction.

The local QWAP fixture uses **10 bps (0.10%)**. Fee = `floor(grossInput * bps / 10000)`; net = gross minus fee. Very small amounts can round to zero fee. For 100 USDC, the fee is 0.10 USDC and QWAP receives 99.90 USDC. QWAP pool fees still apply to the net swap. Users can bypass Cardinal and call QWAP directly; this is a service fee for execution through Cardinal, not a tax on all QWAP activity.

## Contract boundaries

Fee rate, treasury and router/token allowlists are fixed at construction. The constructor caps the rate at 50 bps; this is a maximum supported by the implementation, not a chosen production rate. There are no owner setters, upgrades, arbitrary-call functions, signature/permit handling, native-token paths or rescue functions. Changing treasury, rate or allowlists requires a new deployment and separately reviewed registry update. There is no on-chain pause. Tokens accidentally sent directly to the executor are not swept by later callers and may remain trapped; users should approve and call `swap`, not transfer tokens to it.

Routers and tokens must have code at deployment, are pinned by runtime code hash, and are checked again on every swap. Paths contain two or three distinct allowlisted tokens. The recipient is always the caller. The contract requires positive input/minimum output and an unexpired deadline, uses a reentrancy guard, validates incoming token balance changes and actual recipient output, pays the exact fee, and verifies no swap input remains above any preexisting donation. Router approval is set to the exact net input and cleared after execution. ERC-20 calls accept standard boolean success or empty return data and reject failure/false returns.

These checks support reviewed standard tokens only. A proxy can change behavior without changing its own runtime hash; rebasing, transfer-tax, callbacks, token upgrades, blacklisting and malicious router/token behavior require explicit review and are not generally supported. Runtime allowlisting is not an audit or protection against a deliberately malicious approved implementation. Treasury administration and incident procedures need separate review.

## Quote, approval and preparation integration

A server-controlled venue registry can optionally provide an executor address, its runtime hash, treasury and fee rate. Quote requests cannot override those values. The adapter verifies the executor's hash, immutable fee/treasury and stored router/token code hashes at the quote block. It quotes each route using net input, while `amountIn` stays the user's gross budget. `cardinalFee` discloses executor, treasury, token, rate, amount, net input and input-side collection. Quoted output and cross-venue ranking are therefore after the Cardinal fee and pool fees, before gas; the impact calculation is relative to gross-input reserve spot output.

Swap preparation requires refreshed executor and fee terms to match the selected quote, verifies fee arithmetic, requests gross allowance to the executor, and encodes the exact downstream router, gross input, minimum output, path and deadline. It simulates from the actual wallet and checks the simulation's net input and final output. A change between direct and executor execution requires a new quote. Fee metadata is returned for both approval instructions and prepared transactions. No backend signing or public broadcast is introduced.

Wallet reads retain `spender`/`allowance` for the venue's router (needed for liquidity) and additionally return `swapSpender`/`swapAllowance`, which point to the executor when enabled. Liquidity deposits and withdrawals still use the venue router directly and do not incur this swap fee.

The future frontend must show gross input, separate Cardinal fee, net swap input, pool-fee disclosure, minimum output, treasury and actual approval spender before signing. It must not reuse a previous direct-router approval as an executor approval or claim that the original quote output excludes fees.

## Build and verify locally

```sh
npm run build:contracts -- --use /path/to/verified/solc-0.8.30
npm run check
npm run test:contracts -- --use /path/to/verified/solc-0.8.30
# Start the isolated QMS Anvil fork described in fork-testing.md, then:
npm run test:cardinal-fork
```

The fork harness requires a freshly built executor artifact and checks its source hash. It deploys the executor only on localhost, sets a local treasury, enables the fee for QWAP quotes, executes the exact API transaction, checks the fee credit and output, checks zero retained input/router allowance, and continues deposit/withdrawal tests. Direct Cardinal-pool swaps in that fixture remain without an extra Cardinal executor fee.

Foundry tests cover gross debit, exact fee/output, cleared approvals, rollback on router failure, disallowed routers/tokens/paths, deadline/minimum bounds, reentrancy, fee cap/overflow-safe rounding and donated-balance preservation. API tests cover net quotes, fee disclosures, executor approvals, immutable configuration mismatches and quote-term changes. These are initial checks, not exhaustive economic/adversarial testing. Test directories remain Git-ignored under the existing policy; the contract source and fork script are outside those directories.

Before public deployment: select and review the actual treasury/rate, independently audit this new executor, verify reproducible compiler settings/source and runtime, validate router/token permissions and wrapped-native behavior, rehearse incident handling and record public-testnet evidence. The existing AMM deployment planner/verifier covers factory and router only; it does not certify this new executor. Register an executor only after its own deployment review. No production revenue is being collected yet.

## Recorded verification

The completed local QMS fork run at source block **246592** swapped gross 0.1 WQMS through QWAP, paid **0.0001 WQMS** to the local treasury, and delivered **49,679 test USDC base units** to the caller. The exact prepared transaction met its minimum output, and the executor retained neither input tokens nor router allowance. Direct Cardinal swaps and liquidity add/remove flows also passed. These are historical fixture results, not live prices. The snapshot was restored and the local Anvil process stopped.

Validation passed **78 backend tests**, **7 deployment-tool tests**, **26 Foundry tests** (including fuzz/invariant runs), strict TypeScript checking and compilation. A prior fork attempt completed transaction assertions but failed snapshot cleanup; it was stopped and replaced with the successful fresh run above. New token-adversarial cases verify transfer-tax rejection and complete user/pool rollback when the final treasury transfer returns false.
