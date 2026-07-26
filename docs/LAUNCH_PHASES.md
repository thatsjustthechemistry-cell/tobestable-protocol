# TOBESTABLE — Launch Phases

The **high-level view** of what happens when, and what each phase depends on.
This is the "so I know what I'm doing" document.

For the exact commands, addresses, discriminators and cost breakdowns, see
**[`MAINNET_LAUNCH.md`](MAINNET_LAUNCH.md)** — that is the authoritative runbook.
Every phase below maps to numbered Steps in it.

> **Status as of 2026-07-19:** Phase 0 is not cleared. The deploy wallet holds
> **0 SOL**. Nothing in Phase 1 can start until it is funded.

---

## Phase 0 — Before you start

**Gate: funding. Nothing else can begin.**

| Wallet | Role | Has | Needs |
|---|---|---|---|
| `BzvTL4PY…` | deploy wallet | **0 SOL** | **~6** |
| `Eis6…B5Bvf` | council #1 + team mint + **pool creator** | 0.0043 | ~0.05 **+ pool seed** |
| `8aVTS…9vwH2` | council #2 | 0.0025 | ~0.05 |
| `EnRAy…YuiXo` | council #3 | 0 | ~0.03 |

**~6.13 SOL minimum**, plus whatever you seed the pool with. The deploy wallet is the
hard blocker — it pays the ~4.53 SOL program rent. Fund it to ~6 so a failed first
deploy can be reclaimed and retried without stranding you.

**Eis6 needs more than vote money.** It creates the Raydium pool (Phase 4), which costs
the Raydium CPMM creation fee + the seed SOL itself + fees. Budget its funding from the
seed-ratio table in Phase 4 — e.g. a 1 SOL seed means Eis6 needs roughly **1.25 SOL**,
not 0.05.

> 💡 The ~1.4 SOL left in the deploy wallet after Steps 1–4 is a natural source for
> funding Eis6's pool seed, if you would rather not add new money.

**Also required before Phase 2:**

- **Rehearse Step 5.5 on devnet** and confirm the exact Program Governance address.
  Already proven end-to-end once (2026-07); redo it if anything about the DAO changed.
- **Confirm your two council partners are available.** Phase 2 cannot complete without
  their votes — you hold one key of three and cannot reach the threshold alone.

**Already done — do not redo:** keypair backups verified on drive `T:`, council
quorum fixed to 60% (true 2-of-3), branch protection hardened, 35/35 integration
tests green, announcement thread written.

---

## Phase 1 — Deploy & initialize

**Steps 1–3 · you alone · ~30 minutes · ~4.6 SOL**

1. **Deploy** the program (~4.53 SOL rent).
2. **Initialize** — creates state + vault PDAs, generates the TOBE mint, writes
   Metaplex metadata, sets the **founder** and **team** wallets.
3. **Move treasury** to the Realms vault `Cb7TsQF…` while it is still single-sig.

> 🔴 **Back up `scripts/.mainnet-mint.json` the moment Step 2 creates it.** This
> keypair does not exist until then, so it is not in the `T:` backup. Verify the copy
> with `solana address -k <path>` — filenames lie.

> If the deploy fails partway, the SOL is **not** lost — it sits in an orphaned buffer.
> Reclaim it with `solana program close --buffers` before retrying.

**End state:** the token exists. You still control everything.

---

## Phase 2 — Hand over control

**Steps 4, 5, 5.5 · needs both council partners · the highest-risk phase**

1. **Step 4** — propose the authority transfer to the Realms vault (2-step, a typo
   here is recoverable by re-proposing).
2. **Step 5** — council accepts via a 2-of-3 proposal. Verify with
   `verify-multisig.js` → must print ✅.
3. **Step 5.5** — transfer the **program upgrade authority** to the DAO.

> 🔴 **Step 5.5 is the one that can go permanently wrong.** It is a *different* power
> from Step 5: whoever holds upgrade authority can replace the entire program bytecode.
> Leaving it on the single deploy wallet makes the DAO cosmetic — the exact backdoor
> the FAQ says does not exist.
>
> A **wrong target address makes the program immutable forever** and the ~4.53 SOL rent
> unrecoverable. The target must be a Realms **Program Governance** account that can
> actually execute an "Upgrade Program" proposal. Confirm it during the devnet
> rehearsal, not on the day.

**End state:** both authorities sit with the 2-of-3 DAO. You can no longer act alone —
by design.

---

## Phase 3 — Announce 🟢

**Step 6 · the launch moment**

This is the **earliest point at which all 11 launch tweets are true**, because tweet 8
claims program *and* upgrade authority both sit with the multisig — false until Step
5.5 lands, true from here on.

**Do:**

- **Post the full 11-tweet thread** from
  [`tobe-mint/docs/launch-tweets.md`](../../tobe-mint/docs/launch-tweets.md).
  🔴 Never post it between Step 2 and Step 5.5 — the one window where tweet 8 is false.
- **Flip the frontend live** — merge `tobe-mint` PR #13, and before merging:
  swap the mainnet RPC to a websocket-capable endpoint (Helius), and replace the
  `TOBE_MINT` placeholder with the real mint from Step 2.
- **Trigger the Netlify deploy manually** — the GitHub webhook stalls.
- **Eis6 free-mints round 1** — the disclosed team allocation covers the day-one mint.

**End state:** live, announced, mintable.

---

## Phase 4 — Community takes over

**Steps 7–10 · out of your hands · pace depends entirely on demand**

- **Step 7** — people mint. Each 10 SOL round: minter gets that round's tokens, the
  vault gets the other 50%, **5 SOL → `pool_sol_reserve`**, **5 SOL → `vault_sol_reserve`**.
- **Step 8** — the first minter (or anyone holding TOBE) creates the TOBE/wSOL Raydium
  pool. External by design; `seed_pool` was removed in the M1 audit fix.
  **→ In practice this is you. See "Bootstrapping the pool" below.**
- **Step 9** — council 2-of-3 proposal runs `set_pool_config`, recording the pool and
  capturing the 30% floor baseline. Use `propose-set-pool-config.js`, not hand-typed hex.
- **Step 10** — anyone calls `flush_lp_to_raydium` once ≥1 SOL has accumulated. Deposits
  SOL+TOBE into Raydium and **burns the LP receipt — the liquidity the protocol adds is
  permanent.**

### Bootstrapping the pool — the plan (decided 2026-07-19)

`MAINNET_LAUNCH.md` says Step 8 is "paid by the community minter". That is an
assumption, not a plan: on day one there may be no outsider holding TOBE. **The plan is
that Necdet does it**, funding Eis6 separately from the deploy wallet:

1. **Eis6 free-mints** (team allocation, browser + Backpack) → receives **524,288 TOBE**
   from round 1. Costs only tx fees.
2. **Eis6 creates the pool** with part of that TOBE plus SOL funded to it separately.
3. **Burn the seed LP immediately** (see below).

> 🔑 **TOOLING BLOCKER — solve before launch day.**
> `scripts/mainnet-create-raydium-pool.js` hard-codes its signer:
> ```js
> const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
> ```
> There is no `--keypair` override, and **`id.json` is the deploy wallet, not Eis6**.
> Eis6 exists only as a Backpack seed phrase — there is no keypair file for it. Funding
> Eis6 does not fix this. Pick one **before** the day:
> - **Patch the script** to accept `--keypair` (~5 lines). Preferred — keeps
>   `.mainnet-pool.json` written automatically, which `propose-set-pool-config.js` reads.
> - **Raydium web UI** with Backpack connected. No file needed, but you must collect the
>   5 pool addresses by hand and write the JSON yourself.
> - **Export Eis6's key to a file** and point `solana config` at it. Works, but puts a
>   council key on disk.

> 💰 **Seed ratio — keep it honest.** The script default (`1000 TOBE + 0.0191 SOL`) is
> exactly what a round-1 minter pays: **10 SOL ÷ 524,288 TOBE**. Seeding *bigger* is
> good (deeper pool), but hold the ratio or you move the opening price:
>
> | SOL | Pair with | |
> |---|---|---|
> | 0.5 | 26,214 TOBE | |
> | 1 | 52,429 TOBE | |
> | 5 | 262,144 TOBE | |
> | 10 | 524,288 TOBE | the entire round-1 free mint |
>
> ⚠️ Seeding **above** this ratio prices team-allocated tokens higher than minters paid.
> That is the one version of this that reads badly, and it is visible on-chain forever.

> 🔥 **BURN THE SEED LP — do not skip.** Whoever creates the pool receives LP tokens, and
> `flush_lp_to_raydium` burns only the **protocol's** LP, never yours. Left alone, the
> team holds a withdrawable liquidity position — exactly the shape that gets screenshotted
> as a rug vector. Burn it right after Step 8:
> ```bash
> spl-token burn <LP_TOKEN_ACCOUNT> <AMOUNT>
> ```
> Keep the tx signature. This is what makes the launch thread's "no LP exists in anyone's
> wallet, including mine" answer true — see `tobe-mint/docs/launch-thread-postable.md`.

Your only *protocol* involvement is the Step 9 council vote — but the pool itself is
yours to create.

> ⛽ **Reserves stay empty until a real buyer arrives.** `flush_lp_to_raydium` needs
> **≥1 SOL in `pool_sol_reserve`**, and that only fills from **paid** mints (5 SOL per
> 10 SOL round). **Team free mints contribute nothing** — `lib.rs:300`: *"Team free
> rounds transfer nothing — no SOL enters either reserve."* So until one external minter
> pays 10 SOL, there is no protocol liquidity to flush and no floor reserve building.
> That is the fair-launch design working as intended — the protocol only ever holds what
> minters put in — but it means **the first paid mint is a genuine external dependency**
> that no amount of founder funding can substitute for.

> 🔴 **STEP 9 IS ONE-WAY. The pool you record is the protocol's pool forever.**
>
> `set_pool_config` opens with `require!(mint_state.raydium_pool_state == Pubkey::default())`
> — it only runs while the field is empty, sets it once, and **no instruction can ever
> reset or change it**. There is no `update_pool_config`, and `migrate_state_v2` only
> reallocs appended fields. The sole escape is a DAO-approved **program upgrade**.
>
> Everything downstream is bound to that one pool: every `flush_lp_to_raydium` deposit
> for the life of the protocol, `arm_floor`'s on-chain price read, and the 30% floor
> baseline captured at config time.
>
> **Before voting the Step 9 proposal through, verify the community-created pool:**
> - It is a **Raydium CPMM** pool (the contract's `AccountLoader<PoolState>` validates
>   against the mainnet CPMM program `CPMMoo8L…`; anything else is rejected outright).
> - Legs are exactly **TOBE and native wSOL**, both 9-decimal — the contract enforces
>   this, and `arm_floor`'s price math depends on the decimals cancelling.
> - The **AMM config / fee tier** is one you are willing to live with permanently. The
>   contract does *not* check this, so it is the one parameter that can be wrong in a
>   way that still passes and still binds you.
> - The pool has sane initial pricing — the baseline captured here anchors the floor.
>
> A bad pool is not recoverable by proposal. Check it before the vote, not after.

> 📈 **Other markets, for reference.** The protocol is bound to this one Raydium pool,
> but **TOBE is an ordinary SPL token** — anyone can create pools on Orca, Meteora or
> elsewhere with no protocol change and no permission. Two consequences worth knowing:
> the **$1 ceiling works on every venue automatically** (`buy_from_vault` does not care
> where you sell, so above-peg arbitrage is market-agnostic); but **protocol liquidity
> only ever flows to the Raydium pool**, so other venues live on community liquidity
> alone. Jupiter (Phase 6) is the highest-leverage move here — it is a router, not a
> venue, so it exposes TOBE to every wallet and aggregator that queries it, for free.

---

## Phase 5 — Arm the floor

**Step 11 · only once TOBE genuinely reaches $1 · could be weeks away, or never**

`sell_to_vault` (the $1 floor) is **disabled until armed** — a one-way latch. Arming is
**authority-only** (the H1 audit fix), so after migration it is a **2-of-3 council
proposal**, not permissionless.

- Pre-flight with `arm-floor.js --dry-run` to confirm TOBE/USD ≥ $1 before proposing.
- The on-chain spot check is a *secondary* guard; the council's off-chain confirmation
  (a TWAP, not spot) is the real gate.

Launch tweet 4 discloses that the floor is not live on day one. That is deliberate —
arming early was the H1 High-severity finding.

### 🔧 Post-launch incident responses (both cheap, neither needs an upgrade)

Two accepted risks from audit Round 7 have operational rather than code fixes. Full
detail in [`SECURITY.md`](../SECURITY.md); the short version, for when it matters:

| Symptom | Cause | Response |
|---|---|---|
| `sell_to_vault` fails **`VaultSolInsufficient`** — the $1 floor stops working | `vault_sol_reserve` drained. Possibly the **H3 pump**: anyone can cycle `sell_to_vault` → `buy_from_vault` at ~zero cost, moving the reserve into the DAO treasury | The reserve is a **System-owned PDA** — send SOL straight to its address from the DAO treasury. **A single 2-of-3 council transfer restores it.** No instruction, no upgrade. The funds were never stolen; they are in your own treasury |
| `flush_lp_to_raydium` fails **`ReserveDustRemainder`** | **L3** — someone sent dust to `pool_sol_reserve`; the untracked excess is non-zero but below rent-exemption, so the payout is rejected | **Anyone** can unblock it: send the PDA enough SOL to lift the excess to the rent-exempt minimum (**~0.0009 SOL**). No authority needed |

> Neither is an emergency. Both are self-healing once someone acts, and neither loses
> protocol funds. Worth knowing *before* they happen, so a routine nuisance is not
> mistaken for an exploit on launch day.

---

## Phase 6 — Listings

**Post-launch · gated on real liquidity and volume, not paperwork**

| Where | Opens | Bar |
|---|---|---|
| **Jupiter Verified** | 7d after pool | >$1k liquidity — **do this first**, it drives the wallet checkmark |
| **CoinGecko** | 7d after pool | >$1k liquidity, ~$10k volume |
| **CoinMarketCap** | **30d** | >$10k liquidity, ~$100k/24h volume preferred |

⚠️ **Do not submit to CMC early** — there is a 60-day resubmit cooldown, and its bar is
an adoption threshold, not a form-filling exercise.

Packets are pre-filled in [`docs/listings/`](listings/). The scheduled
`tobe-listing-windows` task reports which windows are actually open.

---

## The shape of it

**Phases 1–3 are one focused session** — deploy through announce, gated on ~6 SOL and
on both council partners being available to vote.

**Phase 4 onward runs on its own schedule.** You are a participant, not the driver.

**Three moments carry irreversible risk.** Everything else is retryable:

| When | What goes wrong | Recoverable? |
|---|---|---|
| **Step 5.5** | wrong upgrade-authority target | ❌ program immutable forever, ~4.53 SOL lost |
| **Step 9** | a bad pool recorded by `set_pool_config` | ⚠️ only via a DAO program upgrade |
| **After Phase 2** | 2 of 3 council keys lost | ❌ governance frozen permanently |

Step 5.5 and Step 9 are both *one-shot writes you vote through* — the moment to catch a
mistake is while reading the proposal, not after executing it.
