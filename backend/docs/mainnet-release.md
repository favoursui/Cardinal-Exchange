# Mainnet release gates

All gates require recorded evidence, named reviewers and an explicit release decision. This is a checklist, not evidence of completion.

- [ ] Network parameters independently verified; RPC chain handshake and misconfiguration tests pass.
- [ ] Every venue/token has reviewed deployment addresses, bytecode/ABI provenance, permissions and documented unsupported behavior.
- [ ] Quotes preserve venue selection, reject stale data and enforce transaction parameters independently.
- [ ] Contract unit, fuzz, invariant and fork tests cover reserve/share accounting, rounding, access control, token failures, approvals, reentrancy and minimum-output/deadline enforcement.
- [ ] External contract audit covers the exact release commit and relevant integrations; findings remediated and retested. Material later changes receive review.
- [ ] API and frontend security review, dependency scanning, secret scanning and authenticated deployment pipeline are operational.
- [ ] CI runs reproducible install, strict typecheck, tests, production build, dependency policy and contract checks. Branch protections and reviewer ownership configured in the actual repository.
- [ ] Production ingress, TLS, restricted proxy trust, distributed rate limits, RPC quotas and timeout/load tests verified.
- [ ] Admin and fee powers documented; any multisig/timelock verified; emergency actions rehearsed and LP exit behavior checked.
- [ ] Release bytecode independently reproduced and verified against deployment, addresses published, initial liquidity and price settings reviewed.
- [ ] Monitoring covers RPC divergence, failed swaps, unusual approvals/admin actions, liquidity changes and error rates; alerts have accountable responders.
- [ ] Incident runbook includes disable-quoting controls, frontend notices, contract pause boundaries, communications, recovery and postmortem procedures.
- [ ] Vulnerability reporting channel and response ownership exist; phased launch limits and rollback/containment plan approved.

No mainnet deployment is authorized by passing testnet checks alone.
