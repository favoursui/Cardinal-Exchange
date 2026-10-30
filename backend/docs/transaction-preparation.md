# Unsigned testnet swap preparation

Status: experimental, default off. No signing keys, transaction broadcasting, mainnet support, or approval transaction construction. This feature prepares unsigned calldata for the selected venue's configured router; it does not deploy Cardinal contracts.

## Enable locally

```sh
QWAP_QUOTES_ENABLED=true SWAP_PREPARATION_ENABLED=true npm run dev
```

Environment files are templates, not automatically loaded. Both flags must be true. Only QMS testnet chain 19480 and the registry's three test tokens are supported. The token runtime hashes were pinned, but their source implementations have not been fully reviewed; successful simulation does not establish token safety. This is not a mainnet release.

## Request flow

1. POST `/v1/quotes` with chain ID, token pair, base-unit input amount and slippage. The quote now includes a random `quoteId` valid until its `expiresAt`.
2. Select the exchange/route and request preparation using only the ID and wallet:

```json
{"quoteId":"<ID returned by /v1/quotes>","wallet":"<connected wallet address>"}
```

POST this body to `/v1/transactions/prepare`. No caller-selected router, recipient, amount, slippage override, RPC URL or calldata is accepted. The recipient is always the supplied wallet, which must match the connected signing account when a frontend is added. A wallet address is not authentication; the API only reads and simulates, while the wallet remains the authorization boundary.

3. The server loads the original quote, refreshes its market data, requires the same venue, path and pool identities, and rejects an output below the originally selected minimum. If a better path is now selected by the router, preparation returns `ROUTE_CHANGED_REQUOTE`; it never silently changes the user's route. Refresh and review a new quote instead.
4. The server verifies chain ID and reads the wallet's token balance and router allowance at the refreshed quote's block. If funds are insufficient, it returns `INSUFFICIENT_TOKEN_BALANCE` without calldata.
5. If allowance is insufficient, HTTP 200 returns `status: approval_required`, the exact input amount, token, owner, selected venue spender, current allowance, `resetAllowanceFirst` and `transaction: null`. This is guidance only, not an approval transaction. Existing nonzero allowance must be reset and confirmed before increasing it. The future frontend must independently validate the spender and implement explicit wallet approval UX. Obtain a fresh quote after approval confirms.
6. With sufficient allowance, construct `swapExactTokensForTokens(amountIn, amountOutMin, path, wallet, deadline)`. The minimum is the stricter of the selected quote and refreshed quote minimums; deadline is server time plus 120 seconds. Value is zero and target is always the selected venue's registered router.
7. Decode the exact calldata and compare it to intended parameters. Run sender-specific `eth_call` and `eth_estimateGas` at the refreshed block; reject reverts, invalid output, zero/excessive gas estimates, expiry or a changed block hash.
8. Only then return `status: prepared` with the unsigned transaction, simulation block/hash, route, output minimum and expiry. Gas limit includes a 20% margin plus 50,000 gas per V2 hop to cover next-block price-accumulator initialization omitted by same-timestamp simulations. The response exposes this policy separately from estimated gas; unused gas limit is not charged as gas consumed. This is a conservative tested allowance, not a guarantee against all state changes. Decimal strings represent value, gas, amounts and deadlines; a frontend must convert them appropriately for its wallet SDK. Nonce and fee fields are deliberately omitted for the wallet to populate.

## Operational limits

The quote cache is process-local, bounded to 1,000 entries, and stores immutable copies under random UUIDs. Expired/evicted IDs and IDs from a previous process return 409; users must requote. It is not an authorization/session database. Multi-instance deployment needs shared state or explicit routing affinity before use.

Preparation admits two concurrent computations per process, has a 30-second response budget, and allows 10 requests/minute per client IP. Outstanding work retains its capacity slot until it settles. RPC calls have bounded timeouts. A selected quote must be valid when preparation begins; a refreshed quote must remain valid when the result is returned. Client-disconnect cancellation, global quotas and shared rate limiting are not implemented.

## Security and validation limits

- On-chain minimum output and deadline remain enforced by the existing QWAP router, as confirmed in its verified source. The backend cannot guarantee inclusion or future execution price.
- No native QMS swaps, permits, fee-on-transfer tokens, arbitrary recipients, cross-chain execution or server-side signatures.
- State may change after simulation. The future frontend must check chain/account/target/value/calldata, display refreshed output and minimum, reject stale preparations and repeat simulation before signing where possible.
- A compromised frontend could still misrepresent transactions. Dependency review, deployment integrity, contract/token review and an independent security assessment remain mainnet gates.
- Unit/API tests use deterministic RPC fixtures, including simulation output and gas estimation. They verify preparation control flow and encoded transaction intent, not actual funded-wallet execution on QMS.
- Funded direct and multi-hop swaps have now been validated on a local Anvil fork using the real deployed contracts. No public-network funded swap has been signed or broadcast. See fork-testing.md for evidence and scope.
- Test sources remain ignored by Git per the owner's earlier request. Hosted CI will not have these tests until that policy changes.

Reference ABI/source: https://testnet.qmsscan.io/api/v2/smart-contracts/0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619

Multi-venue update: quote IDs also bind the configured router. Refresh, allowance checks, simulation and calldata remain on the selected venue even when another exchange quotes more output. See exchange-comparison.md. Public QMS remains QWAP-only until a Cardinal deployment is verified.
