# TOBE Security Model

## Program Overview

TOBE is a fixed-supply, anti-inflationary Solana token with 1024 decreasing mint rounds.
Each round costs **10 SOL** and mints a decreasing number of TOBE tokens.

- **Program ID** (devnet): `CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ`
- **TOBE Mint** (devnet): `4fFD96LWnsgCiWMtLJym12k7xLofH6FdSDtr5MgyYmHV`
- **Max Supply**: 537,395,200 TOBE (9 decimals)
- **Framework**: Anchor 0.32.1
- **Mainnet**: not yet deployed (see [docs/MULTISIG_MIGRATION.md](docs/MULTISIG_MIGRATION.md) for the pre-mainnet authority plan)

## Access Control Matrix

| Instruction              | Who Can Call                | What It Does                                                                          |
|--------------------------|-----------------------------|---------------------------------------------------------------------------------------|
| `initialize`             | Deployer (once)             | Creates mint, vault, PDAs, Metaplex metadata                                          |
| `mint_tobe`              | Anyone                      | Pays 10 SOL → 50% TOBE to minter, 50% to vault, 5 SOL to pool reserve, 5 SOL to vault SOL reserve. **Zero SOL to authority.** |
| `buy_from_vault`         | Anyone                      | Permissionless arbitrage: send SOL, receive TOBE at \$1 USD via Pyth oracle. Caps price at \$1. **SOL is split 50/50: half to the DAO treasury, half to the founder wallet — a disclosed founder fee on ceiling-arbitrage proceeds.** |
| `sell_to_vault`          | Anyone                      | Permissionless arbitrage: send TOBE, receive SOL at \$1 USD via Pyth oracle from vault SOL reserve. Defends \$1 floor. |
| `set_pool_config`        | Authority (once)            | Records Raydium pool addresses on-chain after authority creates the pool externally.  |
| `flush_lp_to_raydium`    | Anyone                      | When ≥1 SOL pending: deposits accumulated SOL + matching TOBE into Raydium pool, **burns LP tokens permanently** in same tx. |
| `migrate_state_v2`       | Authority (one-time)        | Reallocates `mint_state` PDA to fit Phase 2 fields; idempotent (no-op if already at v2 size). |
| `arm_floor`              | Authority only (H1 fix)     | One-way latch enabling `sell_to_vault` (the $1 floor) once TOBE reaches $1. Authority-gated so the manipulable pool spot-price check cannot be flash-gamed to arm the floor early. (`seed_pool` was **removed** — M1 fix: it was a legacy authority fund-movement primitive unused by the fair launch.) |
| `update_treasury`        | Authority only              | Changes the DAO-treasury wallet (its 50%) for `buy_from_vault` proceeds.               |
| `update_founder`         | Authority only              | Changes the founder wallet (its 50%) for `buy_from_vault` proceeds. Rejects the zero address. |
| `pause`                  | Authority only              | Stops all minting (emergency).                                                         |
| `unpause`                | Authority only              | Resumes minting.                                                                       |
| `propose_authority`      | Authority only              | Step 1 of 2-step authority transfer; sets pending authority.                           |
| `accept_authority`       | Pending authority           | Step 2 of 2-step transfer; new authority signs to accept.                              |
| `lock_lp`                | Authority only              | Locks LP tokens in PDA for 2 years (legacy alternative to permanent burn).             |
| `unlock_lp`              | Authority only              | Withdraws LP tokens after 2-year lock expires.                                         |
| `update_metadata`        | Authority only              | Updates token name/symbol/URI via Metaplex CPI.                                        |

## Pyth Oracle Dependency

`buy_from_vault` and `sell_to_vault` both read SOL/USD price from a Pyth `PriceUpdateV2` account on every invocation.

- **Feed ID**: `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` (SOL/USD)
- **Freshness check**: rejects prices older than **60 seconds**
- **Confidence interval check**: rejects prices where `confidence > 1% of price`
- **Non-positive prices**: rejected
- **Network constraint**: Pyth's pull oracle (`PriceUpdateV2`) is **mainnet-only**. The Wormhole guardian set required for VAA verification is not initialized on devnet — peg arbitrage cannot be exercised on devnet.

If Pyth itself is compromised or returns garbage prices, the worst case for the protocol is mispriced peg arbitrage during the bad window. The freshness + confidence guards limit exposure but do not eliminate it. This is the standard Pyth dependency risk profile shared by all integrators.

## Permanent LP Burn

`flush_lp_to_raydium` deposits accumulated SOL + matching vault TOBE into a Raydium CPMM pool, then **burns the LP tokens received in the same atomic transaction**. The LP receipt account holds zero LP tokens at the end of the instruction.

This is stronger than a time-locked LP (the legacy `lock_lp` / `unlock_lp` pattern), because:
- No future unlock event ever returns liquidity to the authority
- The burn is verifiable on-chain — anyone can read the LP mint supply and the LP receipt account to confirm
- There is no admin instruction that can withdraw deposited liquidity from Raydium

## Vault Floor Protection

`flush_lp_to_raydium` enforces that `vault_balance` never drops below **30% of `vault_tobe_at_config`** (the baseline recorded at `set_pool_config` time). This protects the `sell_to_vault` floor-defense reserve from being drained by repeated flush operations.

If a flush would breach the floor, the instruction reverts with `VaultFloorBreach`.

> ⚠️ **This floor applies to `flush_lp_to_raydium` only.** Round 5 also applied it to
> `buy_from_vault`, capping extraction at 70% of the vault; that was **removed by founder
> decision on 2026-07-26** — it only ever bound after ~188M TOBE had been sold at $1, and
> at that point it began refusing genuine buyers. **`buy_from_vault` can now take the
> vault to zero.** Consequences are recorded in `docs/SELF_AUDIT.md` (F1 residual): F1 is
> unbounded on that path, and a full drain can starve `flush`.

## SOL Reserve Operations (accepted risks — read before launch)

Both SOL reserves are **System-owned PDAs with no data**. They are never `init`ed with
space and are only funded by plain `system_program::transfer`. Two consequences follow,
neither of which is fixed in code, both with cheap operational remedies.

### The $1 floor can be temporarily disabled (audit H3, Low–Medium)

Anyone can cycle `sell_to_vault` → `buy_from_vault` at ~zero net cost. The buy earns the
founder nothing (the depletion high-water mark already covers that ground), so 100%
routes to the DAO — each pass moves SOL from `vault_sol_reserve` into the treasury while
the actor ends exactly where they started. Drained far enough, `sell_to_vault` fails
`VaultSolInsufficient` and the $1 floor stops working.

**Nothing is stolen — the funds are in the DAO's own treasury.**

> **🔧 RESPONSE — if the floor stops working.** Compare `vault_sol_reserve`'s balance
> against its expected level (`paid_rounds × 5 SOL`). If short, the reserve is a
> System-owned PDA: **restore it with an ordinary SOL transfer from the DAO treasury to
> the `vault_sol_reserve` PDA address.** No instruction and no program upgrade is
> required. A single 2-of-3 council transfer undoes the whole attack.

### `flush` can be blocked by ~1 lamport of dust (audit L3, Low)

A System-owned PDA must end a transfer either **rent-exempt** or at **exactly zero**.
`flush_lp_to_raydium` moves `pool_sol_balance` — the *tracked* figure — but the PDA's
actual balance can be higher, because anyone may send SOL to it and nothing rejects that.
If the untracked excess is non-zero but below the rent-exempt minimum, every flush
reverts (now with the named `ReserveDustRemainder` rather than an opaque runtime error).

> **🔧 RESPONSE — if flush reverts with `ReserveDustRemainder`.** **Send the
> `pool_sol_reserve` PDA enough SOL to lift the untracked excess to the rent-exempt
> minimum (~0.0009 SOL).** Anyone can do this; it needs no authority. The donated
> lamports stay in the PDA as untracked dust.

`sell_to_vault` is not exposed to the same block: it **explicitly permits an exact
drain**, so the entire reserve remains spendable — the account simply closes, and the
next mint's 5 SOL transfer recreates it.

## Invariants

These must hold true at all times:

1. **Round cap**: `current_round <= 1024` (enforced by `AllRoundsMinted` error)
2. **Cost is fixed**: Every mint costs exactly `10_000_000_000` lamports (10 SOL) — hardcoded constant, no parameter
3. **50/50 token split**: `minter_tokens = total / 2`, `vault_tokens = total - minter_tokens`
4. **5/5 SOL split**: Per mint, 5 SOL → `pool_sol_reserve` PDA, 5 SOL → `vault_sol_reserve` PDA. **Zero SOL to authority from mints.**
5. **Token formula**: `tokens_per_round = 1024 * (1025 - round)` (decreasing)
6. **Vault accounting**: `vault_balance` tracks vault holdings; `buy_from_vault` requires `tobe_out <= vault_balance`
7. **Vault SOL accounting**: `vault_sol_reserve` PDA balance backs `sell_to_vault`; floor defense fails when reserve depleted
8. **Authority transfer**: 2-step (propose + accept) — prevents accidental transfer
9. **Pause blocks minting**: `paused` flag checked before round cap in `mint_tobe`
10. **LP burn is irreversible**: `flush_lp_to_raydium` always burns the LP receipt; no instruction unburns
11. **Vault floor protection**: `vault_balance >= 0.30 × vault_tobe_at_config` after every flush — **`flush_lp_to_raydium` ONLY**; `buy_from_vault` has no floor (removed 2026-07-26, see above)
12. **Reserve payouts respect the System rent rule**: every payout from `vault_sol_reserve` / `pool_sol_reserve` leaves the PDA rent-exempt **or** at exactly zero — enforced by `reserve_payout_leaves_valid_balance`, reverts `ReserveDustRemainder`
13. **Founder cut is paid only on new net vault depletion**: `founder_cut > 0` only when a buy takes `total_minted/2 − vault_balance` above `max_vault_depletion`, so a round trip earns the founder nothing

## PDA Seeds

| PDA                  | Seeds                  | Purpose                                                  |
|----------------------|------------------------|----------------------------------------------------------|
| `mint_state`         | `"mint_state"`         | Program state account                                    |
| `mint_authority`     | `"mint_authority"`     | Mint authority for TOBE token                            |
| `vault_authority`    | `"vault_authority"`    | Authority for vault token account                        |
| `vault_token`        | `"vault_token"`        | Vault's TOBE token account                               |
| `pool_sol_reserve`   | `"pool_sol_reserve"`   | Accumulates 5 SOL per mint until `flush_lp_to_raydium`   |
| `vault_sol_reserve`  | `"vault_sol_reserve"`  | Backs `sell_to_vault` floor defense                      |
| `wsol_temp`          | `"wsol_temp"`          | Temporary wSOL account during flush (init_if_needed)     |
| `lp_receipt`         | `"lp_receipt"`         | Holds LP tokens momentarily before burn (init_if_needed) |
| `lp_lock_authority`  | `"lp_lock_authority"`  | Authority for legacy LP lock vault                       |
| `lp_lock_vault`      | `"lp_lock_vault"`      | Legacy LP token lock vault                               |

## Known Risks & Mitigations

### Risk: Authority key compromise
- **Impact**: Authority can pause minting, update treasury, update metadata, change Pyth feed pubkey, set pool config (one-time), reallocate state. Authority **cannot** mint extra TOBE, drain the vault directly, withdraw the LP, or change the supply curve.
- **Mitigation**: Transfer authority to a Squads multisig before mainnet. See [docs/MULTISIG_MIGRATION.md](docs/MULTISIG_MIGRATION.md).

### Risk: Pyth feed misbehavior
- **Impact**: `buy_from_vault` / `sell_to_vault` price TOBE incorrectly during bad window
- **Mitigation**: Freshness (60s) + confidence (1%) checks. Non-positive prices rejected. If Pyth is fully down, peg arbitrage simply fails — protocol enters degraded mode with no peg defense, but no funds at risk.

### Risk: Raydium pool drained externally
- **Impact**: Spot price diverges from \$1 peg
- **Mitigation**: Permissionless `buy_from_vault` (above peg) and `sell_to_vault` (below peg) defend the peg. Vault TOBE backs the upside cap; vault SOL reserve backs the floor.

### Risk: Vault SOL reserve drained
- **Impact**: Floor defense fails; price can fall below \$1
- **Mitigation**: 5 SOL per mint accumulates into `vault_sol_reserve`; total reserve approaches 5,120 SOL after all 1024 rounds. Documented in user-facing FAQ.

### Risk: Vault TOBE drained by flush operations
- **Impact**: `buy_from_vault` ammunition reduced; ceiling defense weakens
- **Mitigation**: Floor protection (30% of baseline) in `flush_lp_to_raydium`

### Risk: Math overflow
- **Impact**: Token calculation fails silently
- **Mitigation**: All arithmetic uses `checked_mul` / `checked_add` / `checked_sub` with `MathOverflow` error

### Risk: Account-size drift after upgrades
- **Impact**: New `MintState` fields can't be read until PDA reallocated
- **Mitigation**: `migrate_state_v2` instruction reallocates the PDA in place; idempotent. Documented for any future Phase N+ migration that appends fields.

## Test Coverage

29+ tests covering: initialization with metadata CPI, individual mint rounds (token amounts, SOL transfers, decreasing formula), pool seeding (success and reject second call), all 1024 rounds + round 1025 rejection, insufficient SOL rejection, pause/unpause flows (success, unauthorized, double pause, not-paused unpause), mint-while-paused rejection, 2-step authority transfer (propose, wrong acceptor, accept, old authority revoked), LP lock (lock, double lock, early unlock), metadata update (success, unauthorized).

Phase 2 instructions (`buy_from_vault`, `sell_to_vault`, `flush_lp_to_raydium`, `migrate_state_v2`, `set_pool_config`) verified end-to-end on devnet via the scripts in [scripts/](scripts/).

## Audit Contact

For audit inquiries, reach out via GitHub or https://tobestable.com
