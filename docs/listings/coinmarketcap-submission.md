# CoinMarketCap Submission Packet

Pre-filled responses for CoinMarketCap's "Self Reporting Dashboard" + "Add Cryptoasset Request" forms. Submit **after** CoinGecko approval (CMC reviewers consider CoinGecko presence a positive signal).

> **Submission URL:** https://coinmarketcap.com/request/
> Always check the current form before submitting — fields change.

## Why CoinMarketCap matters (and how it differs from CoinGecko)

CMC is the **other** of the two primary crypto data feeds (alongside CoinGecko). Both are free to submit to. Listing on both is industry standard.

Differences from CoinGecko:

| Aspect | CoinGecko | CoinMarketCap |
|---|---|---|
| Review style | More open to early-stage / experimental tokens | Stricter; prefers established trading volume |
| Volume requirement | ~$10k/24h sustained | **~$100k/24h often expected** for fast approval |
| Time-since-launch threshold | 7 days | **30+ days** typically |
| Trading pair requirement | Any DEX pool | Same |
| Rejection signal | Detailed email | Often silent / form-letter |
| Resubmission cooldown | 30 days | 60 days |
| Self-reporting features | Limited | Strong (you control your token's CMC page after listing) |

**Recommendation:** submit to CoinGecko first, then CMC ~7 days later (so CG approval can land before CMC starts reviewing).

## Pre-submission checklist

- [ ] Mainnet deploy complete
- [ ] **30+ days of trading activity** (CMC's preferred threshold)
- [ ] Sustained **24h volume of $100k+** (preferred; some tokens get listed with less)
- [ ] At least one Raydium pool with **>$10,000 in liquidity**
- [ ] Token metadata uploaded (Metaplex)
- [ ] Project website live + informative
- [ ] **At least 2 social channels active** (Twitter is mandatory; Discord/Telegram strongly preferred)
- [ ] CoinGecko listing already approved (boosts CMC approval rate)
- [ ] Logo files prepared:
  - 200x200 PNG (CMC default)
  - 32x32 PNG (small)

## Form responses — pre-filled

CMC's submission form has roughly the same fields as CoinGecko but slightly different framing. **Replace every `[FILL: ...]` with your real value.**

### Section 1: Coin / Token Information

| Field | Response |
|---|---|
| Name | `TOBESTABLE` |
| Ticker | `TOBE` |
| Launch date | `[FILL: YYYY-MM-DD when mainnet program was deployed]` |
| Hashing algorithm | `SHA-256` (Solana's algorithm) |
| Block reward | `Variable` (Solana validator rewards depend on stake) |
| Block time | `0.4 seconds` (Solana average slot time) |
| Proof type | `Proof of Stake` |

### Section 2: Project Information

**Project description (use verbatim):**
```
TOBESTABLE ($TOBE) is a fixed-supply, anti-inflationary Solana token built around a two-way $1 USD peg.

The protocol mints across 1024 sequential rounds. Each round costs exactly 10 SOL and produces a decreasing number of tokens (Round 1: 1,048,576 TOBE; Round 1024: 1,024 TOBE), creating a deflationary supply curve. Each mint splits 50/50 between the minter and a protocol-controlled vault.

Crucially, zero SOL from mints flows to the team. Of the 10 SOL paid per round: 5 SOL accumulates for Raydium liquidity injection, 5 SOL backs the vault's SOL reserve. The team only earns from arbitrage proceeds when the price reaches $1.

The vault enforces a two-way $1 USD peg via on-chain Pyth oracle:

- When market price tries to exceed $1, anyone can call buy_from_vault: send SOL, get TOBE at exactly $1. This caps the price at $1.
- When market price drops below $1, anyone can call sell_to_vault: send TOBE, get SOL at $1 from the vault SOL reserve. This defends the floor.

Liquidity is permanently locked: anyone can call flush_lp_to_raydium to deposit accumulated SOL + matching TOBE into the Raydium pool. The LP tokens received are burned in the same atomic transaction. Liquidity cannot be removed by anyone, ever.

Team allocation: 8 free mint rounds, hard-capped in the contract and disclosed (≈ 0.8% of rounds). No other insiders; beyond the cap the founder mints under the same rules as everyone else. Smart contracts open-sourced on GitHub. Authority controlled by Squads multisig.
```

### Section 3: Token Contract Information

| Field | Response |
|---|---|
| Smart contract address | `[FILL: MAINNET_TOBE_MINT_PUBKEY]` |
| Smart contract platform | `Solana` |
| Token type | `SPL Token` |
| Total supply | `[FILL: current total_minted from on-chain]` |
| Max supply | `537,395,200` |
| Circulating supply | `[FILL: total_minted − vault_balance, both read from on-chain]` |
| Decimals | `9` |

**Note for "Circulating supply" justification field (if asked):**
```
Circulating supply excludes vault holdings (mint_state.vault_balance).

The vault is PDA-controlled and only releases tokens via the
permissionless buy_from_vault instruction at exactly $1 USD. Until
released into the market, vault tokens are not considered circulating.

Both total_minted and vault_balance are queryable on-chain:
- Program: Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX
- State PDA: derived from "mint_state" seeds
```

### Section 4: URLs

| Field | Response |
|---|---|
| Official website | `https://tobestable.com` |
| Source code | `https://github.com/thatsjustthechemistry-cell/tobestable-protocol` |
| Whitepaper / technical doc | `https://github.com/thatsjustthechemistry-cell/tobestable-protocol/blob/main/SECURITY.md` |
| Block explorer | `https://explorer.solana.com/address/[FILL_MINT]` |
| Block explorer #2 | `https://solscan.io/token/[FILL_MINT]` |
| Block explorer #3 | `https://solana.fm/address/[FILL_MINT]` |
| Twitter | `https://x.com/tobe_stable` |
| Telegram | `https://t.me/+cqCtGkXO7gA0Yjc0` |
| Discord | `(none — no Discord)` |
| Reddit | `[FILL: leave blank if none]` |
| Medium | `[FILL: leave blank if none]` |
| YouTube | `[FILL: leave blank if none]` |
| Bitcointalk announcement | `(leave blank — not relevant for Solana)` |
| Github | `https://github.com/thatsjustthechemistry-cell/tobestable-protocol` |
| Facebook | `(leave blank)` |

### Section 5: Markets / Exchanges

| Field | Response |
|---|---|
| Markets list | `Raydium (DEX)` |
| Trading pair | `TOBE/wSOL` |
| Pool URL | `https://raydium.io/swap/?inputMint=[FILL_TOBE]&outputMint=So11111111111111111111111111111111111111112` |
| Liquidity (USD) | `[FILL: current pool TVL]` |
| 24h Volume (USD) | `[FILL: current 24h volume]` |

### Section 6: Tags

CMC's tag taxonomy (as of 2026):

| Tag | Apply? |
|---|---|
| `algorithmic-stablecoin` | ✅ Yes |
| `solana-ecosystem` | ✅ Yes |
| `decentralized-exchange` | ❌ No (we're a token, not a DEX) |
| `defi` | ✅ Yes |
| `stablecoin` | ✅ Yes |
| `asset-backed-stablecoin` | ❌ No (peg is algorithmic, not asset-backed) |
| `liquidity-mining` | ❌ No |
| `governance` | ❌ No |
| `meme` | ❌ No |
| `oracle` | ❌ No (we USE Pyth, we're not an oracle) |

### Section 7: Team / Founders

| Field | Response |
|---|---|
| Team type | `[FILL: Public / Pseudonymous / Anonymous]` |
| Founder name | `[FILL]` |
| Founder LinkedIn | `[FILL: leave blank if pseudonymous]` |
| Founder Twitter | `[FILL]` |
| Country / Location | `[FILL: optional]` |

### Section 8: Audit / Security

| Field | Response |
|---|---|
| Has the project been audited? | `[FILL: Yes/No]` |
| Audit firm | `[FILL: e.g., OtterSec, Neodyme, Sec3 — or "Not yet audited"]` |
| Audit report URL | `[FILL]` |
| Bug bounty program | `[FILL: e.g., "Immunefi" or "None at launch"]` |
| Multisig wallet | `[FILL: SQUADS_VAULT_PUBKEY]` (if migrated) |

### Section 9: Logo

Upload **200x200 PNG**, transparent background. CMC will resize for other displays.

Source from `https://tobestable.com/logo.png` and resize.

### Section 10: Email + Verification

| Field | Response |
|---|---|
| Submitter email | `[FILL: a clean email you check daily during review]` |
| Email of project lead | (same or separate) |
| Confirm you are authorized to submit | `Yes` |

## Self-Reporting Dashboard (post-listing)

Once listed, CMC gives you a "Self-Reporting Dashboard" where you can update:

- Description, links, tags
- Circulating supply (with proof)
- Add new exchange listings
- Add audit reports
- Verify markets

**Submit a CoinGecko ID for cross-referencing** once you have it (CMC field: `coingecko_url`).

## Common rejection patterns

CMC rejects more silently than CoinGecko. Common reasons (inferred from rejected tokens):

| Reason | Fix |
|---|---|
| Trading volume too low | Wait until consistent $100k+ daily |
| Listed on only one DEX | Get pools on at least 2 venues (e.g., Raydium AND Orca/Meteora) |
| Website looks templated | Make it look custom and informative |
| Single social channel | Active Twitter + Discord/Telegram minimum |
| Anonymous team + no audit | Either disclose more or get audited (or both) |
| Squatter on the symbol | Document why your token is the canonical "TOBE" |

## Sample reviewer Q&A

CMC reviewers may email asking:

| Question | Answer |
|---|---|
| "What problem does this solve?" | "Algorithmic stablecoins typically depeg under stress (Terra/UST). TOBESTABLE uses a SOL-reserve-backed two-way peg defended by permissionless arbitrage — no death spiral mechanism, no LUNA-style hyperinflation. The peg is bounded by an honest reserve." |
| "Is the team anonymous?" | "[Honestly disclose — pseudonymous is OK as long as documented.]" |
| "Why should we list this?" | "Solana-native algorithmic stablecoin with a novel two-way peg + permanently locked liquidity. Source code public, security model documented, multisig-controlled. Price discoverable via Raydium pool with >$X liquidity." |
| "Why is your circulating supply lower than total supply?" | "The vault holds ~50% of all minted TOBE in a PDA. These tokens are only released via the permissionless buy_from_vault arbitrage at exactly $1. Until released, they are not in circulation. Both numbers verifiable on-chain." |

## Submission checklist (go/no-go)

- [ ] Replaced every `[FILL: ...]` with a real value
- [ ] Long description reads cleanly
- [ ] All URLs work in incognito
- [ ] Logo file rendered correctly
- [ ] CoinGecko approved (cite their ID in Section 4 if accepted)
- [ ] At least 30 days of trading activity
- [ ] At least $100k 24h volume sustained
- [ ] Multisig pubkey is the actual on-chain authority

## Estimated timeline

| Stage | Timeline |
|---|---|
| Submission to first response | 2-6 weeks |
| Approval (if no issues) | 6-12 weeks total |
| Resubmission after fixes | Wait 60 days |

CMC is slower than CoinGecko. **Plan for 8-12 weeks** end-to-end.
