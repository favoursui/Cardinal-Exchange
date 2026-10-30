# Unsigned liquidity withdrawal preparation

`POST /v1/liquidity/remove/prepare` prepares a standard ERC-20/ ERC-20 V2 `removeLiquidity` transaction for an explicitly selected registered venue. Enable with `LIQUIDITY_PREPARATION_ENABLED=true` and `QWAP_QUOTES_ENABLED=true`. It is disabled by default, accepts only QMS testnet chain 19480, and never signs or broadcasts.

Example request (liquidity is a decimal string in LP base units):

```json
{
  "chainId": 19480,
  "venue": "qwap",
  "tokenA": "0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34",
  "tokenB": "0xDd4D61DF875cc613E1372c78827a5F4C2741bf11",
  "liquidity": "1000",
  "slippageBps": 50,
  "wallet": "0x7777777777777777777777777777777777777777"
}
```

The service obtains a fresh verified pool snapshot and LP balance, validates sufficient owned shares, and derives each minimum as `floor(floor(liquidity * reserve / totalSupply) * (10000 - slippageBps) / 10000)`. Both minimums must be positive. Slippage is bounded to 0–500 bps. Responses use canonical token0/token1 order regardless of request order.

If LP allowance is insufficient, the result is `approval_required` with the exact pool-token amount and selected router spender. A nonzero insufficient allowance sets `resetAllowanceFirst`. No approval calldata or unlimited allowance is returned. After the approval is confirmed, repeat preparation and review the new amounts. These are fresh preparations rather than stored quote commitments; the wallet UI must show the returned minima and must not silently replace a transaction the user has already reviewed.

With sufficient allowance, the service encodes and independently decodes `removeLiquidity`, fixes the recipient to the validated requesting wallet, and simulates and estimates gas from that wallet at the snapshot block. The two simulated outputs must meet the derived minima. The response includes the simulated outputs, minimums, deadline (120 seconds), preparation expiry (15 seconds after pool observation), simulation block/hash and unsigned transaction. Gas adds 20% plus the existing 50,000-gas V2 accumulator buffer. This is a limit, not an exact fee estimate or guarantee of inclusion.

Canonical block hash and expiry are checked before both approval instructions and prepared transactions are returned. Router/factory/token identities and pair linkage are verified by the pool adapter. Capacity is two preparations per service, with a 30-second response deadline retaining slots until underlying work settles. The route is limited to ten requests per minute per IP and forbids caller router, recipient and calldata fields. Raw RPC errors are sanitized.

Limitations: current public registry has QWAP only; Cardinal is exercised on a local fork. Standard ERC-20 removal only: no permit, native unwrapping, fee-on-transfer/rebasing tokens, liquidity addition or public Cardinal deployment. Reserve-derived minima can conservatively reject withdrawals where pending protocol-fee minting materially dilutes shares; the API never lowers minima to force simulation success. Donations or reserve/balance differences can change actual output. Simulation does not protect against state changes after preparation; on-chain minimums and deadline provide the transaction bounds. Future mainnet use requires the separate release gates and independent review.

The local fork harness requests LP approval instructions, approves the exact LP amount locally, submits the exact prepared transaction, checks both minimum outputs and the zero remaining LP position, and restores its snapshot. Test directories remain ignored under the existing repository policy; the integration script is outside those directories.

Recorded verification: at QMS fork source block **240511**, the local harness passed exact LP approval, API-generated withdrawal execution, both minimum-output checks and zero remaining owned LP. The snapshot was restored and Anvil stopped. `npm run check` passed all **55 tests**, strict type checking and compilation. No public transaction or deployment occurred.
