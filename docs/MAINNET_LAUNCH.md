# Mainnet Launch Runbook

> **Status:** Pre-launch reference. Execute step-by-step on launch day.
> **Model:** Pure no-mint fair launch — no founder mints, no founder pool seeding. The community mints; the first minter (or anyone) creates the Raydium pool. `seed_pool` has been **removed** (M1 audit fix — it was a legacy authority fund-movement primitive, unused by this flow).
> **Audit:** Self-audited across all 8 vulnerability classes + a focused CPI/token re-audit; every confirmed finding fixed. See [`SELF_AUDIT.md`](./SELF_AUDIT.md). This is an AI-assisted self-audit, not a professional audit.

## Constants

| | |
|---|---|
| Program ID | `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX` |
| Realms council vault (treasury + new authority) | `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` |
| Realms council mint | `2ZdbLGkKi1Zvk5dKLqcY5UBcDdJVss8u2tGmMnN3gRHN` |
| Realms threshold | 2-of-3 |
| Council members | `Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf`, `8aVTS6eVvC9VjP6pKsvHqgJfH2i7VwF8YMCvafp9vwH2`, `EnRAymUEDWkT5kdfSveUmNEwgfsA6Y53JVqTeSpYuiXo` |
| Deployer wallet | `BzvTL4PYZzBPs51jmd2LwMYeDDbu319XmHrDLJFEuZzh` (yours; verify `solana address`) |
| Program keypair | `target/deploy/neco_token-keypair.json` (LOCAL ONLY — back up!) |

## Pre-launch checklist (do BEFORE Step 1)

> **Funding status — live-verified on mainnet-beta 2026-07-18.** The one hard blocker is the deployer at 0 SOL. Total to clear all funding gates: **≈ 6.13 SOL** (mostly the deployer). Re-check with `solana balance <PUBKEY> --url mainnet-beta` before sending.

- [ ] **🔴 Fund deployer** `BzvTL4PY...` with **~6 SOL** — *currently 0 SOL (2026-07-18), send the full ~6.* Deploy rent for the current 650 KB program is **~4.53 SOL** (recomputed 2026-07; the old "3.4 SOL total" is stale). 6 SOL covers deploy + init + a failed-deploy retry with headroom; 5 leaves almost no margin. **This gates Step 1 — nothing deploys until it's funded.**
- [ ] **Fund the 3 council wallets** so each can pay fees to vote (live balances 2026-07-18):
  - `Eis6...5Bvf` — 0.0043 SOL → send **~0.05** (also the disclosed team-allocation wallet: it does the day-one free mints, so it needs fee + ATA-rent headroom)
  - `8aVTS...9vwH2` — 0.0025 SOL → send **~0.05**
  - `EnRAy...YuiXo` — 0 SOL → send **~0.03**
- [ ] **Back up `target/deploy/neco_token-keypair.json`** to 2 offline locations (controls the program ID) — *memory notes this is unconfirmed; verify a real offline copy exists.*
- [ ] **Council key isolation** — confirm the 3 council keys live on separate devices (or accept "bootstrap multisig" with a written 30-day hardening plan)
- [x] **Governance propose → vote → execute rehearsed on devnet — ✅ DONE 2026-07.** Proven twice: the Step 5.5 upgrade-authority cycle (below) and a native-treasury `set_pool_config` council proposal (2-of-3 vote → execute → CPI signing all confirmed). `@solana/spl-governance` is a declared dep.
- [x] **🔴 Upgrade-authority handoff rehearsed on devnet (Step 5.5) — ✅ DONE 2026-07.** Full cycle proven on the devnet program (create governance over program → `set-upgrade-authority --skip-new-upgrade-authority-signer-check` to the governance PDA → 2-of-3 Upgrade Program proposal → execute → real upgrade landed → reversed). The verified flow + gotchas are in Step 5.5. **On mainnet you still MUST do Step 5.5 for real** — both `mint_state.authority` (Step 5) AND the program upgrade authority (Step 5.5) must go to the DAO; shipping with single-key upgrade authority is the backdoor the FAQ says doesn't exist. Confirm the exact `<DAO_PROGRAM_GOVERNANCE>` target (a wrong target permanently bricks upgrades).
- [ ] **arm_floor authority gate — devnet-prove before mainnet.** The H1 authority gate now has Rust unit tests for the arming *math* (CI-verified, `pyth_math_tests::arm_gate_*`), but the *authorization* rejection can't run under localnet (needs real Pyth+Raydium). Run it once on devnet: sign `arm_floor` with a non-authority keypair (extend `scripts/arm-floor.js`) → expect `Unauthorized`, and confirm `floor_active` stays false. Runbook is in `tests/neco_token.ts` (§9b).
- [ ] **Build with the current toolchain** (the one that builds locally / in CI — do NOT pin an old Solana, it resurfaces the `edition2024` build failure)
- [x] **Public announcement drafted** — 10-tweet launch blast in `tobe-mint/docs/launch-tweets.md` (discloses team allocation + founder revenue; website + Telegram links).
- [x] **Day-one mint covered** — obsoleted the "line up an external 10-SOL minter": the disclosed team allocation lets `Eis6...` free-mint immediately after Step 2, so it *is* the day-one mint (just fund it for fees, above).
- [x] **Branch protection enabled on `main`** — requires the `cargo check + test` CI check (strict mode); force-push + deletion blocked. Done 2026-07-08. (`enforce_admins` still false — admins can bypass.)

## Step 1 — Deploy

```bash
cd C:/Users/NeCDeT/Desktop/tobestable-protocol
anchor build
anchor deploy --provider.cluster mainnet
```

**Cost:** ~4.53 SOL (program rent for the 650 KB `.so`; locked in the ProgramData account, not burned — reclaimable only by `solana program close`, which destroys the program). **Verify:** `solana program show Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX --url mainnet-beta`

**If the deploy fails partway** (network/timeout), the SOL is NOT lost — it sits in an orphaned buffer account. Reclaim it before retrying:
```bash
solana program show --buffers --url mainnet-beta   # find stranded buffers
solana program close --buffers --url mainnet-beta  # refund them to your wallet
```

## Step 2 — Initialize

```bash
# --founder sets the wallet that receives 50% of buy_from_vault proceeds
# (disclosed founder fee). Defaults to the signer if omitted.
node scripts/mainnet-initialize.js [--founder <FOUNDER_WALLET>]
```

**Cost:** ~0.05 SOL. **Must be run by the deploy wallet** — `initialize` is bound in-code to the program's upgrade authority (RA-1 fix), so only the deployer can initialize; this closes the deploy-window front-run. **Effect:** creates state PDA + vault PDAs + Metaplex metadata, generates the TOBE mint, saves the mint keypair to `scripts/.mainnet-mint.json`, and sets the **founder revenue wallet** (50% of `buy_from_vault` proceeds; the other 50% goes to `treasury` set in Step 3). Founder is changeable later via `update_founder` (authority/council).
**➡️ BACK UP `scripts/.mainnet-mint.json`** (and note the printed mint_state PDA + TOBE mint pubkey — needed below).

## Step 3 — Move treasury to the Realms vault

```bash
node scripts/mainnet-update-treasury.js
```

**Effect:** `mint_state.treasury` → `Cb7TsQF...`. Do it now (single-sig) so the **DAO's 50%** of `buy_from_vault` proceeds flows to the DAO before authority handoff. (The other 50% goes to the founder wallet set in Step 2 — a disclosed founder fee. See FAQ/SECURITY.md.)

## Step 4 — Propose authority transfer

```bash
node scripts/propose-authority.js --network mainnet \
  --new-authority Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC
```

**Effect:** `mint_state.pending_authority` → Realms vault. You retain control until Step 5 completes (2-step transfer; a typo here is recoverable by re-proposing).

## Step 5 — Council accepts authority

Preferred (scripted; run as a council member, after the devnet rehearsal):

```bash
node scripts/propose-accept-authority.js --vote \
  --description-link <optional URL>
```

This creates a Realms proposal that calls `accept_authority`, signs it off, and casts your yes vote. One more council member votes yes, then anyone executes.

Then verify:
```bash
node scripts/verify-multisig.js --network mainnet --expected Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC
```
Should print `✅`.

<details><summary>Manual Realms-UI fallback</summary>

Custom instruction — Program `Eekx6ftd...`, data (hex) `6b56c65b210c6ba0`, accounts:
| # | Address | Signer | Writable |
|---|---|---|---|
| 1 | `Cb7TsQF...` (new_authority) | ✅ | ❌ |
| 2 | mint_state PDA | ❌ | ✅ |
</details>

## Step 5.5 — Transfer PROGRAM UPGRADE authority to the DAO (do NOT skip)

> **Why this is its own step:** Step 5 handed off `mint_state.authority` (the app-level admin: `pause`, `update_treasury`, `set_pool_config`, `arm_floor`). That is a *different* power from the **BPF-loader program upgrade authority**, which by default is still the single deploy wallet `BzvTL4PY...`. Whoever holds the upgrade authority can **replace the entire program bytecode** — mint infinite TOBE, drain every vault, delete the 2-of-3 checks. Leaving it on a single key makes the DAO cosmetic and is the exact single-key backdoor the FAQ says does not exist. **Both authorities must land on the DAO.**

Transfer the upgrade authority to the DAO so future upgrades require a 2-of-3 Realms **program-upgrade** proposal. In governance **v3 this is a TWO-STEP flow** (the old bundled `CreateProgramGovernance` instruction was removed):

1. In Realms (or via SDK) create a **governance over the program** — this yields the governance PDA that will hold the upgrade authority. Easiest: the Realms **"New → Program"** wizard, which derives the PDA and does step 2 for you.
2. Point the program's upgrade authority at that PDA:

```bash
# Run by the CURRENT upgrade authority (the deploy wallet).
# --skip-new-upgrade-authority-signer-check is REQUIRED: the governance PDA
# cannot interactively co-sign the transfer. (This flag also removes the
# safety net — hence the "confirm the exact target" warning below.)
solana program set-upgrade-authority Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX \
  --new-upgrade-authority <DAO_PROGRAM_GOVERNANCE> \
  --skip-new-upgrade-authority-signer-check --url mainnet-beta
```

**Verify:** `solana program show Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX --url mainnet-beta` → `Authority:` must equal the DAO governance PDA.

> ✅ **REHEARSED END-TO-END ON DEVNET (2026-07, verified).** On the devnet program `CfdXZe...`: stood up a fresh 2-of-3 Realms multisig, created a generic **governance over the program** (PDA revealed), ran the exact `set-upgrade-authority ... --skip-new-upgrade-authority-signer-check` above (authority moved to the governance PDA, confirmed by reading ProgramData), then created an **Upgrade Program proposal → 2-of-3 YES → execute** — a real upgrade landed (ProgramData deployed-slot advanced), then reversed it back via a second proposal. So the whole flow works; the only gotchas found: (a) `npm install @solana/spl-governance` first (it was missing), (b) governance version auto-detect defaults to 1 on a rate-limited RPC — pin **v3**, (c) after the 2nd vote you may need to wait ~6s past the hold-up window before `execute` succeeds.

> ⚠️ **CRITICAL — a wrong target permanently bricks upgrades (worse than the backdoor).** `<DAO_PROGRAM_GOVERNANCE>` must be an account **Realms can actually sign for and execute an "Upgrade Program" proposal against** — typically a **Program Governance** account created in the Realms DAO (New → Program governance), NOT a random PDA and NOT the raw treasury vault unless you've confirmed Realms can upgrade through it. If you send upgrade authority to an account nobody can sign for, the program is **immutable forever** and the ~4.53 SOL rent is unrecoverable. **This MUST be rehearsed end-to-end on devnet** (transfer authority → create a program-upgrade proposal → 2-of-3 vote → execute an actual upgrade) BEFORE doing it on mainnet. Confirm the exact `<DAO_PROGRAM_GOVERNANCE>` address during that rehearsal.
>
> The **program keypair** (`neco_token-keypair.json`) is still required for upgrades — transferring upgrade authority does **not** remove that requirement. Keep it backed up offline.
>
> **Future:** once TOBE has run cleanly for a while and the code is battle-tested, the DAO can vote to make the program **immutable** (`set-upgrade-authority ... --final`) for maximal trustlessness. Do not do this now — you just fixed a High-severity finding (H1); keep the ability to patch bugs under the multisig first.

## Step 6 — 🟢 Fully fair-launched

Authority = Realms multisig (**both** `mint_state.authority` AND the program upgrade authority — see Step 5.5), treasury = Realms vault, vault empty, no pool yet. **Announce.** From here, admin instructions (`set_pool_config`, `pause`, `update_treasury`) require a 2-of-3 council proposal, and so do **program upgrades**.

## Step 7 — Community mints

Out of your hands. Each 10-SOL mint: minter gets round tokens, vault gets the other 50%, 5 SOL → `pool_sol_reserve`, 5 SOL → `vault_sol_reserve`, `current_round`++.

## Step 8 — Community creates the Raydium pool

The first minter (or anyone with TOBE) creates the TOBE/wSOL pool:
```bash
TOBE_MINT=<mainnet TOBE mint from Step 2> node scripts/mainnet-create-raydium-pool.js
```
Prints 5 pool addresses → `scripts/.mainnet-pool.json`. **The pool is external — `seed_pool` was removed (M1 audit fix).**

## Step 9 — Council proposal: `set_pool_config`

Authority is now Realms, so this is a council proposal.

**Preferred (scripted; run as a council member, after Step 8):**
```bash
node scripts/propose-set-pool-config.js [--vote]
```
Reads `scripts/.mainnet-pool.json` (written by Step 8), builds the `set_pool_config` instruction via the program's IDL, and wraps it in a Realms proposal — no hand-typed hex or manually-ordered accounts. `--vote` also casts your yes vote in the same run. One more council member votes yes, then anyone executes.

<details><summary>Manual Realms-UI fallback (raw instruction, if the script is unavailable)</summary>

- **Program:** `Eekx6ftd...`
- **Data (hex):** `d857417d716eb978` + `01` if `tobeIsToken0` (from `.mainnet-pool.json`) is true, else `00`
- **Accounts:** (1) `Cb7TsQF...` authority ✅✅ · (2) mint_state PDA ❌✅ · (3) `raydium_pool_state` · (4) `raydium_pool_authority` · (5) `raydium_lp_mint` · (6) `raydium_token_0_vault` · (7) `raydium_token_1_vault` (3–7 ❌❌)

Verified byte-for-byte against the built IDL (discriminator, arg encoding, account order, and every signer/writable flag) — accurate as of the current contract.
</details>

Records the pool + captures the 30%-floor baseline (`vault_tobe_at_config`) from the current vault balance. (No longer gated on `pool_seeded` — fixed for the fair-launch flow.) After this, `flush_lp_to_raydium` is callable.

> **Rehearsal note:** the governance mechanics (proposal → 2-of-3 vote → the treasury PDA's CPI-signed execution) were proven end-to-end on devnet — the transaction reached deep inside `set_pool_config`, confirming the authority signer check passes correctly for a real governance-executed call. The one check that could NOT be devnet-tested is Raydium pool ownership: the contract's `AccountLoader<PoolState>` validates against the **mainnet** Raydium CPMM program ID (hardcoded in the `raydium-cp-swap` dependency), and devnet's Raydium CPMM is a different program entirely — so a devnet-created pool is structurally rejected by design. This is a security feature (rejects spoofed pool accounts), not a gap in this script.

## Step 10 — Anyone calls `flush_lp_to_raydium` (permissionless)

Once `pool_sol_balance` ≥ 1 SOL. **Signature now takes `max_tobe_to_pair: u64`** (slippage bound) — a keeper computes it from current pool reserves + ~2% tolerance (see `scripts/devnet-set-pool-config-and-flush.js` for the calc). The frontend button supplies it. Deposits SOL+TOBE into Raydium and burns the LP (permanent liquidity); unconsumed wSOL returns to `pool_sol_reserve`.

## Step 11 — Arm the $1 floor (COUNCIL 2-of-3, once TOBE reaches $1)

`sell_to_vault` (the $1 floor) is **disabled until TOBE first reaches $1** — a one-way latch that blocks the early below-peg drain. Arming it is **authority-only (H1 audit fix)**: after migration the authority is the Realms vault, so this is a **2-of-3 council proposal**, not permissionless. This closes the flash-manipulation path where anyone could skew the pool spot ratio across $1 and latch the floor early to unlock a `vault_sol_reserve` drain.
- **Discriminator:** `cbf35c2766bfc696`, no args
- Custom instruction accounts: (1) `Cb7TsQF...` authority ✅ signer · (2) mint_state PDA ❌✅ writable · (3) `raydium_token_0_vault` · (4) `raydium_token_1_vault` · (5) Pyth SOL/USD price update (posted via Hermes)
- On-chain it still reads the pool vaults × Pyth SOL/USD as a **secondary guard** (`floor_active = true` only if TOBE/USD ≥ $1), but the council's off-chain confirmation (a TWAP, not spot) is the real gate.
- Pre-flight: `node scripts/arm-floor.js --dry-run` confirms TOBE/USD ≥ $1 before the council proposes.

## Admin instruction discriminators (for Realms proposals)

| Instruction | Discriminator | Args | Use |
|---|---|---|---|
| `accept_authority` | `6b56c65b210c6ba0` | — | Step 5 |
| `set_pool_config` | `d857417d716eb978` | `tobe_is_token_0: bool` | Step 9 |
| `arm_floor` | `cbf35c2766bfc696` | — | Step 11 (council 2-of-3, authority-only) |
| `flush_lp_to_raydium` | `1324c3f558c78cd9` | `max_tobe_to_pair: u64` | Step 10 (permissionless) |
| `update_treasury` | `3c10f342603bfe83` | `new_treasury: pubkey` | Redirect the DAO's 50% of `buy_from_vault` proceeds |
| `update_founder` | `5a715db1dc38ff70` | `new_founder: pubkey` | Redirect the founder's 50% of `buy_from_vault` proceeds |
| `pause` | `d316ddfb4a79c12f` | — | Emergency stop (now gates mint + all fund-moving ix) |
| `unpause` | `a99004260a8dbcff` | — | Resume |

## Rollback / recovery

- **Before Step 5 (you still hold authority):** fix anything with admin instructions; worst case `pause`, redeploy with fixes (program is upgradeable until upgrade authority is rotated), `unpause`.
- **Wrong pending authority (Step 4 typo):** re-run `propose-authority.js` with the correct pubkey — the 2-step pattern overwrites until `accept_authority` runs.
- **Step 5 never reaches quorum:** `pending_authority` sits harmlessly; you retain control. Re-propose or get votes.
- **Lost program keypair after deploy:** can't upgrade anymore (existing functionality keeps working). Don't lose it.
- **Lost TOBE mint keypair:** harmless — mint authority is a PDA, not the keypair.

## Estimated cost (SOL ≈ $70)

| Step | SOL | USD |
|---|---|---|
| 1 Deploy | ~4.53 | ~$317 |
| 2 Initialize | ~0.05 | ~$3.50 |
| 3 Update treasury | <0.01 | — |
| 4 Propose authority | <0.01 | — |
| 5 Accept (council) | <0.01 | from council deposits |
| **Your total (steps 1–4)** | **~4.6 SOL** | **~$322** |

> **Fund ~6 SOL** (not the bare ~4.6) so a failed first deploy can be reclaimed + retried without stranding you. The ~4.53 SOL deploy cost is locked rent keeping the program alive, not a burn — only tx fees (pennies) are truly spent. The one real loss vector is losing `neco_token-keypair.json` (then the rent is unrecoverable) — back it up offline first.

Pool seed (Step 8) + `set_pool_config` (Step 9) are paid by the community minter / council.

## Frontend update (after Step 2)

In `tobe-mint` (both root + `tobestable/`):
- Program ID `CfdXZe...` (devnet) → `Eekx6ftd...`
- TOBE mint → the new mainnet mint from Step 2
- `NETWORK` constant → `'mainnet'`
- Bump cache-bust `lang.js?v=...`

## Listings (after pool live + ~7 days activity)

Jupiter verified list → CoinGecko (~1 wk later) → CoinMarketCap (~1 mo after CG). See `docs/listings/`. Then update `tobe-mint/token-metadata.json` extensions (socials, CG/CMC IDs).
