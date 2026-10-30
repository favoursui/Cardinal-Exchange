# Exchange-by-exchange quotes

Cardinal's quote service supports multiple independently configured V2-style venues. The production server currently registers only QWAP. Cardinal's candidate factory/router can be injected by the localhost-fork harness; there are no public Cardinal deployment addresses or HTTP/environment address overrides.

## Response and ranking

POST `/v1/quotes` keeps the same request body. The response contains one independently selectable quote per available exchange, ordered by exact output base units before gas. Each quote has its own opaque `quoteId`, venue ID/name, configured router, path, pools, block snapshot, expiry and `bestAvailablePrice` boolean. A tie is ordered deterministically by venue ID; it does not express a price advantage.

Each comparison uses one snapshot block across all adapters and rechecks its canonical hash after collection. Venue responses must match the requested tokens, amount, chain, venue and snapshot. Expired quotes are excluded. `coverage` lists requested venues, available venues, individual sanitized failures, and whether coverage is complete. `bestAvailablePrice` means best among returned quotes, not a guarantee across unavailable venues or after gas. A failed venue is not represented with a fictional price. If all venues fail, return 503 `NO_AVAILABLE_QUOTES` with coverage details.

Comparisons admit four requests per process, register at most four unique venues and have a 30-second response deadline. Each adapter retains its own limits. Timed-out underlying work keeps its capacity until it settles. Production-wide RPC budgeting and distributed limits remain pending.

## Preserve the user's selection

Preparation uses the selected quote ID to retrieve its venue and calls only that venue's adapter to refresh it. It does not choose the top-ranked quote again. The refreshed router, venue, path and pools must match the original quote. Allowance instructions, simulation and unsigned calldata use that venue's configured router. HTTP clients cannot supply a different router, spender, recipient, route or amount.

Router identity is recorded with the quote and compared during refresh. Each adapter verifies its factory/router/token runtime hashes and factory linkage, and verifies every route hop. QWAP uses `WQMS()` while upstream Router02 uses `WETH()`; this is explicit in the configuration. The shared constant-product implementation currently assumes the reviewed 997/1000 fee formula; arbitrary AMM types and fee models are not supported.

## Local integration harness

Start the isolated Anvil fork described in fork-testing.md, then run:

```sh
npm run test:cardinal-fork
```

The script verifies pinned artifacts, creates a separate Cardinal factory/router/pool on localhost, deposits real forked WQMS and test USDC, and obtains quotes from both exchanges at the same block. Pool seeding deliberately makes Cardinal's quote worse than QWAP's to test that selecting Cardinal still uses Cardinal's approvals and router. It exercises each exchange's swap, checks exact allowance consumption and minimum output, redeems Cardinal LP shares, and restores the snapshot.

All deployment addresses from this test are ephemeral local addresses. They must never be copied into the production registry. Public testnet deployment still requires explicit deployment configuration, administration decisions, contract/token review and verification evidence.

## Recorded verification

At fork source block **239957**, the local suite deployed separate factory/router/pair contracts, compared both venues, executed a deliberately lower-priced Cardinal selection, executed QWAP separately, and redeemed Cardinal LP shares. For the same 0.1 WQMS input, the selected local Cardinal swap received 24801 test USDC base units; QWAP received 49635. These are historical fixture results, not current prices. The snapshot and timestamp settings were restored afterward.

The new-pool regression deliberately holds setup/simulation timestamps constant, then mines the first Cardinal swap one second later. The original 20%-only gas margin failed; an Anvil call trace identified out-of-gas in the pair when initializing price accumulators. Preparation now adds 50,000 gas per hop as well as the percentage margin. The same deterministic case passes without changing minimum output, deadline, contract identity or simulation checks. This buffer addresses the tested V2 case; it does not guarantee inclusion under all future state changes.

The backend regression suite passed 44 tests with strict type checking and compilation. No public deployment or broadcast occurred.
