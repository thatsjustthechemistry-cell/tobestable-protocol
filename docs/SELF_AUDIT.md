# TOBESTABLE — Self-Audit Report

**Target:** `programs/neco_token/src/lib.rs` (Anchor 0.32.1, pyth-solana-receiver-sdk 0.6.1, raydium-cp-swap CPI)
**Program ID:** `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`
**Method:** Multi-agent review — recon pass → 8 independent reviewers (one per vulnerability class) → 2 adversarial verifiers per finding (constraint-checker + exploit-prover) → synthesis. Key High findings additionally confirmed by hand against the source.

> ⚠️ This is a self-administered AI-assisted audit, **not** a substitute for a professional audit + fuzzing. It catches code-signature bug classes (missing constraints, signer/authority gaps, arithmetic, oracle handling, account substitution, CPI signing). It is weaker on deep economic game-theory and live cross-program edge cases. See "Coverage gaps".

## 🔴 Scope boundary — code added AFTER this audit (read first)

**This report covers `lib.rs` as of commit `caf19de` (2026-07-02).** Everything below that line landed *afterwards* and is **not covered by any round of this audit**:

| Commit | Change | Touches money? |
|---|---|---|
| `29e75bc` | `buy_from_vault` proceeds split 50/50 (DAO treasury / founder) | **Yes** — adds two `system_program::transfer` calls |
| `b47fc54` | `referral` — optional referrer logged via `msg!` | No (instruction data only, no amounts) |
| `03ee3a5` | Disclosed team allocation — free mints, new immutable state fields | **Yes** — branches around the 10 SOL payment |
| `96e365a` | Team free-mint cap 16 → 8 | Constant only |
| `3cdcd65` | `arm_floor` arming math extracted for unit tests (behaviour-identical) | No |

That is **~201 added lines** in the core program, including two paths that move real SOL. Anyone relying on this report should know it does **not** describe the program that is being shipped.

**What has been done on that delta instead (weaker assurance — do not read as an audit):**
- **Round 5 (2026-07-18)** — a focused adversarial pass over the delta. It found **one Medium** (`F1`: founder self-dealing via `buy_from_vault`, unbounded by any vault floor) and **one Low** (`F2`: no price gate on `buy_from_vault`). See "Round 5" below. An earlier, shallower pass the same day reported "no exploitable defect" — that was **wrong**, and is corrected here: it only looked for missing constraints, and F1 is an economic/design flaw with every constraint correctly in place.
- **Round 6 (2026-07-26)** — covered `1a68251` (the monotonic floor baseline), which landed *after* Round 5 and is a change to the F1 mitigation itself. Found **one High (`H2`)**: a `buy_from_vault` → `sell_to_vault` round trip drained `vault_sol_reserve` without limit. **Now closed** — the founder cut is paid only on new net vault depletion, so round trips earn nothing while genuine arbitrage earns the full 50% uncapped. See the notice immediately below. `L1` (Low) remains open.
- The `arm_floor` peg-boundary math has Rust unit tests running in CI (`pyth_math_tests::arm_gate_*`).
- The mocha integration suite now **passes 35/35** and is a required CI check (it had never been executed at all before 2026-07-18). As of 2026-07-19 it covers **every instruction**, including this delta: CI clones mainnet Raydium + the Pyth receiver + Wormhole into the local validator, creates a real TOBE/wSOL pool, and exercises `set_pool_config`, the `buy_from_vault` price gate (F2) and the `arm_floor` authority gate (H1). ⚠️ Coverage is not correctness: these assert the gates *fire*, not that the economic design is sound. Green CI is still not an audit.

## ✅ H2 (Round 6) — CLOSED: founder cut paid only on NEW net vault depletion

**Fixed 2026-07-26.** `buy_from_vault` now pays the founder's nominal 50% **only on the
portion of a buy that takes the vault to a new net-depletion high.**

Net depletion is `total_minted / 2` (the monotonic "what the vault would hold had
nothing ever left" baseline the floor already uses) minus the current balance.
`max_vault_depletion` is its high-water mark. The founder is paid pro-rata on ground
beyond that mark only:

* **A round trip returns the TOBE**, so the vault comes back to a level the mark already
  covers. The next buy breaks no new ground → **cut is 0**. This holds in both
  directions (buy→sell and sell→buy) and however many times it is repeated.
* **Genuine net demand** pushes the vault to a new low → the founder earns the full 50%
  on the incremental portion, **uncapped**.

It also correctly pays nothing when the vault re-sells TOBE it bought back through the
floor: the protocol spent reserve SOL acquiring those tokens, so paying a cut to re-sell
them would make the protocol net-negative on a wash.

Whatever the founder does not earn is reassigned to `dao_cut`, so the buyer always pays
exactly `sol_in_lamports`. New state fields `max_vault_depletion` (the mark) and
`founder_cut_paid` (telemetry). Not a wire-format change — the `founder` account stays
required on `BuyFromVault`.

**Why not a cumulative cap.** A cap was implemented first and then replaced. It bounded
the leak, but it was denominated in mint revenue (~10,160 SOL at full mint), while
legitimate founder revenue scales with *arbitrage volume*, which is unbounded by it — up
to ~$94M if the vault sells its full extractable 188M TOBE at $1. Any cap large enough
to accommodate that would exceed the entire floor reserve by ~250×, i.e. provide no
protection at all. **The cap could not separate self-dealing from other people's
arbitrage, so it capped both.** The high-water mark separates them structurally: round
trips do not deplete the vault, real demand does.

Unit-tested in CI (23 passing), including `h2_round_trip_earns_the_founder_nothing`
(1,000 repeated cycles, all earning 0), the reverse-order variant, pro-rata partial
credit, and that genuine sequential demand earns the full half every time.

**Two fixes that were considered and rejected as ineffective** — recorded because both
are intuitive and both are wrong:

* **A spread on `sell_to_vault`.** The founder's effective purchase price is already
  half face value, so the spread would have to exceed **50%** to make the round trip
  unprofitable — i.e. a "$1 floor" paying $0.50, which is not a floor. A 1% spread cuts
  the per-cycle profit from 50% to 49%.
* **Timelocking / escrowing `founder_cut`.** Delaying the payout does not change the
  protocol's net position: buy at full price, sell back at par, break even, and collect
  the accrued cut later. Same extraction, same reserve drain, later settlement. (It does
  address same-transaction *capital efficiency*, which is not what H2 depends on.)

The original finding follows, unedited.

## 🔴 H2 AS FOUND — Round 6, 2026-07-26 (now bounded, see above)

**`buy_from_vault` → `sell_to_vault` is a profitable round trip for the founder that
drains `vault_sol_reserve` without limit.** The 30% vault floor does not stop it: the
round trip returns the TOBE, so `vault_balance` is restored and the floor is never
reached, while the reserve — which has no floor of its own — loses the full cycle
amount. Net +50% of the cycled SOL to the founder, repeatable until the reserve is
empty, after which the $1 floor stops working for everyone.

Requires only the ordinary post-launch state (`floor_active` armed at Step 11, TOBE ≥ $1)
and one cycle's worth of working capital. Exploitable **only** by the holder of
`mint_state.founder`; value-neutral for anyone else.

**This is not the disclosed F1 residual.** F1 is a bounded discount on TOBE the founder
*keeps and pays for*. H2 extracts SOL, bypasses the 70% bound rather than approaching it,
and is unbounded. **Status: open, no fix applied.** Full analysis, worked example and fix
options in [Round 6](#round-6-opus-5-adversarial-pass-on-the-post-round-5-delta-2026-07-26).

**Recommendation before mainnet:** get a **focused paid review of this delta**. Two independent reasons, both from this codebase's own history: Round 1 *rejected* the M1 `seed_pool` finding as a non-issue and Round 4 found it was real; and on 2026-07-18 a shallow pass cleared `buy_from_vault` before a deeper pass the same day found **F1** (Medium). Self-administered passes here have now missed a genuine issue **twice**.

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

> ⚠️ **SUPERSEDED BY ROUND 4 (H1) — read this first.** The section below describes
> `arm_floor` as it stood after Round 2, when it was **permissionless**. Round 4
> re-rated exactly that as **High** and the shipped program now makes `arm_floor`
> **authority-only** (a 2-of-3 council multisig), with the spot-price check retained
> only as a *secondary* guard. The "Known limitation" paragraph below was likewise
> an *accepted* risk at Round 2 and is **no longer accepted** — it is the finding.
> See [Round 4 → H1](#round-4-fable-5-adversarial-audit-2-findings-fixed). This text
> is kept as a historical record of the reasoning, not as a description of the
> program being shipped.

**Mechanism.** New one-way state flag `floor_active` (default `false`). `sell_to_vault`
now requires `floor_active == true`. A new permissionless instruction `arm_floor`
sets it true the first time TOBE's market price reaches $1, where TOBE/USD is
derived from the Raydium pool reserves × the Pyth SOL/USD price (reusing the
audited `lamports_to_tobe_at_one_usd` helper). Once armed it stays armed forever.

**Effect.** Before TOBE first hits $1, the floor cannot be used at all, so the
early below-peg drain is impossible. After it arms, the floor behaves as the
(still reserve-bounded) backstop described above.

**Known limitation** *(Round 2's position — **rejected by Round 4**, see H1).*
`arm_floor` reads the pool's **spot** reserves, which are
manipulable. Early on this is self-limiting (pushing the pool to $1 costs far more
than the tiny reserve yields), and the read vaults are constrained to the recorded
pool config. It is **not** a TWAP — a determined actor could spike the spot price
to arm the latch once. A future hardening could require a time-averaged price.

> ⚠️ **Round 4 overturned the "self-limiting" argument above.** It is an *unenforced
> assumption about pool depth*, while `vault_sol_reserve` grows a fixed 5 SOL/round
> regardless of pool depth — so if flushes lag or the pool is thin, arming can cost
> less than the reserve it unlocks, and that reserve is real user deposits. The fix
> was not a TWAP but an authority gate: `arm_floor` is now **authority-only**.

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

## Final pre-launch re-audit (round 3)

A full re-audit of the post-fix code (5 reviewers + adversarial verification)
confirmed **all prior fixes are correct and complete, with no regressions**, and
**no Critical/High** issues. The flush SOL/TOBE reconciliation, the seed_pool
counter reset, the pause gating, the floor latch, and the Pyth hardening were all
independently verified sound. Four residual items, three fixed here:

**RA-1 (Medium, fixed): unprotected initializer.** `initialize` set
`authority` + `treasury` from caller args with no binding to the deployer, so it
could be front-run in the deploy window (whoever lands `initialize` first owns the
program + treasury).
*Fix:* `Initialize` now requires the signer to be the program's **upgrade
authority** (`program_data.upgrade_authority_address == authority`), closing the
window entirely. Init scripts + the localnet test pass the `program`/`program_data`
accounts.

**RA-3 / RA-4 (Low/Info, fixed): unvalidated pool config.** `set_pool_config`
recorded the Raydium vaults / lp_mint from `UncheckedAccount`s without proving
they belong to the typed `pool_state`, and `arm_floor`'s price math assumed both
pool legs are 9-decimal without enforcing it.
*Fix:* `set_pool_config` now cross-checks the vaults + lp_mint against the loaded
`PoolState`, and requires both legs to be 9-decimal and to be exactly TOBE and
native wSOL. This makes the floor-price source sound by construction and removes
the config-typo DoS risk.

**RA-2 (Low, accepted): wsol_temp rent dust.** Each flush strands ~0.002 SOL of
`wsol_temp` rent in `pool_sol_reserve` (it ends up in the protocol's own reserve,
just not injected into LP). Benign and in the *safe* direction (physical reserve
≥ logical `pool_sol_balance` always holds — no overdraw). Left as-is rather than
modify audited-correct flush accounting for protocol-owned dust.

## Recommended follow-ups
1. Re-run the `cpi-token` reviewer + a focused review of the Raydium CPI account set.
2. Cross-derive `token_0/1_vault` from `pool_state` in `set_pool_config` (completes #8).
3. Add integration tests for the now-fixed `sell_to_vault` floor and post-seed `flush`.
4. ✅ **`cargo-audit` run 2026-07-19 — 0 vulnerabilities.** Five advisory warnings, all transitive from the Solana/Anchor toolchain and none reaching the deployed program: `bincode` + `libsecp256k1` (unmaintained, no CVE; the program never uses secp256k1), `anyhow` (unsound `downcast_mut()`, host-side tooling only), and `rand` 0.7/0.8 (unsound with a custom logger — BPF has no entropy source, so not on the program path). This checks the dependency tree against the RustSec advisory DB; it says nothing about whether the program *logic* is correct, which is what an audit does. Community review remains unactioned.
5. ✅ **Sec3 X-Ray v0.0.6 run 2026-07-19 — 4 findings, all false positives.** The open-source static analyzer (`ghcr.io/sec3-product/x-ray`, container version) enumerated **17 attack surfaces — every instruction in the program** — and reported: `IntegerAddOverflow` on `mint_state.current_round += 1` (L280); `UnvalidatedAccount` on `pyth_price_update` in both `BuyFromVault` (L1357) and `SellToVault` (L1389); and `MissingSignerCheck` on `raydium_pool_authority` in `FlushLpToRaydium` (L1520). **All four checked against the source and rejected:** `current_round` is `u64` guarded by `require!(current_round < MAX_ROUNDS)` (1024) two statements earlier, and `[profile.release]` sets `overflow-checks = true`, so the increment can neither reach nor silently wrap; the Pyth accounts are `Account<'info, PriceUpdateV2>` (Anchor enforces owner = Pyth receiver + deserialization) with feed identity, staleness and confidence-width all validated inside `read_sol_usd_price`; and `raydium_pool_authority` is Raydium's own PDA, address-pinned to `mint_state` by constraint and structurally *unable* to sign — Raydium signs for it inside the CPI, so a signer check would make the instruction permanently uncallable. **Single common cause:** X-Ray reasons over the `#[derive(Accounts)]` struct and does not follow validation into function bodies, so "validated in a helper" and "not validated" look identical to it. ⚠️ **This run does not bear on F1 and does not supersede the paid review recommended above.** X-Ray analyzed `buy_from_vault` and `sell_to_vault` directly and surfaced only the two Pyth false positives — a static pattern matcher has no way to represent "the founder's 50% cut halves their break-even, making it profitable to drain the vault." It rules out one bug *class*; it says nothing about economic design.

---

## Round 4: Fable 5 adversarial audit (2 findings fixed)

A fresh independent audit (Claude Fable 5, whole-program read + adversarial verification) surfaced two issues. Both are now fixed.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| H1 | **High** | `arm_floor` was permissionless and gated the floor on a **manipulable pool SPOT ratio**. An attacker could flash-skew the pool across $1, latch `floor_active = true` permanently, then drain `vault_sol_reserve` via cheap-mint → `sell_to_vault` at $1. | ✅ Fixed |
| M1 | **Medium** | `seed_pool` moved round-1 vault TOBE + the entire `pool_sol_reserve` to an **unconstrained destination** — an authority fund-movement primitive, not a pool-seed-only path. | ✅ Fixed (removed) |

**H1 — arm_floor spot manipulation.** Round 2's "Known limitation" note accepted the spot-price manipulability as tolerable ("self-limiting early on"). Round 4 re-rated it **High**: the self-limiting argument is an *unenforced assumption about pool depth*, while `vault_sol_reserve` grows a fixed 5 SOL/round independent of pool depth — so if flushes lag or the pool is thin, arming can be cheaper than the reserve it unlocks, and the reserve is real user deposits.
*Fix:* `arm_floor` is now **authority-only** (a 2-of-3 council multisig after migration). The on-chain spot check is retained as a *secondary* guard; the human/multisig confirms TOBE genuinely reached $1 (off-chain TWAP) before arming. This removes the permissionless flash-manipulation path entirely.

**M1 — seed_pool unconstrained destination.** ⚠️ **Correction to the record:** Round 1's "Rejected by verification" section dismissed *"seed_pool can send vault TOBE to an arbitrary account"* as not real, reasoning that "the runtime prevents a mint mismatch." That reasoning was **incomplete** — the runtime enforces the *mint* of `pool_tobe_destination` (must be TOBE) but **not its owner**, so the authority could still direct round-1 vault TOBE to any TOBE account it controls, plus sweep the whole `pool_sol_reserve` to itself. The concern was real; the earlier rejection stands corrected.
*Fix:* `seed_pool` and its `SeedPool` account struct were **removed** entirely. It was legacy and unused by the fair-launch flow (the community creates the pool externally; ongoing liquidity uses `flush_lp_to_raydium`), so removal eliminates the primitive with no functional loss. The vestigial `pool_seeded` field is retained (never read) to keep the on-chain account layout stable for already-migrated devnet state.

**Verification:** `anchor build` passes clean after both changes. `arm-floor.js`, the launch runbook (Step 11), SECURITY.md, README.md, and the test suite were updated; the two `seed_pool` tests were removed.

---

## Round 5: post-delta adversarial pass (2026-07-18)

Scope: the ~201 lines added after `caf19de` (founder revenue split, referral, team
allocation, cap 16→8, `arm_floor` math extraction). See "Scope boundary" at the top.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | **Medium** | `buy_from_vault` lets the **founder buy vault TOBE at a 50% discount**, unbounded by any vault floor | ⚠️ **Mitigated, not eliminated** — see "F1 fix" |
| F2 | Low→**Medium** | `buy_from_vault` had **no price gate** despite the site/FAQ/announcement all stating it is active only "when TOBE trades at or above $1" | ✅ Fixed |

**F2 was re-rated on review.** It was initially filed Low as "self-limiting for honest
buyers." That underweighted the real problem: user-facing copy in three places asserted a
gate the contract did not implement. Below peg the vault would hand over an asset worth
less than $1 and book $1 — value destruction — and the founder, getting 50% back, breaks
even at $0.50 and so *profits* from exactly that. F1 and F2 compounded.

**F2 fix.** `buy_from_vault` now requires TOBE ≥ $1, derived from the pool reserves ×
Pyth SOL/USD via the same audited `tobe_at_or_above_one_usd` helper `arm_floor` uses. The
pool vaults are constrained to the recorded pool config, so the read cannot be spoofed
with unrelated token accounts. Above $1 behaviour is unchanged — selling vault TOBE at $1
*is* the ceiling working, and the founder still earns the disclosed 50% on it. Requires
two added accounts on `BuyFromVault` (wire-format change; `devnet-buy-from-vault.js`
updated).

### F1 fix — what it does and does NOT do

**Applied:** `buy_from_vault` now enforces the same 30% vault floor that has always
guarded `flush_lp_to_raydium`, and additionally requires the pool to be configured
(the floor baseline `vault_tobe_at_config` is 0 until `set_pool_config` runs, so
without this the floor would be 0 in that window and permit a full drain). Both
call sites now share one tested helper, `vault_withdrawal_within_floor`, so a
security-critical bound cannot drift between two copies. Unit-tested in CI
(`pyth_math_tests::vault_floor_*`).

### ⚠️ Correction (same day): the first F1 fix did not bound what it claimed

The initial mitigation reused `flush_lp_to_raydium`'s existing floor, which is
anchored to `vault_tobe_at_config` — a snapshot of the vault balance taken **once**
at `set_pool_config` and never updated (`set_pool_config` is one-shot). The vault
keeps growing with every mint while that baseline stays frozen, so the floor decays
from a percentage into a rounding error:

| Config at round | Floor (fixed) | Vault @ r1024 | Actually extractable |
|---|---|---|---|
| 20 | 3.12M | 268.7M | **98.8%** |
| 100 | 14.97M | 268.7M | 94.4% |

The runbook configures the pool at Step 9, immediately after launch — the worst
case. "Bounded to 70%" was wrong; it was closer to unbounded.

**Anchoring to the current balance would have been worse still** — it is
*ratchetable*: each withdrawal lowers the balance and therefore the next floor
(1000 → 300 → 90 → 27 → …), draining to zero by repetition rather than in one go.

**Fix:** `buy_from_vault` now anchors to `total_minted / 2` — what the vault would
hold had nothing ever been withdrawn. `total_minted` is monotonic, so the floor
only ever rises and no sequence of withdrawals can lower it. This is a true
cumulative bound, and the protected share holds at exactly 30% at every scale:

| Round | Vault | Old floor | New floor | Old extractable | New extractable |
|---|---|---|---|---|---|
| 100 | 49.9M | 3.12M | 14.97M | 93.8% | **70.0%** |
| 500 | 198.3M | 3.12M | 59.48M | 98.4% | **70.0%** |
| 1024 | 268.7M | 3.12M | 80.61M | 98.8% | **70.0%** |

`flush_lp_to_raydium` deliberately keeps the snapshot baseline: it converts vault
TOBE into Raydium liquidity whose LP receipt is **burned**, so nothing leaves the
protocol. Tightening it would throttle LP injection to prevent a "drain" that is
not one. That asymmetry is documented at both call sites; re-audit it if `flush`
ever gains a caller-chosen recipient.

Unit-tested in CI: `vault_floor_monotonic_baseline_cannot_be_ratcheted_down` pins
the ratchet failure, `vault_floor_rises_as_minting_continues` pins the 30% share
across scales (15 tests passing).

**Residual — F1 is still mitigated, not closed.** The floor bounds how much TOBE can
leave the vault at 70%, and it does not remove the discount: the founder can acquire
that 70% at an effective 50% off. Closing it fully requires a change to the fee
*model* (timelocked or DAO-held `founder_cut`), which the founder has reviewed and
declined — the 50/50 split is disclosed and retained.

> 🔴 **THE PARAGRAPH ABOVE IS NO LONGER ACCURATE IN TWO WAYS. Read both.**
>
> **1. It never bounded total extraction (Round 6, H2).** An earlier version claimed
> the floor "genuinely bounds extraction at 70% of the vault". True of **TOBE**, false
> of the **protocol**: a `buy_from_vault` → `sell_to_vault` round trip returns the TOBE,
> so `vault_balance` is restored, this floor never binds, and `vault_sol_reserve` is
> drained by the full cycle amount. **Now closed** — the founder cut is paid only on new
> net vault depletion, so round trips earn nothing. See
> [Round 6](#round-6-opus-5-adversarial-pass-on-the-post-round-5-delta-2026-07-26).
>
> **2. The 70% bound no longer exists at all (2026-07-26, founder decision).** The 30%
> floor was **removed from `buy_from_vault`**. It only ever bound after ~188M TOBE had
> been sold at $1, and at exactly that point it began refusing genuine buyers — breaking
> the $1 ceiling upward anyway, while reserving 30% that could never be used for the
> purpose it was held for. **F1 is therefore now UNBOUNDED on this path: the founder can
> acquire the ENTIRE vault at an effective 50% off, not merely 70% of it.**
>
> Accepted knowingly, alongside one further consequence: **`flush_lp_to_raydium` can be
> starved.** It pairs `pool_sol_reserve` SOL with vault TOBE, nothing else consumes that
> reserve, so SOL accumulated after the vault falls below flush's own floor is stranded
> with no instruction able to release it. Previously the buy floor (30% of the *growing*
> `total_minted / 2`) sat well above flush's floor (30% of the *early*
> `vault_tobe_at_config` snapshot) and shielded flush as a side effect. That shield is
> gone. `flush_lp_to_raydium` **keeps** its own floor — load-bearing there, not a policy
> choice.
>
> ✅ **NOT a consequence — a claim first written here and then corrected.** An earlier
> version of this note listed "the $1 ceiling is now exhaustible" as a cost. That was
> **wrong**. The ceiling was *always* exhaustible — it works only while the vault holds
> TOBE to sell, floor or no floor. The floor made it exhaust **earlier**, at 70%
> depletion, reserving a final 30% that could never be spent on the very thing it was
> held for. **Removing the floor extends ceiling capacity from ~188M to the full ~268.7M
> TOBE.** On this axis the change is an improvement, not a cost.

What the **F2 price gate** additionally removes is the *value-destroying* half of
this: the founder can no longer do it while TOBE trades below $1, which was the
range where the protocol handed over an asset worth less than it booked. What
remains is the founder capturing their disclosed 50% fee while also being the
counterparty, in the range (≥ $1) where vault selling is the intended ceiling
behaviour. That is an economic advantage, not value destruction — but it is still
not what the public copy describes, which frames the cut as a fee on *other
people's* arbitrage.

Fully closing F1 requires a change to the fee *model*, not another bound — e.g.
routing `founder_cut` to a timelocked/DAO-controlled account so it cannot be
recycled within the same transaction, or not paying the cut when the buyer is the
founder (noting a bare `buyer != founder` check is bypassable with a second
wallet, so this only works combined with the timelock).

**The disclosure gap is also still open.** Public copy still frames the founder cut
as a fee on other people's arbitrage and does not mention that the founder can be
the buyer at half price.

### F1 — Founder self-dealing via `buy_from_vault` (Medium)

Two facts combine:

1. **Nothing prevents `buyer == founder`.** `BuyFromVault.founder` is constrained only
   to equal `mint_state.founder`; no constraint requires it to differ from `buyer`.
2. **The 30% vault floor does not apply here.** `VaultFloorBreach` is enforced only in
   `flush_lp_to_raydium`. `buy_from_vault` is bounded solely by
   `tobe_out <= mint_state.vault_balance` — i.e. drainable to zero.

When the founder is the buyer, `founder_cut` is a transfer to themselves, so their net
cost is only `dao_cut`:

| | Normal buyer | Founder as buyer |
|---|---|---|
| Pays | X SOL | X SOL, of which X/2 returns to self |
| **Net cost** | **X** | **X/2** |
| Receives | TOBE worth X at $1 | TOBE worth X at $1 |
| **Break-even market price** | **$1.00** | **$0.50** |

**Impact.** The founder can acquire protocol-owned vault TOBE at a 50% discount, at any
time, up to the entire vault balance (50% of all TOBE ever minted). Because their
break-even is $0.50, it is profitable for them to drain vault TOBE while the market sits
between $0.50 and $1.00 — precisely the range where the protocol sells its own reserve
below peg. That reserve is what backs the $1 ceiling, so the mechanism the peg story
rests on can be depleted by the party who profits from depleting it.

**This is not a missing-constraint bug** — every account constraint is correct. It is an
economic/design consequence of paying a 50% fee to a party who may also be the
counterparty. Note that a shallower pass earlier the same day cleared this code precisely
because it was looking for constraint gaps.

**Disclosure gap.** Public copy frames the founder cut as a fee on *other people's*
arbitrage ("when someone buys vault TOBE at $1, the incoming SOL is split 50/50"). The
founder's ability to *be* that someone, at half price, is not stated anywhere.

**Recommended fixes** (in order of robustness):
1. **Apply the existing 30% vault floor to `buy_from_vault`.** Smallest change, bounds
   total extraction by *anyone*, and reuses a mechanism already in the codebase.
2. Route the founder cut to a timelocked or DAO-controlled account so it cannot be
   recycled into the same transaction's economics.
3. Disclose the self-purchase capability plainly if it is retained.

⚠️ A naive `require!(buyer.key() != founder.key())` is **not** an adequate fix on its own —
it is trivially bypassed with a second wallet. Prefer (1).

### F2 — No price gate on `buy_from_vault` (Low)

The docs, site and announcement all describe this as an above-$1 mechanism ("Above $1,
anyone can buy TOBE from the protocol vault at exactly $1"). The code never checks the
market price: it computes `tobe_out` from `sol_in` at $1 and checks only vault balance.

For a normal buyer this is self-limiting (buying at $1 below peg loses money), so the
direct risk is low. It matters because it is the enabling condition for F1's below-peg
profit window. Fixing F2 alone does **not** fix F1 — at exactly $1 the founder still pays
an effective $0.50.

### Checked and clean this round

~~`sell_to_vault` (no founder cut, no symmetric issue)~~ — 🔴 **this clearance was
wrong, see Round 6 / H2.** `sell_to_vault` is clean *in isolation*, which is what was
checked. Paired with `buy_from_vault` it completes a profitable round trip that drains
`vault_sol_reserve`. This entry is left in place rather than deleted: this round wrote
down "compound vulnerabilities are a blind spot of checklist-style review" and then, on
the same page, cleared an instruction by examining it alone. · team free-mint path (signer-gated
via `minter: Signer`, `checked_add`, hard cap, tokens can't be redirected —
`minter_tobe.owner == minter.key()`) · referral (instruction data only, no amount effect,
self-referral rejected) · split arithmetic (exact; odd lamport to the DAO) · destination
substitution, i.e. the M1 class (blocked — `treasury`/`founder` both constrained and typed
`SystemAccount`) · `MintState` sizing (`InitSpace`, append-only fields) · `update_founder`
(authority-gated, rejects the zero pubkey) · round-counter overflow (guarded by
`current_round < MAX_ROUNDS`) · reentrancy (no callback surface in the SPL token CPIs).

### Standing recommendation

This round was again AI-assisted and self-administered. It found a Medium that an earlier
pass in the same session missed, which is itself evidence about the method's variance. A
**focused paid review of this delta** remains recommended — F1 is exactly the class of
issue (economic, not syntactic) where an independent professional reviewer earns their fee.

---

## Round 6: Opus 5 adversarial pass on the post-Round-5 delta (2026-07-26)

**Scope.** Commit `1a68251` (the monotonic floor baseline), which landed *after* the
Round 5 fix commit `04556a2` and had therefore never been audited — it is a change to
the F1 mitigation itself. Plus `buy_from_vault` reviewed as a whole, since it was
modified three times on 2026-07-18 (F1 floor → F2 price gate → monotonic anchor) and
never reviewed as a combined unit. Aimed deliberately at **compound** vulnerabilities,
the blind spot Round 5 documented.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| H2 | **High** | `buy_from_vault` → `sell_to_vault` round trip drains `vault_sol_reserve`, unbounded and repeatable; the 30% TOBE floor never binds | ✅ **Closed** — founder cut paid only on new net vault depletion |
| L1 | Low | Net selling raises `vault_balance` without raising `total_minted`, so the floor protects less than 30% of the *actual* balance | 🔴 Open |

### H2 — Round-trip drain of `vault_sol_reserve` (High)

The monotonic floor bounds **TOBE leaving the vault**. Nothing bounds **SOL leaving the
reserve**, and a round trip puts the TOBE back — so the floor is never reached.

**Preconditions:** `floor_active == true` (Step 11, council-armed 2-of-3) and TOBE ≥ $1.
Both are ordinary expected states, not attack conditions.

| Step | Founder's SOL | `vault_balance` | `vault_sol_reserve` |
|---|---|---|---|
| `buy_from_vault(X)` | −X, then +X/2 (`founder_cut`) | −`tobe_out` | — |
| `sell_to_vault(tobe_out)` | +X (paid out at $1) | **+`tobe_out` → restored** | **−X** |
| **Net per cycle** | **+X/2** | **unchanged** | **−X** |

Because `vault_balance` returns to its pre-cycle value, the floor check
(`vault_withdrawal_within_floor(vault_balance, total_minted / 2, tobe_out)`) evaluates
identically on the next iteration. **The cycle repeats without limit.** The only
stopping condition anywhere on the path is `vault_sol_lamports >= sol_out` in
`sell_to_vault` — `vault_sol_reserve` has **no floor of its own**.

**Worked example** (SOL = $150, 500 SOL accumulated from 100 paid rounds). The founder
cycles 10 SOL fifty times: founder **+250 SOL**, DAO treasury +250 SOL,
`vault_sol_reserve` **0**. `sell_to_vault` then fails `VaultSolInsufficient` for every
other holder. The reserve that backs the $1 floor is gone, and the founder needed only
10 SOL of working capital — recovered on the first cycle.

**Who can do it.** Only the holder of `mint_state.founder`. For anyone else the round
trip is value-neutral (par in, par out) minus fees, which is precisely why this is the
F1 incentive resurfacing through a channel the F1 fix does not cover. Round-trip
rounding loses only dust — `tobe_out` then back to lamports is lossless to within a few
lamports, against a profit of X/2.

**Why this is not the accepted F1.** The accepted, disclosed residual is that the
founder may **acquire and keep** up to 70% of the vault's TOBE at half price — bounded,
and paid for. H2 is a different shape: the founder **returns** the TOBE, extracts
**SOL** instead, the 70% bound is bypassed rather than approached, and the extraction is
**unbounded**. Accepting F1 as documented is not acceptance of H2.

**Fix options as originally filed.** Options 1 and 2 were **wrong** — the analysis in
"H2 bounded" above supersedes them. Option 3 is what shipped.

1. ~~Accrue `founder_cut` to a PDA~~ — does not fix H2, only defers the extraction.
2. ~~Spread on `sell_to_vault`~~ — would need to exceed 50% to work.
3. ~~Cumulative bound on `founder_cut`~~ — implemented, then **replaced**: it bounded
   the leak but capped legitimate arbitrage revenue with it, and no cap value both
   protects the reserve and accommodates real volume.
4. Accept and disclose.

**Shipped instead:** pay the cut only on **new net vault depletion** (see above) — the
one option that separates round trips from genuine demand rather than limiting both.

Note that a floor on `vault_sol_reserve` is *not* a fix: paying that reserve out at $1
is exactly what the floor feature does, so flooring it would disable the feature.

### L1 — protected fraction degrades under net selling (Low)

`sell_to_vault` increments `vault_balance` but not `total_minted`, so after sustained net
selling `vault_balance` can exceed `total_minted / 2` and the floor (30% of
`total_minted / 2`) guards a shrinking fraction of the real balance. Secondary to H2 and
partially self-correcting, since those extra tokens were paid for out of the reserve.

### Checked and found sound this round

The **monotonic baseline itself is correct**: `total_minted / 2` is exact (each mint
splits evenly and `total_tokens` is always even via the 1e9 decimals factor), genuinely
non-decreasing, and the commit's ratchet analysis — that a current-balance anchor walks
1000 → 300 → 90 → 27 → 0 — is right. The flush/buy baseline asymmetry is justified and
documented at both call sites. No arithmetic, account-substitution, signer, or authority
defect was found in `1a68251` or in `buy_from_vault` as a whole.

### What this round says about the method

Three of six rounds have now overturned a *specific clearance* issued by an earlier
round: Round 4 found M1 real after Round 1 rejected it; Round 5 found F1 after a
shallower same-day pass cleared `buy_from_vault`; Round 6 found H2 after Round 5 cleared
`sell_to_vault`. In every case the earlier pass examined the component **in isolation**
and the later pass examined it **in combination**.

That is a consistent, named failure mode of this method, and six rounds have not
exhausted it. **The standing recommendation for a focused paid review is strengthened,
not satisfied, by this round.**
