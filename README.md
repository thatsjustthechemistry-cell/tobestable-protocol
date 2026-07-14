# TOBESTABLE ($TOBE)

Anti-inflationary Solana SPL token with 1024 decreasing mint rounds and a permissionless **$1 USD peg** enforced by an on-chain Pyth oracle.

## How It Works

- **1024 rounds** of minting, each costs exactly **10 SOL**
- Each round mints **fewer tokens** than the last (Round 1: ~1M tokens, Round 1024: ~1K tokens)
- **50% to minter**, **50% to protocol vault** (the stabilization reserve)
- Of the 10 SOL paid:
  - **5 SOL → pool SOL reserve** (accumulates for future LP injection)
  - **5 SOL → vault SOL reserve** (backs the $1 floor defense)
- Team allocation: a disclosed, hard-capped 16 free mint rounds to the team wallet (50/50 split like every mint, zero SOL paid, tagged on-chain). No other admin minting. No pre-mine outside those rounds. No mint payments to authority.

## $1 Peg Mechanism

Two permissionless instructions read Pyth SOL/USD on-chain and price TOBE at exactly $1 USD:

- **`buy_from_vault(sol_in_lamports)`** — anyone sends SOL, receives `sol * sol_usd_price` TOBE from the vault. Caps the upside at $1. Incoming SOL is **split 50/50: half to the DAO treasury, half to the founder wallet** (a disclosed founder fee — the only path through which the founder earns protocol revenue). Only fires at/above $1.
- **`sell_to_vault(tobe_in_raw)`** — anyone deposits TOBE, receives equivalent SOL at $1/TOBE drawn from `vault_sol_reserve`. Defends the floor; bought TOBE replenishes the vault.

Pyth `PriceUpdateV2` is validated on every call:
- Freshness ≤ 60 seconds
- Confidence interval ≤ 1% of price
- Non-positive prices rejected

## Contract

- **Program ID:** `CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ`
- **TOBE Mint:** *(derived from program ID — set after first `initialize`)*
- **Network:** Solana Devnet (mainnet deployment planned)
- **Framework:** Anchor 0.32.1
- **Oracle:** Pyth `pyth-solana-receiver-sdk` 0.6.1

## Instructions

| Instruction | Caller | Purpose |
|---|---|---|
| `initialize` | Authority (one-time) | Create state, mint, vaults, Metaplex metadata |
| `mint_tobe` | Anyone | Pay 10 SOL → 50% TOBE to caller, 50% to vault, 5/5 SOL split to reserves |
| `buy_from_vault` | Anyone | SOL in → TOBE out @ $1 (caps price). SOL split 50/50: DAO treasury + founder |
| `sell_to_vault` | Anyone | TOBE in → SOL out @ $1 (defends floor) |
| `arm_floor` | Authority only | Latch the $1 floor on once TOBE reaches $1 (H1 fix; `seed_pool` removed) |
| `lock_lp` / `unlock_lp` | Authority | 2-year LP token timelock |
| `pause` / `unpause` | Authority | Emergency mint halt |
| `propose_authority` / `accept_authority` | Authority / new authority | 2-step ownership transfer |
| `update_treasury` | Authority | Change the DAO-treasury destination (50%) for `buy_from_vault` proceeds |
| `update_founder` | Authority | Change the founder destination (50%) for `buy_from_vault` proceeds |
| `update_metadata` | Authority | Update Metaplex token name / symbol / URI |

## Features

- Decreasing supply curve (anti-inflationary)
- PDA-controlled mint authority (no human can mint arbitrarily)
- Mint payments split entirely between protocol PDAs (none to authority)
- Permissionless $1 peg via Pyth oracle (no keeper bot needed)
- Two-way peg defense (cap above, floor below)
- Pause/unpause capability
- 2-step authority transfer
- Metaplex token metadata (create + update via CPI)

## Build & Test

```bash
anchor build
anchor test
```

Local integration tests on Windows may need WSL due to a known
solana-test-validator genesis-unpack permission issue. `cargo test --lib`
runs the Pyth math unit tests on any platform.

## License

MIT
