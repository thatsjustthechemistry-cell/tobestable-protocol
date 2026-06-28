# TOBESTABLE — Self-Audit Report

**Target:** `programs/neco_token/src/lib.rs` (Anchor 0.32.1, pyth-solana-receiver-sdk 0.6.1, raydium-cp-swap CPI)
**Program ID:** `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`
**Method:** Multi-agent review — recon pass → 8 independent reviewers (one per vulnerability class) → 2 adversarial verifiers per finding (constraint-checker + exploit-prover) → synthesis. Key High findings additionally confirmed by hand against the source.

> ⚠️ This is a self-administered AI-assisted audit, **not** a substitute for a professional audit + fuzzing. It catches code-signature bug classes (missing constraints, signer/authority gaps, arithmetic, oracle handling, account substitution, CPI signing). It is weaker on deep economic game-theory and live cross-program edge cases. See "Coverage gaps".

## Status summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | `sell_to_vault` bricked — direct lamport debit on a System-owned PDA is rejected by the runtime; the $1 floor never executed | ✅ Fixed |
| 2 | High | `seed_pool` never reset `pool_sol_balance`, permanently bricking `flush_lp_to_raydium` after seeding | ✅ Fixed |
| 3 | High | `pause` only gated `mint_tobe`; fund-moving instructions ignored it | ✅ Fixed |
| 4 | High | `flush_lp_to_raydium` sandwichable — deposited at attacker-skewed pool ratio with no slippage bound | ✅ Fixed (slippage param + max-pull cap) |
| 5 | Medium | Pyth 60s staleness window enabled price-selection timing arbitrage | ✅ Fixed (→15s) |
| 6 | Medium | `flush` decremented `vault_balance` by a pre-CPI estimate, drifting from the real token balance | ✅ Fixed (measured delta) |
| 7 | Medium | `set_pool_config` could capture the 30%-floor baseline pre-seed, soft-locking `flush` | ✅ Fixed (ordering documented; `pool_seeded` gate reverted — it broke the fair-launch flow, which never calls `seed_pool`) |
| 8 | Low | `set_pool_config` recorded unchecked Raydium account keys | ⚠️ Partially fixed (pool_state now validated; vault cross-binding deferred) |
| 9 | Low | `tobe_to_pair` unconditional `+1` could trip the floor guard by 1 unit | ➖ Mitigated/accepted (measured decrement makes it a harmless conservative buffer) |
| 10 | Low | Pyth confidence check passed when `conf == 0` | ✅ Fixed |
| 11 | Info | `lp_receipt` PDA never closed after burn (stranded rent) | ✅ Fixed |
| 12 | Info | `migrate_state_v2` reads authority from a hardcoded byte offset (latent fragility) | ➖ Accepted (not on fresh-deploy path; one-time migration) |
| 13 | Info | Dead `src/lib_sol.rs` reference file | ✅ Fixed (deleted) |

## Rejected by verification (not real)
- **"`seed_pool` can send vault TOBE to an arbitrary account"** — `seed_pool` is authority-gated and the Solana runtime prevents a mint mismatch.
- **"`flush` breaks on a Token-2022 LP mint"** — the pinned `raydium-cp-swap` always creates legacy-Token LP mints.

## Fix details

**#1 — `sell_to_vault` floor bricked.** `vault_sol_reserve` is owned by the System program (only ever funded via `system_program::transfer`), so paying sellers via `try_borrow_mut_lamports` was rejected (a program may not debit an account it doesn't own). Replaced with a PDA-signed `system_program::transfer`, matching the pattern `seed_pool`/`flush` already use for `pool_sol_reserve`.

**#2 — `seed_pool` desync.** `seed_pool` drains the physical `pool_sol_reserve` but left the logical `pool_sol_balance` ~5 SOL ahead, so every later `flush` tried to move more SOL than existed. Now zeroes `pool_sol_balance`.

**#3 — pause coverage.** Added `require!(!paused)` to `buy_from_vault`, `sell_to_vault`, `seed_pool`, `flush_lp_to_raydium`.

**#4 — flush sandwich.** Added a `max_tobe_to_pair` argument; reverts if the live-ratio-derived TOBE exceeds it and caps the Raydium max-token pull at that bound. Keepers compute the bound from current reserves + tolerance (devnet caller updated). Residual: a caller willing to run their own keeper and set a high bound can still self-sandwich — that is a permissionless-MEV property, not an exploit of honest callers.

**#5/#10 — Pyth.** Staleness 60s→15s; reject `conf == 0`.

**#6 — accounting.** `vault_balance` now decremented by the measured TOBE delta (snapshot before / `reload()` after the CPI).

**#7 — ordering.** Initially gated `set_pool_config` on `pool_seeded`, but that broke the chosen fair-launch flow (the pool is created externally and `seed_pool` is never called, so `pool_seeded` stays false and `set_pool_config` would revert). Reverted the gate; `vault_tobe_at_config` is captured from the current `vault_balance` at config time (correct for fair launch). Documented in-code that the optional `seed_pool` path must run before `set_pool_config`.

**#8 — pool config.** `raydium_pool_state` typed as `AccountLoader<PoolState>` (enforces Raydium ownership). Residual: recorded `token_0/1_vault` keys are not cross-derived from `pool_state` (authority-trust; recommended follow-up before relying on third-party flush integrity).

**#11/#13 — housekeeping.** `lp_receipt` closed after burn; dead `lib_sol.rs` deleted and stale header fixed.

## Coverage gaps (must address before mainnet)
- **`cpi-token` vulnerability class was not reviewed** — the reviewer for CPI reentrancy, Raydium CPI account injection, mint-authority abuse, and LP-burn correctness was cut off by a session limit. **Re-run that class.**
- Adversarial verifiers for findings #4/#6/#7/#9 were also cut off; #4 was confirmed by hand, #6/#7 stand on reviewer analysis + author review.
- No fuzzing / property testing was performed. The Pyth math has unit tests (`pyth_math_tests`); the vault/flush state machine does not.

## Post-audit hardening: $1 floor activation latch

Beyond the audit findings, a design change was added to cut the **largest early
abuse vector** — the gap between mint cost (~$0.0036/TOBE early) and the $1 floor,
which made `sell_to_vault` a ~275x below-peg drain before TOBE ever legitimately
reached $1.

**Mechanism.** New one-way state flag `floor_active` (default `false`). `sell_to_vault`
now requires `floor_active == true`. A new permissionless instruction `arm_floor`
sets it true the first time TOBE's market price reaches $1, where TOBE/USD is
derived from the Raydium pool reserves × the Pyth SOL/USD price (reusing the
audited `lamports_to_tobe_at_one_usd` helper). Once armed it stays armed forever.

**Effect.** Before TOBE first hits $1, the floor cannot be used at all, so the
early below-peg drain is impossible. After it arms, the floor behaves as the
(still reserve-bounded) backstop described above.

**Known limitation.** `arm_floor` reads the pool's **spot** reserves, which are
manipulable. Early on this is self-limiting (pushing the pool to $1 costs far more
than the tiny reserve yields), and the read vaults are constrained to the recorded
pool config. It is **not** a TWAP — a determined actor could spike the spot price
to arm the latch once. A future hardening could require a time-averaged price.

## Focused CPI / token / mint / reentrancy re-audit (round 2)

After the fixes above (which changed the CPI surface), a second focused audit
covered the class the first run never reached. Result: **no Critical/High** on
the CPI/token/mint surface — `mint_to` authority gating, the Raydium deposit CPI
account set + signer seeds, the LP burn, PDA-signed system transfers, and the
TOBE-side measured-delta accounting all verified sound. One **Medium** confirmed
and fixed:

**CPI-1 (Medium, fixed): `flush_lp_to_raydium` leaked unconsumed wrapped-SOL to
the caller.** The TOBE side of the deposit is reconciled by a measured
before/after delta, but the SOL side was not. Flush wraps the entire
`pool_sol_balance` into `wsol_temp`, yet Raydium consumes SOL from the
fee-EXCLUDED (net) vault while `target_lp` is sized from the raw vault — so on a
fee-bearing pool a sliver of wSOL is left unconsumed. `close_account` sent
`wsol_temp` to the permissionless `caller`, and `pool_sol_balance = 0` dropped it
from accounting, letting a bot collect protocol SOL each flush (bounded by the
pool's accrued-fee ratio).
*Fix:* reload `wsol_temp` after the deposit, close it to `pool_sol_reserve`
(protocol PDA) instead of `caller`, and set `pool_sol_balance` to the measured
residual so it rolls forward — mirroring the TOBE-side reconciliation.

## Recommended follow-ups
1. Re-run the `cpi-token` reviewer + a focused review of the Raydium CPI account set.
2. Cross-derive `token_0/1_vault` from `pool_state` in `set_pool_config` (completes #8).
3. Add integration tests for the now-fixed `sell_to_vault` floor and post-seed `flush`.
4. Consider a free static pass (Sec3 X-Ray, `cargo-audit`) and community review before launch.
