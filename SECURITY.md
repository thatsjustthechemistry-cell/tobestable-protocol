# TOBE Security Model

## Program Overview

TOBE is a fixed-supply, anti-inflationary Solana token with 1024 decreasing mint rounds.
Each round costs **10 SOL** and mints a decreasing number of TOBE tokens.

- **Program ID**: `DnMvWs2dDim57TLBcJp7FKkDUFw2KnLmJybzpbTZuc65`
- **TOBE Mint**: `h611YQ3wKJesFUC6NDmpzXNSAG5jYn7BJS6FrepcqbN`
- **Max Supply**: 537,395,200 TOBE (9 decimals)
- **Framework**: Anchor 0.32.1

## Access Control Matrix

| Instruction       | Who Can Call         | What It Does                                     |
|--------------------|----------------------|--------------------------------------------------|
| `initialize`       | Deployer (once)      | Creates mint, vault, PDAs, metadata               |
| `mint_tobe`        | Anyone               | Pays 10 SOL, receives TOBE (50% minter, 50% vault)|
| `vault_release`    | Buyer + Keeper       | Buyer pays SOL, receives vault TOBE               |
| `update_treasury`  | Authority only       | Changes treasury wallet address                   |
| `pause`            | Authority only       | Stops all minting                                 |
| `unpause`          | Authority only       | Resumes minting                                   |
| `propose_authority` | Authority only      | Proposes new authority (2-step transfer)           |
| `accept_authority` | Pending authority    | Accepts authority transfer                        |
| `lock_lp`          | Authority only       | Locks LP tokens in PDA for 2 years                |
| `unlock_lp`        | Authority only       | Withdraws LP after 2-year lock expires            |
| `update_metadata`  | Authority only       | Updates token name/symbol/URI via Metaplex CPI    |

## Invariants

These must hold true at all times:

1. **Round cap**: `current_round <= 1024` (enforced by `AllRoundsMinted` error)
2. **Cost is fixed**: Every mint costs exactly `10_000_000_000` lamports (10 SOL) — hardcoded constant, no parameter
3. **50/50 split**: `minter_tokens = total / 2`, `vault_tokens = total - minter_tokens`
4. **Token formula**: `tokens_per_round = 1024 * (1025 - round)` (decreasing)
5. **Vault accounting**: `vault_balance` tracks vault holdings; `vault_release` requires `token_amount <= vault_balance`
6. **LP lock duration**: 2 years (63,072,000 seconds), enforced by `Clock::get()`
7. **Authority transfer**: 2-step (propose + accept) — prevents accidental transfer
8. **Pause blocks minting**: `paused` flag checked before round cap in `mint_tobe`

## PDA Seeds

| PDA                | Seeds               | Purpose                          |
|--------------------|----------------------|----------------------------------|
| `mint_state`       | `"mint_state"`       | Program state account            |
| `mint_authority`   | `"mint_authority"`   | Mint authority for TOBE token    |
| `vault_authority`  | `"vault_authority"`  | Authority for vault token account|
| `vault_token`      | `"vault_token"`      | Vault's TOBE token account       |
| `lp_lock_authority`| `"lp_lock_authority"`| Authority for LP lock vault      |
| `lp_lock_vault`    | `"lp_lock_vault"`    | LP token lock vault              |

## Known Risks & Mitigations

### Risk: Authority key compromise
- **Impact**: Can pause, update treasury, update metadata, release vault tokens
- **Mitigation**: Transfer authority to a Squads multisig before mainnet

### Risk: Keeper bot key compromise
- **Impact**: Can trigger vault_release at arbitrary prices
- **Mitigation**: Keeper = authority, so multisig applies. vault_release requires both buyer + keeper signatures

### Risk: Treasury receives SOL from same wallet that mints
- **Impact**: None (net-zero transfer). Expected behavior for authority testing.
- **Mitigation**: Documentation only — not a vulnerability

### Risk: No on-chain price oracle
- **Impact**: vault_release price is set by keeper, not enforced by oracle
- **Mitigation**: Keeper bot uses Jupiter Price API. Future: integrate Pyth/Switchboard

### Risk: Math overflow
- **Impact**: Token calculation fails silently
- **Mitigation**: All arithmetic uses `checked_mul`, `checked_add`, `checked_sub` with `MathOverflow` error

## Test Coverage

27 tests covering:
- Initialization with metadata CPI
- 3 individual mint rounds (token amounts, SOL transfers, decreasing formula)
- All 1024 rounds + round 1025 rejection
- Insufficient SOL rejection
- Vault release (success, unauthorized keeper, exceeding balance, zero amount)
- Pause/unpause (success, unauthorized, double pause, not-paused unpause)
- Mint-while-paused rejection
- 2-step authority transfer (propose, wrong acceptor, accept, old authority revoked)
- LP lock (lock, double lock, early unlock)
- Metadata update (success, unauthorized)

## Audit Contact

For audit inquiries, reach out via GitHub or https://tobestable.com
