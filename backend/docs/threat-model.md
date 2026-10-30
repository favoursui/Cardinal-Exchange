# Cardinal threat model

Assets: user funds, LP deposits, allowances, transaction intent, quote integrity, signing UX, admin authority, deployment artifacts and RPC credentials. Adversaries include malicious clients, tokens, liquidity venues, RPC operators, compromised dependencies/admins/frontends, MEV actors and abusive traffic.

| Threat | Required mitigation | Current state |
| --- | --- | --- |
| Invalid inputs / overflow | Strict schemas, integer base units, uint256 bounds, reject unknown fields | Implemented at quote boundary |
| Wrong chain / injected execution target | Testnet-only input; future chain handshake, contract registry, decoded calldata checks | Input gate and per-quote chain/bytecode checks; unsigned testnet preparation gated separately |
| SSRF / RPC credential theft | No caller-selected RPC URLs; outbound allowlist; secret-safe logs | Fixed QMS RPC; no caller URLs |
| Flooding / expensive route searches | Bounded body, IP limit, timeouts; edge limits, shared limiter, bounded route search | Local HTTP limits, RPC timeouts, four quote slots; shared limits pending |
| Stale/manipulated quotes | Block-bound data, expiry, refresh, independent validation, simulation | Pinned reads, reserve cross-check, block-age and reorg checks; sender-specific simulation in preparation |
| Venue substitution | Bind selection to quote and execution; never fallback silently | Quote binding and calldata checks in testnet preparation; wallet integration pending |
| Excess approvals / malicious spender | Verified spender, bounded approvals, explicit approval UX, tested permit handling if added | Quote binding and calldata checks in testnet preparation; wallet integration pending |
| Sandwiching / price movement | On-chain minimum output, deadline, impact warnings; assess private execution availability | Existing QWAP router enforces minimum output/deadline; own contracts absent; slippage limits cannot eliminate MEV |
| Reentrancy / token anomalies | Reviewed contracts, safe transfers, exact balance accounting, adversarial-token tests | Contracts not implemented |
| LP accounting / rounding exploits | Economic specification, fuzzing, invariants, independent review | AMM not selected |
| Reorgs / RPC inconsistency | Receipt tracking, confirmation policy, rollback/reconciliation | Not implemented |
| Admin compromise | Least privilege, multisig, timelocks, documented pause scope | No admin contracts |
| Frontend / supply-chain compromise | Lockfile, review, security scans, restricted CI permissions, build provenance, CSP | Lockfile and dependency audit only |
| Information leakage | No request-body logging, sanitized error responses, header redaction | Implemented baseline; deployment review still required |

Do not treat a simulated transaction as a guarantee: state can change before inclusion. Neither an audit nor a test suite proves absence of vulnerabilities. Update this model when adding adapters, approvals, permits, contracts or administrative privileges.
