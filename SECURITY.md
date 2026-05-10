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
| `buy_from_vault`         | Anyone                      | Permissionless arbitrage: send SOL, receive TOBE at \$1 USD via Pyth oracle. Caps price at \$1. SOL flows to authority's treasury. |
| `sell_to_vault`          | Anyone                      | Permissionless arbitrage: send TOBE, receive SOL at \$1 USD via Pyth oracle from vault SOL reserve. Defends \$1 floor. |
| `set_pool_config`        | Authority (once)            | Records Raydium pool addresses on-chain after authority creates the pool externally.  |
| `flush_lp_to_raydium`    | Anyone                      | When ≥1 SOL pending: deposits accumulated SOL + matching TOBE into Raydium pool, **burns LP tokens permanently** in same tx. |
| `migrate_state_v2`       | Authority (one-time)        | Reallocates `mint_state` PDA to fit Phase 2 fields; idempotent (no-op if already at v2 size). |
| `seed_pool`              | Authority (legacy, one-time)| Hands round-1 vault TOBE + accumulated pool SOL to authority for off-chain pool creation. Superseded by `flush_lp_to_raydium` for ongoing deepening. |
| `update_treasury`        | Authority only              | Changes destination wallet for `buy_from_vault` arbitrage proceeds.                   |
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
11. **Vault floor protection**: `vault_balance >= 0.30 × vault_tobe_at_config` after every flush

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
