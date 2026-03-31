# TOBESTABLE ($TOBE)

Anti-inflationary Solana SPL token with 1024 decreasing mint rounds.

## How It Works

- **1024 rounds** of minting, each costs exactly **$1,024 USDC**
- Each round mints **fewer tokens** than the last (Round 1: ~1M tokens, Round 1024: ~1K tokens)
- **50% goes to minter**, 50% goes to the protocol vault
- The vault sells only at the **$1.00 ceiling price**, creating upward pressure
- No team allocation. No pre-mine. No admin minting.

## Contract

- **Program ID:** `CWZGdSh1EGsR95CnkK8AkEgtFX63Z9FurafK7rTFWJ4s`
- **Network:** Solana Devnet (mainnet deployment planned)
- **Framework:** Anchor

## Features

- Decreasing supply curve (anti-inflationary)
- PDA-controlled mint authority (no human can mint arbitrarily)
- Vault mechanism with $1.00 ceiling
- 2-year LP token lock
- Pause/unpause capability
- 2-step authority transfer
- On-chain price oracle (updated every mint)
- Metaplex token metadata (create + update via CPI)
- 27/27 tests passing

## Build

```bash
anchor build
anchor test
```

## License

MIT
