# Jupiter Verified Token List — Submission Packet

Ready-to-submit packet for adding TOBE to Jupiter's Verified Token List. Submit **after** mainnet deploy + at least one Raydium pool with non-zero liquidity.

> **Important:** Jupiter's "Strict List" was renamed to **"Verified Token List"**. Submission flow changed in 2025. Current flow is via the Jupiter Token API + a community-driven verification process. Always check current docs before submitting: https://station.jup.ag/docs/token-list/token-list-api

## Why this listing matters

Jupiter is the dominant Solana DEX aggregator. Inclusion in the Verified Token List:

- Adds the green checkmark on jup.ag swap UI (huge trust signal — separates real tokens from squatters with the same name/symbol)
- Most other Solana wallets (Phantom, Solflare, Backpack) consume Jupiter's verified list as a primary source for "trusted token" lists
- Improves discoverability through the Jupiter swap UI's autocomplete

**Note:** Even without verification, Jupiter will route trades through your Raydium pool automatically (that's permissionless). The verification is purely about *trust signaling*, not basic functionality.

## Pre-submission checklist

Before submitting, ensure ALL of these are true on **mainnet**:

- [ ] Program deployed to mainnet (not devnet)
- [ ] TOBE mint created on mainnet
- [ ] At least one Raydium CPMM pool with TOBE/wSOL or TOBE/USDC, with **at least $1,000 in liquidity**
- [ ] Token metadata account exists (Metaplex MPL Token Metadata) with:
  - [ ] Name: TOBESTABLE
  - [ ] Symbol: TOBE
  - [ ] URI pointing to a publicly-accessible JSON (e.g., https://tobestable.com/token-metadata.json)
  - [ ] Logo at the URI's `image` field, **256x256 PNG**, accessible via HTTPS
- [ ] Pool has had **at least 7 days of trading activity** with **>$1,000 daily volume** (improves verification approval rate)
- [ ] Project has a public Twitter/X account with consistent activity
- [ ] At least one of: Discord, Telegram, or active GitHub
- [ ] Smart contract source code is public on GitHub (you have this — `tobestable-protocol` is public)

## Submission method (current as of 2026)

Submit via the **Jupiter Token Verification Form**: https://station.jup.ag/guides/general/get-your-token-on-jupiter

You'll need to provide the data below.

## Form data — pre-filled

Copy/paste from this template into the Jupiter form. **Replace every `[FILL: ...]` with your real value before submitting.**

```yaml
# ─── Token identity ───
chainId: 101                                     # Solana mainnet-beta
address: [FILL: MAINNET_TOBE_MINT_PUBKEY]        # Set after mainnet deploy
symbol: TOBE
name: TOBESTABLE
decimals: 9
logoURI: https://tobestable.com/logo.png

# ─── Project metadata ───
description: |
  Anti-inflationary Solana token with 1024 decreasing mint rounds.
  50% to minter, 50% to vault. The vault enforces a two-way $1 peg via
  on-chain Pyth oracle — selling TOBE above $1, buying TOBE below $1.
  Permanent locked liquidity on Raydium (LP tokens burned). A disclosed, hard-capped team allocation (8 free mint rounds);
  no other insiders; no SOL to the team from mints.

# ─── Tags (Jupiter uses these for category filters) ───
tags:
  - community           # community-launched
  - stablecoin          # peg-anchored
  - solana-anchored     # built on Anchor framework

# ─── Verification claims ───
extensions:
  website: https://tobestable.com
  twitter: https://x.com/tobe_stable
  discord: (none — no Discord)
  telegram: https://t.me/+cqCtGkXO7gA0Yjc0
  github: https://github.com/thatsjustthechemistry-cell/tobestable-protocol
  coingeckoId: [FILL: AFTER_COINGECKO_LISTING]      # leave blank for first submission
  coinmarketcapId: [FILL: AFTER_CMC_LISTING]        # leave blank for first submission
```

## PR description template (if Jupiter still accepts GitHub PR submissions)

Some token registries still accept GitHub PRs. If Jupiter's flow falls back to that path, use:

**PR Title:**
```
feat(tokens): add TOBESTABLE (TOBE)
```

**PR Body:**
```markdown
## Token: TOBESTABLE ($TOBE)

Adding the TOBESTABLE token to the verified list.

### Identity
- **Mint:** `[FILL: MAINNET_TOBE_MINT_PUBKEY]`
- **Decimals:** 9
- **Name:** TOBESTABLE
- **Symbol:** TOBE

### What is it
Anti-inflationary Solana token with a two-way $1 USD peg defended via Pyth oracle and a permanently-locked Raydium liquidity pool.

- **Program ID:** `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`
- **Source code:** https://github.com/thatsjustthechemistry-cell/tobestable-protocol (public, MIT-licensed)
- **Security model:** https://github.com/thatsjustthechemistry-cell/tobestable-protocol/blob/main/SECURITY.md

### Verification evidence
- [ ] Program source matches deployed bytecode (verifiable via `solana program show` + bytecode diff)
- [ ] Liquidity pool: `[FILL: MAINNET_POOL_ADDRESS]` on Raydium CPMM
- [ ] LP tokens permanently burned via `flush_lp_to_raydium` instruction (verifiable on-chain)
- [ ] Authority: `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` (Realms / SPL Governance, 2-of-3 council)
- [ ] Token metadata: https://tobestable.com/token-metadata.json (Metaplex-compliant)
- [ ] Logo: https://tobestable.com/logo.png (256x256 PNG)

### Trading activity
- Pool created: [FILL: DATE]
- 7-day volume: [FILL: $X]
- Holder count: [FILL: N]

### Social
- Twitter: [FILL]
- Website: https://tobestable.com
```

## Common rejection reasons (and how to avoid them)

| Reason | Fix |
|---|---|
| Logo URL returns 404 | Make sure `logoURI` is publicly accessible BEFORE submitting; test in incognito |
| Logo not 256x256 PNG | Resize; some indexers reject other sizes |
| Token metadata missing | Run `metaplex` CLI or check on Solana Explorer that the metadata account exists |
| No trading activity | Wait 7+ days after pool creation; pump some volume via your community |
| Squatter on the same symbol | Document why your TOBE is the "real" one (link to GitHub source code) |
| Authority is single key | Migrate to multisig BEFORE submitting (see [docs/MULTISIG_MIGRATION.md](../MULTISIG_MIGRATION.md)) |

## After approval

When Jupiter accepts:

1. The green checkmark appears on jup.ag/swap when users search for TOBE
2. Update `token-metadata.json` to reference your CoinGecko/CMC IDs once those land
3. Resubmit annually if claims change (e.g., authority rotates, logo changes)

## Estimated timeline

- **Submission to first response:** 5-14 days
- **Approval (if no issues):** 1-2 weeks total
- **Resubmission after fixes:** 1-2 weeks per round

Plan for **3-4 weeks** end-to-end from submission to verified status.
