# Transaction status on QMS testnet

`GET /v1/transactions/:hash` checks a transaction hash against the fixed QMS testnet RPC. The running server enables this read-only endpoint independently of quote/preparation flags. It does not submit or sign transactions. Clients should poll no faster than once every three seconds and back off on 429/503 responses.

## States

| Status | Meaning |
| --- | --- |
| `not_found` | Neither receipt nor transaction is currently available from this RPC. This does not prove it was dropped, cancelled or replaced. |
| `pending` | RPC has the transaction but it has no block assignment or receipt. |
| `confirming` | Successful receipt is in the canonical chain with fewer than three confirmations. |
| `confirmed` | Successful receipt has at least three confirmations under Cardinal's initial testnet policy. |
| `reverted` | Canonically included receipt reports failure. Confirmations are returned separately; this may still reorganize. |
| `reorged` | The receipt or previously observed inclusion block hash differs from the canonical block at that height. Continue polling for re-inclusion. |

`finalized` is always false. Three confirmations are an application threshold, not a guarantee of QMS consensus finality. Do not use this threshold as an unreviewed mainnet policy.

The response includes chain ID, requested hash, status, confirmation count, required confirmations, block number/hash, observed head, observation time, `reorgDetected` and previous inclusion when applicable. Counts and block numbers are decimal strings. All responses disable caching.

## Consistency and errors

Each request verifies chain ID and rejects stale/future head timestamps. A receipt must match the requested hash and a canonical block. For mined status, the block hash is checked again after rereading the head. An RPC error is never converted into `pending` or `not_found`.

A missing receipt after a previously observed inclusion is not sufficient proof of a reorg. If that block still has the same canonical hash, the API returns 503 `INCONSISTENT_CHAIN_STATE`. Missing block data and a head behind the receipt also return 503. Retry with backoff. A canonical hash change permits `reorged`. Later re-inclusion returns its current status with `reorgDetected: true` for the first observation of its changed inclusion.

Malformed hashes return 400. RPC failures, chain mismatches, inconsistent reads and timeouts return sanitized errors without upstream details. There are 20 status requests/minute per IP, four distinct in-flight lookups per process, and a 15-second response deadline. Simultaneous polls for the same hash share RPC work. RPC operations time out individually; work retains its capacity slot until it settles.

## History and scope

The tracker keeps up to 1,000 observed canonical inclusions for 30 minutes after their last observation. State is in-memory and disappears on restart or eviction. It is not a durable transaction indexer, and it cannot detect an old inclusion that it never observed if the RPC no longer reports it. Multi-instance production needs shared observation history and globally enforced limits.

This endpoint reports inclusion/execution status for a hash, including approval transactions. It does not authenticate the requester, associate a transaction with a prepared quote, or verify swap-specific output logs. A successful receipt alone does not establish that a transaction is the user's intended Cardinal swap. Frontend wallet integration must bind the submitted hash and decoded transaction to the intended account/route.

Replacement/cancellation detection is explicitly unsupported (`replacementDetection: unsupported`). A hash alone cannot reliably identify a replacement. Future support needs the original sender/nonce, transaction-intent binding and canonical block scanning or an indexer. A missing transaction is never labeled replaced.

## Tests

Deterministic tests cover pending/unknown, confirmation thresholds, reverts, reorgs, re-inclusion, missing receipts, invalid RPC data, expiry, concurrent polling, timeout and HTTP validation.

The local fork integration harness additionally checks pending → confirming → confirmed against real local transactions, then removes a swap with a snapshot revert and mines a replacement block to verify `reorged`. This models canonical inclusion changes; it does not reproduce QMS's live consensus mechanism. See fork-testing.md for execution instructions and the latest recorded outcome.
