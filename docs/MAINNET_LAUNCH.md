# Mainnet Launch Runbook

> **Status:** Pre-launch reference. Execute step-by-step on launch day.
> **Model:** Pure no-mint fair launch — no founder mints, no founder pool seeding. The community mints; the first minter (or anyone) creates the Raydium pool. `seed_pool` is NOT used.
> **Audit:** Self-audited across all 8 vulnerability classes + a focused CPI/token re-audit; every confirmed finding fixed. See [`SELF_AUDIT.md`](./SELF_AUDIT.md). This is an AI-assisted self-audit, not a professional audit.

## Constants

| | |
|---|---|
| Program ID | `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX` |
| Realms council vault (treasury + new authority) | `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` |
| Realms council mint | `2ZdbLGkKi1Zvk5dKLqcY5UBcDdJVss8u2tGmMnN3gRHN` |
| Realms threshold | 2-of-3 |
| Council members | `Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf`, `8aVTS6eVvC33wZ4viwAfm6a9ZAXDXUKWvXtto4dFzquE`, `EnRAymUEDWkT5kdfSveUmNEwgfsA6Y53JVqTeSpYuiXo` |
| Deployer wallet | `BzvTL4PYZzBPs51jmd2LwMYeDDbu319XmHrDLJFEuZzh` (yours; verify `solana address`) |
| Program keypair | `target/deploy/neco_token-keypair.json` (LOCAL ONLY — back up!) |

## Pre-launch checklist (do BEFORE Step 1)

- [ ] **Fund deployer** `BzvTL4PY...` with **≥5 SOL** mainnet: `solana balance --url mainnet-beta` (deploy briefly needs ~2× the program rent)
- [ ] **Back up `target/deploy/neco_token-keypair.json`** to 2 offline locations (controls the program ID)
- [ ] **Fund council wallet** `8aVTS...` (currently 0 SOL) so it can pay fees to vote
- [ ] **Council key isolation** — confirm the 3 council keys live on separate devices (or accept "bootstrap multisig" with a written 30-day hardening plan)
- [ ] **Governance rehearsal on devnet** — `npm install @solana/spl-governance`, then run the full propose → vote → execute → verify cycle on a devnet realm using `scripts/propose-accept-authority.js`
- [ ] **Build with the current toolchain** (the one that builds locally / in CI — do NOT pin an old Solana, it resurfaces the `edition2024` build failure)
- [ ] Public announcement drafted
- [ ] ≥1 day-one minter lined up (10 SOL each)
- [ ] (Optional but recommended) branch protection enabled on `main` requiring the `cargo check + test` CI check

## Step 1 — Deploy

```bash
cd C:/Users/NeCDeT/Desktop/tobestable-protocol
anchor build
anchor deploy --provider.cluster mainnet
```

**Cost:** ~2.5–3.3 SOL (program rent). **Verify:** `solana program show Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX --url mainnet-beta`

## Step 2 — Initialize

```bash
node scripts/mainnet-initialize.js
```

**Cost:** ~0.05 SOL. **Effect:** creates state PDA + vault PDAs + Metaplex metadata, generates the TOBE mint, saves the mint keypair to `scripts/.mainnet-mint.json`.
**➡️ BACK UP `scripts/.mainnet-mint.json`** (and note the printed mint_state PDA + TOBE mint pubkey — needed below).

## Step 3 — Move treasury to the Realms vault

```bash
node scripts/mainnet-update-treasury.js
```

**Effect:** `mint_state.treasury` → `Cb7TsQF...`. Do it now (single-sig) so arbitrage proceeds flow to the DAO before authority handoff.

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

## Step 6 — 🟢 Fully fair-launched

Authority = Realms multisig, treasury = Realms vault, vault empty, no pool yet. **Announce.** From here, admin instructions (`set_pool_config`, `pause`, `update_treasury`) require a 2-of-3 council proposal.

## Step 7 — Community mints

Out of your hands. Each 10-SOL mint: minter gets round tokens, vault gets the other 50%, 5 SOL → `pool_sol_reserve`, 5 SOL → `vault_sol_reserve`, `current_round`++.

## Step 8 — Community creates the Raydium pool

The first minter (or anyone with TOBE) creates the TOBE/wSOL pool:
```bash
TOBE_MINT=<mainnet TOBE mint from Step 2> node scripts/mainnet-create-raydium-pool.js
```
Prints 5 pool addresses → `scripts/.mainnet-pool.json`. **No `seed_pool` is called — the pool is external.**

## Step 9 — Council proposal: `set_pool_config`

Authority is now Realms, so this is a council proposal. Custom instruction:
- **Program:** `Eekx6ftd...`
- **Data (hex):** `d857417d716eb978` + `01` if `tobeIsToken0` (from `.mainnet-pool.json`) is true, else `00`
- **Accounts:** (1) `Cb7TsQF...` authority ✅✅ · (2) mint_state PDA ❌✅ · (3) `raydium_pool_state` · (4) `raydium_pool_authority` · (5) `raydium_lp_mint` · (6) `raydium_token_0_vault` · (7) `raydium_token_1_vault` (3–7 ❌❌)

Records the pool + captures the 30%-floor baseline (`vault_tobe_at_config`) from the current vault balance. (No longer gated on `pool_seeded` — fixed for the fair-launch flow.) After this, `flush_lp_to_raydium` is callable.

## Step 10 — Anyone calls `flush_lp_to_raydium` (permissionless)

Once `pool_sol_balance` ≥ 1 SOL. **Signature now takes `max_tobe_to_pair: u64`** (slippage bound) — a keeper computes it from current pool reserves + ~2% tolerance (see `scripts/devnet-set-pool-config-and-flush.js` for the calc). The frontend button supplies it. Deposits SOL+TOBE into Raydium and burns the LP (permanent liquidity); unconsumed wSOL returns to `pool_sol_reserve`.

## Step 11 — Arm the $1 floor (permissionless, once TOBE reaches $1)

`sell_to_vault` (the $1 floor) is **disabled until TOBE first reaches $1** — a one-way latch that blocks the early below-peg drain. Once the market price reaches $1, anyone calls `arm_floor` to enable it permanently:
- **Discriminator:** `cbf35c2766bfc696`, no args
- Reads the pool vaults (validated against config) × Pyth SOL/USD; sets `floor_active = true` if TOBE/USD ≥ $1.
- Run `node scripts/arm-floor.js` (use `--dry-run` first to confirm TOBE/USD ≥ $1 before sending).

## Admin instruction discriminators (for Realms proposals)

| Instruction | Discriminator | Args | Use |
|---|---|---|---|
| `accept_authority` | `6b56c65b210c6ba0` | — | Step 5 |
| `set_pool_config` | `d857417d716eb978` | `tobe_is_token_0: bool` | Step 9 |
| `arm_floor` | `cbf35c2766bfc696` | — | Step 11 (permissionless) |
| `flush_lp_to_raydium` | `1324c3f558c78cd9` | `max_tobe_to_pair: u64` | Step 10 (permissionless) |
| `update_treasury` | `3c10f342603bfe83` | `new_treasury: pubkey` | Redirect proceeds |
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
| 1 Deploy | ~2.5–3.3 | ~$175–230 |
| 2 Initialize | ~0.05 | ~$3.50 |
| 3 Update treasury | <0.01 | — |
| 4 Propose authority | <0.01 | — |
| 5 Accept (council) | <0.01 | from council deposits |
| **Your total (steps 1–4)** | **~3.4 SOL** | **~$240** |

Pool seed (Step 8) + `set_pool_config` (Step 9) are paid by the community minter / council.

## Frontend update (after Step 2)

In `tobe-mint` (both root + `tobestable/`):
- Program ID `CfdXZe...` (devnet) → `Eekx6ftd...`
- TOBE mint → the new mainnet mint from Step 2
- `NETWORK` constant → `'mainnet'`
- Bump cache-bust `lang.js?v=...`

## Listings (after pool live + ~7 days activity)

Jupiter verified list → CoinGecko (~1 wk later) → CoinMarketCap (~1 mo after CG). See `docs/listings/`. Then update `tobe-mint/token-metadata.json` extensions (socials, CG/CMC IDs).
