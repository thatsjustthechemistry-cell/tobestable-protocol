# Launch Announcement — draft

> Post **after** the chain state is final (program deployed, initialized, treasury → Realms, authority → Realms). Every link below must resolve before you post, or the "is it real?" replies will bury you.
>
> Two spots need **your voice** — marked `<<YOUR VOICE>>`. Everything else is fill-in-the-blank (replace `<MINT>` etc. with the real addresses from launch).
>
> **Tone rule:** honest > hype. The differentiator here is that the claims are *true and verifiable*, post-UST. Do not call it a "guaranteed $1 stablecoin" — it isn't, and the FAQ/contract say so. Call it what it is.

---

## A. Main X thread (English, pin this)

**1/ Hook**
`<<YOUR VOICE — one punchy line on what TOBESTABLE is and why you built it. Default below; rewrite in your voice.>>`
> TOBESTABLE ($TOBE) is live on Solana. A fair-launch token with an on-chain $1 reference — a hard ceiling, a reserve-backed floor, no team allocation, no presale, multisig-governed. Built to be honest about what it is.

**2/ What it actually is (no overclaiming)**
TOBE isn't a fiat-backed stablecoin and it isn't a "guaranteed $1" coin. It's an anti-inflationary token with an on-chain mechanism that pushes price toward $1 — strongly from above, partially from below. Here's exactly how 👇

**3/ The ceiling (strong)**
Above $1, anyone can buy TOBE from the protocol vault at exactly $1 and sell on the open market — arbitrage that caps the price near $1. The vault holds 50% of every mint, so this side is deep. TOBE rarely trades above $1.

**4/ The floor (honest about its limits)**
Below $1, anyone can buy cheap TOBE and sell it to the vault at $1, drawn from an on-chain SOL reserve (5 SOL accrues per mint round). This floor is real but **bounded by the reserve** — it defends as far as the reserve reaches, not infinitely. It also only activates once TOBE first reaches $1. We say this plainly because pretending otherwise is how UST died.

**5/ Fair launch — the numbers**
1,024 mint rounds. Every round costs 10 SOL. Round 1 mints 524,288 TOBE; each round mints fewer (anti-inflationary curve), down to 512 in round 1,024. 50% to the minter, 50% to the protocol vault. No presale. No team tokens. No SOL to the team from mints.

**6/ Permanent liquidity**
Half of every mint's SOL accumulates and is deposited into a Raydium TOBE/SOL pool — and the LP tokens are **burned**. The liquidity is locked forever; nobody, including me, can pull it.

**7/ Governance (honest)**
Program authority and treasury are held by a 2-of-3 Realms multisig from day one — no single key can mint extra, drain the vault, or change the rules. `<<YOUR VOICE — state plainly whether the 3 council keys are all yours (bootstrap) or include others, and your hardening plan. Default below.>>`
> The council is currently a 2-of-3 self-multisig (bootstrap); I'm hardening to hardware-isolated keys within 30 days, via on-chain vote.

**8/ What's locked vs changeable**
Locked in code forever: the 1,024-round supply curve, the $1 peg math, the burned liquidity. Changeable only by 2-of-3 council vote: treasury address, pool config, emergency pause. All on-chain, all verifiable.

**9/ Audited (honestly described)**
The program was self-audited across 8 vulnerability classes with adversarial verification, and every finding fixed (report in the repo). This is an AI-assisted self-audit, **not** a paid professional audit — I'm telling you that rather than implying a clean bill of health I didn't buy.

**10/ Verify everything (don't trust, check)**
- Program: `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`
- TOBE mint: `<MINT — from launch>`
- Realms DAO: https://v2.realms.today/dao/9VUbq5QHSPezGPseqY1kgrwSVLGtndk3XT1y3dfMB5o
- Council mint: `2ZdbLGkKi1Zvk5dKLqcY5UBcDdJVss8u2tGmMnN3gRHN` (supply 3, 2-of-3)
- Treasury/authority: `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC`
- Code + audit: https://github.com/thatsjustthechemistry-cell/tobestable-protocol

**11/ How to participate + roadmap**
Mint or buy at https://tobestable.com. `<<YOUR VOICE — what you'll actually be doing post-launch; set honest expectations. Default below.>>`
> The protocol runs itself permissionlessly. I'll keep the site + docs current and harden governance. No promises I can't keep on-chain.

**12/ CTA**
If "verifiable, honest, fair-launch" is the kind of thing you've been waiting for in this space — this is it. Repost so the people who care about *checkable* claims see it. 🜂

---

## B. Condensed version (for translated posts — ZH / KO / JA / ES; ~3 tweets each)

**1/** TOBESTABLE ($TOBE) is live on Solana — a fair-launch token with an on-chain $1 reference: a hard ceiling above $1, a reserve-bounded floor below. No presale, no team tokens, no SOL to the team. Multisig-governed.

**2/** 1,024 mint rounds, 10 SOL each, decreasing supply per round (anti-inflationary). 50% to minter, 50% to the protocol vault. Liquidity on Raydium with LP burned (locked forever). The floor is real but bounded by its SOL reserve — we say so plainly.

**3/** Don't trust, verify: program `Eekx6ftd…`, Realms DAO + treasury on-chain, code + self-audit on GitHub. Mint/buy: tobestable.com

*(Use the existing `lang.js` translations as the source for native wording of the key terms — hard ceiling / reserve-bounded floor / fair launch.)*

---

## C. GitHub README / pinned-post one-liner

> **$TOBE** — a fair-launch Solana token with an on-chain $1 reference (hard ceiling, reserve-bounded floor), 1,024 decreasing mint rounds, permanently burned Raydium liquidity, and 2-of-3 multisig governance. No presale, no team allocation. Self-audited; verify on-chain.

---

## Posting checklist
- [ ] All chain state final (deploy → init → treasury → authority) and every address below filled in + verified clickable
- [ ] `<MINT>` replaced with the real mainnet TOBE mint
- [ ] Both `<<YOUR VOICE>>` spots rewritten in your words
- [ ] Tweet 10 links open and resolve (Solscan/Realms/GitHub)
- [ ] Logo renders (token shows "TOBESTABLE", not "Unknown") — confirms metadata is live
- [ ] Pin tweet 1; post condensed translated versions as replies or separate posts
- [ ] Submit token info to DexScreener/Birdeye once the pool has trades
