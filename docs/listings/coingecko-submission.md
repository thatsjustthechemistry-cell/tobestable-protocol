# CoinGecko Submission Packet

Pre-filled responses to every field on CoinGecko's coin submission form. Submit **after** mainnet deploy + at least 7 days of trading activity.

> **Submission URL:** https://forms.coingecko.com/coin-listing-application
> Always check the current form before submitting — fields change.

## Why CoinGecko matters

CoinGecko aggregates price data across thousands of exchanges. Inclusion:

- Adds TOBE to one of the **two** primary crypto data feeds (CoinGecko + CoinMarketCap) used by virtually every wallet, portfolio tracker, news site, and DeFi dashboard
- Provides a **canonical price** that other apps query (Phantom shows price → CoinGecko)
- Earns a **CoinGecko ID** (e.g., `tobestable`) that other listings (Jupiter, DefiLlama, etc.) reference

Submission is free. Approval is manual review by CoinGecko staff.

## Pre-submission checklist

- [ ] Mainnet deploy complete
- [ ] At least one Raydium pool with **>$1,000 in liquidity**
- [ ] **At least 7 days of trading activity** (CoinGecko's hard requirement)
- [ ] Token metadata uploaded (Metaplex)
- [ ] **Project website** live, working, and informative (not a placeholder)
- [ ] Active social accounts (Twitter at minimum; Discord/Telegram preferred)
- [ ] Logo files prepared:
  - 200x200 PNG (CoinGecko default)
  - 100x100 PNG (small)
  - 25x25 PNG (tiny)

## Form responses — pre-filled

Copy/paste each section into the CoinGecko form. **Replace every `[FILL: ...]` with your real value.**

### Section 1: Project / Token Identity

| Field | Response |
|---|---|
| Coin name | `TOBESTABLE` |
| Coin symbol/ticker | `TOBE` |
| Coin price (USD) | (auto-detected from your DEX pool — leave blank or use Hermes spot at submission time) |
| Genesis date / Launch date | `[FILL: YYYY-MM-DD when mainnet program was deployed]` |
| Hash algorithm | `SHA-256` (Solana's algorithm) |
| Block time (seconds) | `0.4` (Solana average) |
| Proof type | `Proof of Stake` |

### Section 2: Smart Contract Info

| Field | Response |
|---|---|
| Smart contract address | `[FILL: MAINNET_TOBE_MINT_PUBKEY]` |
| Blockchain | `Solana` |
| Block explorer URL | `https://explorer.solana.com/address/[FILL_MINT]` |
| Token type | `SPL Token` |

### Section 3: Project Description

**Short description (160 chars max):**
```
Anti-inflationary Solana token with two-way $1 peg via Pyth oracle and permanently-burned Raydium liquidity.
```

**Long description:** *(use this verbatim)*
```
TOBESTABLE ($TOBE) is a fixed-supply, anti-inflationary Solana token built around a two-way $1 USD peg.

How it works:

• 1024 mint rounds. Each round costs exactly 10 SOL. Each round mints fewer tokens than the last
  (Round 1: 1,048,576 TOBE; Round 1024: 1,024 TOBE), creating a deflationary curve.

• 50/50 split. Half the minted tokens go to the minter, half to a protocol-controlled vault.

• Zero SOL to the team from mints. Of the 10 SOL paid: 5 SOL accumulates for Raydium liquidity injection,
  5 SOL backs the vault's SOL reserve. The team only earns from arbitrage proceeds when the price reaches $1.

• Two-way $1 peg via on-chain Pyth oracle:
  - When market price tries to exceed $1, anyone can call `buy_from_vault`: send SOL, get TOBE at $1.
    Caps the price at $1.
  - When market price drops below $1, anyone can call `sell_to_vault`: send TOBE, get SOL at $1
    from the vault SOL reserve. Defends the floor.

• Permanent locked liquidity. Anyone can call `flush_lp_to_raydium` to deposit accumulated SOL + matching
  TOBE into the Raydium pool. The LP tokens received are burned in the same atomic transaction —
  liquidity cannot be removed by anyone, ever.

• No team allocation. No pre-mine. No insiders. Founder mints under the same rules as everyone else.

Built on Anchor framework. Smart contract source open on GitHub. Authority controlled by Squads multisig.
```

### Section 4: Supply Information

| Field | Response |
|---|---|
| Max supply | `537,395,200` |
| Total supply | `[FILL: current supply at submission time — read from on-chain mint]` |
| Circulating supply | `[FILL: max supply minus vault holdings — see formula below]` |

**Circulating supply formula** *(provide this as a note in the form):*
```
Circulating supply = total_minted − vault_balance

where:
  - total_minted = mint_state.total_minted (read from on-chain)
  - vault_balance = mint_state.vault_balance (read from on-chain)

The vault is PDA-controlled and only releases tokens via permissionless
buy_from_vault arbitrage at exactly $1, so vault holdings are NOT considered
circulating until released into the market.

Both values are queryable on-chain at:
  Program: [FILL: MAINNET_PROGRAM_ID]
  PDA: [FILL: derived from "mint_state" seeds]
```

### Section 5: URLs & Links

| Field | Response |
|---|---|
| Official website | `https://tobestable.com` |
| Whitepaper / documentation | `https://github.com/thatsjustthechemistry-cell/tobestable-protocol/blob/main/SECURITY.md` |
| Source code (GitHub) | `https://github.com/thatsjustthechemistry-cell/tobestable-protocol` |
| Block explorer | `https://explorer.solana.com/address/[FILL_MINT]` |
| Twitter | `[FILL: https://twitter.com/YOUR_HANDLE]` |
| Telegram | `[FILL: https://t.me/YOUR_CHANNEL — leave blank if none]` |
| Discord | `[FILL: https://discord.gg/YOUR_INVITE — leave blank if none]` |
| Reddit | `[FILL: leave blank if none]` |
| Facebook | `(leave blank — not relevant)` |
| LinkedIn | `(leave blank — not relevant)` |
| YouTube | `[FILL: leave blank if none]` |
| Medium / Mirror / blog | `[FILL: if you have one]` |
| Bitcointalk | `(leave blank)` |

### Section 6: Exchanges

| Field | Response |
|---|---|
| Listed on which exchanges? | `Raydium (DEX)` |
| Trading pair | `TOBE/wSOL` (or `TOBE/USDC` if you create that pool too) |
| Pool URL | `https://raydium.io/swap/?inputMint=[FILL_TOBE]&outputMint=So11111111111111111111111111111111111111112` |

### Section 7: Audit Information

| Field | Response |
|---|---|
| Has the contract been audited? | `[FILL: Yes/No depending on audit status before submission]` |
| Audit firm name | `[FILL: e.g., OtterSec, Neodyme, Sec3 — or "Not yet audited" if pre-audit]` |
| Audit report URL | `[FILL: link to PDF after audit completes — or "N/A" pre-audit]` |
| Audit date | `[FILL: YYYY-MM-DD or N/A]` |

**If not audited yet:** state honestly. CoinGecko doesn't require audit, but disclosing accurately matters.

### Section 8: Tags / Categories

| Tag | Should we apply? |
|---|---|
| Decentralized Finance (DeFi) | ✅ Yes |
| Stablecoin | ✅ Yes (algorithmic stablecoin via two-way peg) |
| Solana Ecosystem | ✅ Yes |
| Algorithmic Stablecoin | ✅ Yes |
| Asset-backed Stablecoin | ❌ No (the floor is backed by SOL reserve, not fiat or crypto collateral) |
| Yield Farming | ❌ No |
| Governance | ❌ No (no governance token) |
| Meme | ❌ No |
| NFT | ❌ No |

**Suggested CoinGecko categories:** `Stablecoins`, `Algorithmic Stablecoin`, `Solana Ecosystem`

### Section 9: Team Information

CoinGecko's team section is **optional** but improves trust signals.

| Field | Response |
|---|---|
| Team type | `[FILL: Anonymous / Pseudonymous / Public]` |
| Founder name | `[FILL: e.g., "Necdet" or "Anonymous founder"]` |
| Founder LinkedIn | `[FILL: leave blank if pseudonymous]` |
| Founder Twitter | `[FILL]` |

**Pseudonymous is fine.** Many successful Solana projects (Jito, Drift's early days, etc.) launched pseudonymously.

### Section 10: Logo Upload

Upload **3 logo files**:
- 200x200 PNG (primary)
- 100x100 PNG
- 25x25 PNG (favicon-style)

Source from `https://tobestable.com/logo.png` — resize via any image tool. Keep transparent background, square crop.

## What happens after submission

| Stage | Timeline |
|---|---|
| Form submitted | Immediate |
| Initial automated check | 1-3 days (rejects obvious spam) |
| Manual review by CoinGecko team | 2-6 weeks |
| First response (approval / questions) | 4-8 weeks total |
| Coin appears on coingecko.com | Within 24h of approval |

**If rejected:** the email will state why. Most common reasons:
- Insufficient trading volume (need >$10k 24h volume sustained)
- Website looks like a template / placeholder
- Smart contract not verifiable
- No social presence

Address the issue and **resubmit after 30 days** (their cooldown).

## After approval

1. **CoinGecko ID assigned** — capture it (looks like `tobestable`). Use it in:
   - `token-metadata.json` — add `extensions.coingeckoId`
   - Jupiter Verified Token List submission — add `extensions.coingeckoId`
   - Anywhere else you list TOBE
2. **Update logo if needed** — CoinGecko allows post-listing logo updates via the same form
3. **Submit to CoinMarketCap separately** — same idea, different team. Submit ~1 week after CoinGecko approval (helps with their review).

## Common questions during CoinGecko review

CoinGecko reviewers may email asking:

| Their question | Your answer |
|---|---|
| "Where is the founder allocation?" | "Zero. Founder mints under the same 1024-round mechanism as anyone else. Verifiable on-chain — see SECURITY.md `mint_tobe` instruction." |
| "Why do you call this a stablecoin if the price isn't $1 at launch?" | "TOBESTABLE is an algorithmic stablecoin that uses an anti-inflationary curve to converge toward $1, then defends the peg via two-way arbitrage backed by an on-chain SOL reserve. The mechanism is fully on-chain and permissionless. We disclose openly that the price ramps to $1 over the 1024-round mint, not at TGE." |
| "What backs the peg?" | "Two layers: (1) algorithmic — anti-inflationary supply curve makes scarcity drive convergence; (2) reserve — vault SOL reserve (up to 5,120 SOL) backs the floor via `sell_to_vault`. Both verifiable on-chain." |
| "Who controls the authority?" | "After mainnet migration: a Squads multisig at `[FILL: SQUADS_VAULT]`, threshold [FILL: M]-of-[FILL: N]. Verifiable via `verify-multisig.js` script in the repo." |

## Submission checklist (go/no-go)

Before clicking submit:

- [ ] Replaced **every** `[FILL: ...]` placeholder with a real value
- [ ] Long description reads cleanly (no leftover Lorem Ipsum / typos)
- [ ] All URLs work in incognito mode
- [ ] Logo files render correctly at all 3 sizes
- [ ] Audit status is **honest** (don't claim audited if pre-audit)
- [ ] Multisig pubkey is the actual on-chain authority (run `verify-multisig.js` to confirm)
- [ ] You have a clean, dedicated email for CoinGecko correspondence
