# Pool and LP position reads

`GET /v1/pools/:venue?tokenA=<address>&tokenB=<address>&wallet=<address>` reads one direct V2 pool. Wallet is optional; omitting it returns `position: null`. This is a read-only lookup, not discovery of all pools or a wallet portfolio index.

The public server enables QWAP pool reads with `QWAP_QUOTES_ENABLED=true`. Cardinal is supported only through the local fork registry until a public deployment is verified. Unknown venues and unsupported tokens return 422; a factory lookup with no pair returns 404. Disabled reads return 503. Caller-supplied routers, factories, RPC URLs and extra parameters are rejected.

The response identifies the venue, router, factory and pool, followed by canonical `token0`/`token1` metadata, `reserve0`, `reserve1`, `totalSupply`, snapshot number/hash and observation time. Input token order does not change canonical reserve order. Amounts and LP supply are decimal base-unit strings. An optional position contains `lpBalance`, `shareBps` (rounded down), and `estimatedAmount0`/`estimatedAmount1`, computed as `balance * reserve / totalSupply` with integer floor division. An empty, zero-supply pool returns zero estimates.

These are **pro-rata reserve estimates, not executable withdrawal quotes**. They exclude pending protocol-fee dilution and differences between reserves and actual token balances (including donations), and can change with later trades. They are neither guaranteed minimums nor USD valuations. They must not be used as transaction minimums or an external price oracle. Add/remove-liquidity transaction preparation is still pending.

Each request verifies the testnet chain, fresh block timestamp, pinned router/factory/token code hashes and router linkage. The pair must come from the verified factory and report matching factory/tokens. Reserves, LP supply and optional wallet balance are read at the same block; the canonical hash is checked again before returning. LP balance cannot exceed supply. Pair identity relies on the verified immutable factory's pair mapping, as in quote verification.

Pool reads share each adapter's four in-flight slots with quote reads, have a 20-second response deadline, retain capacity until underlying RPC work settles, and do not mark quote readiness successful. The HTTP route limits requests to 20/minute per IP, sets `Cache-Control: no-store`, and sanitizes upstream failures. These limits remain process-local.

Validation covers exact integer rounding, token ordering, absent/empty pools, invalid supply/balance, identity failures, wrong chain, stale snapshots, reorgs, query restrictions, error sanitization and capacity retained after timeout. The local Cardinal fork harness compares returned LP balances and estimates against direct on-chain reads, then checks zero owned LP after withdrawal. Unit test directories remain ignored by Git under the existing repository policy; the fork harness is outside those directories.

Recorded local verification: QMS fork source block **240493** passed the LP position checks, both venue swaps and complete LP withdrawal. The harness restored its snapshot and the isolated Anvil instance was stopped. `npm run check` passed 49 tests, strict type checking and compilation. No public transaction was broadcast.
