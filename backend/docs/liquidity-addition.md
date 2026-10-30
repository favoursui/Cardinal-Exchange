# Unsigned deposits into existing pools

`POST /v1/liquidity/add/prepare` prepares standard ERC-20/ ERC-20 V2 `addLiquidity` transactions. Enable with `LIQUIDITY_PREPARATION_ENABLED=true` and `QWAP_QUOTES_ENABLED=true`. Both deposit and withdrawal preparation use this default-off testnet flag. The backend never signs or broadcasts.

Request fields:

```json
{
  "chainId": 19480,
  "venue": "qwap",
  "tokenA": "0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34",
  "tokenB": "0xDd4D61DF875cc613E1372c78827a5F4C2741bf11",
  "amountADesired": "1000000000000000000",
  "amountBDesired": "1000000",
  "slippageBps": 50,
  "wallet": "0x7777777777777777777777777777777777777777"
}
```

Desired amounts are **maximum spending budgets**, in decimal base-unit strings, for the corresponding requested tokens. The service normalizes to canonical token0/token1 order, reads a fresh verified pool snapshot, and reproduces the router's reserve-ratio calculation with integer floor rounding. The limiting budget determines the expected amounts consumed. Minimum token amounts are the expected amounts reduced by the requested 0–500 bps slippage. Zero minimums and reserve overflow are rejected. Pool creation or initialization is not supported; absent pools return the pool lookup error, and zero supply or zero reserves return `POOL_INITIALIZATION_UNSUPPORTED`.

Both token balances must cover the full requested budgets. For each insufficient allowance, `approval_required` returns an entry in `approvals` with the token, owner, selected venue's router, exact budget, current allowance and reset-first instruction. It never constructs approval calldata. Approve only the requested bounded amounts, wait for confirmation, then repeat preparation and review the refreshed transaction. **Unused budget can remain approved after a deposit**, because the router may consume less than one desired amount. The UI must show expected spending separately from approval caps and allow users to manage remaining allowances.

When approvals suffice, the service encodes and independently decodes the transaction, fixes the recipient to the requesting wallet, then simulates and estimates gas from that wallet at the same snapshot block. The two simulated token amounts must exactly match the independent reserve-ratio calculation, and simulated LP shares must be positive. The response includes desired caps, expected amounts, token minimums, `estimatedLiquidity`, canonical token metadata, recipient, block/hash, 15-second preparation expiry, 120-second on-chain deadline and unsigned transaction. Gas includes 20% plus the existing 50,000-gas V2 accumulator buffer.

**Router02 does not enforce a minimum number of minted LP shares.** `liquidityMinimumEnforced: false` makes this explicit. Token minimums constrain the deposit ratio; they are not a minimum-LP guarantee. Do not present the simulated LP amount as guaranteed, infer pool safety or fair value from reserve spot prices, or treat preparation as protection from all MEV/economic risks. A minimum-LP guarantee would require a separately reviewed execution design. Protocol-fee minting, token donations and later state changes can affect LP issuance. Unusual token types remain unsupported.

Both approval instructions and prepared transactions require a final canonical block hash and expiry check. Runtime hashes, pair linkage, chain, pool tokens, balances and allowances are checked at the snapshot. Caller-controlled routers, recipients, calldata and extra body properties are rejected. Errors are sanitized, the route permits ten requests/minute per IP, and the service admits two in-flight preparations with a 30-second deadline. Timed-out work retains capacity until it settles. Limits are process-local; deposits and withdrawals have separate service budgets.

The public registry still contains only QWAP. Cardinal deposits are tested only on a local QMS fork. Unit coverage includes both ratio branches and floor rounding, token ordering, spending caps, missing approvals, empty pools, insufficient balances, overflow, invalid simulations, reorgs, expiry, timeout capacity and HTTP validation. The fork harness approves both budgets, submits the exact API-generated deposit, checks spent amounts/remaining allowances/LP issuance, then withdraws all owned shares through the removal API. Unit test directories remain ignored under the existing repository policy; the fork script is outside them.

Recorded verification: at QMS fork source block **241294**, the local harness passed API-generated deposit execution, exact token spending, positive minted LP shares matching simulation, spending-cap/remaining-allowance checks, and subsequent complete withdrawal. The harness restored its snapshot and Anvil was stopped. `npm run check` passed **62 tests**, strict type checking and compilation. No public transactions or deployments occurred.
