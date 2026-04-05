# TOBESTABLE ($TOBE)

Anti-inflationary Solana SPL token with 1024 decreasing mint rounds.

## How It Works

- **1024 rounds** of minting, each costs exactly **10 SOL**
- Each round mints **fewer tokens** than the last (Round 1: ~1M tokens, Round 1024: ~1K tokens)
- **50% goes to minter**, 50% goes to the protocol vault
- The vault accumulates SOL, creating upward pressure toward the **$1.00 ceiling**
- No team allocation. No pre-mine. No admin minting.

## Contract

- **Program ID:** `DnMvWs2dDim57TLBcJp7FKkDUFw2KnLmJybzpbTZuc65`
- **TOBE Mint:** `h611YQ3wKJesFUC6NDmpzXNSAG5jYn7BJS6FrepcqbN`
- **Network:** Solana Devnet (mainnet deployment planned)
- **Framework:** Anchor

## Features

- Decreasing supply curve (anti-inflationary)
- PDA-controlled mint authority (no human can mint arbitrarily)
- SOL-based payments (10 SOL per round to treasury)
- Vault mechanism with $1.00 ceiling
- 2-year LP token lock
- Pause/unpause capability
- 2-step authority transfer
- On-chain price oracle (updated every mint)
- Metaplex token metadata (create + update via CPI)

## Build

```bash
anchor build
anchor test
```

## License

MIT
