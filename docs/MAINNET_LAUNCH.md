# Mainnet Launch Runbook

> **Status:** Pre-launch reference. Execute step-by-step on launch day.
> **Decisions baked in:** Treasury = single key first → Realms (Decision 1A). Pure no-mint fair launch (Decision 2A — no founder mints, no founder pool seeding).
> **Audit:** Skipped (user choice).

## Constants (locked in PR #7)

| | |
|---|---|
| Program ID | `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX` |
| Realms council vault | `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` |
| Realms threshold | 2-of-3 |
| Current deployer wallet | `BzvTL4PYZzBPs51jmd2LwMYeDDbu319XmHrDLJFEuZzh` (yours; verify with `solana address`) |
| Program keypair | `target/deploy/neco_token-keypair.json` (LOCAL ONLY — back up!) |

## Pre-launch checklist (do BEFORE Step 1)

- [ ] `target/deploy/neco_token-keypair.json` backed up to 2 offline locations
- [ ] Mainnet wallet balance ≥ 4 SOL: `solana balance --url mainnet-beta`
- [ ] 3 Realms council member pubkeys documented privately
- [ ] Public announcement drafted (Twitter/Discord/etc.)
- [ ] 2-5 pre-committed day-one minters lined up (each ready with ≥10 SOL)

## Step 1 — Deploy

```bash
cd C:/Users/NeCDeT/Desktop/tobestable-protocol
anchor deploy --provider.cluster mainnet
```

**Cost:** ~3.3 SOL.
**Output:** confirms program live at `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`.
**Verify:** `solana program show Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX --url mainnet-beta`

## Step 2 — Initialize

```bash
node scripts/mainnet-initialize.js
```

**Cost:** ~0.05 SOL.
**Effect:** Creates state PDA, vault token PDA, Metaplex metadata. Generates the TOBE mint. Saves the mint keypair to `scripts/.mainnet-mint.json` (back this up too).

**Verify:** `solana account <state-pda> --url mainnet-beta` should show non-zero balance.

## Step 3 — Move treasury to Realms vault

```bash
node scripts/mainnet-update-treasury.js
```

**Cost:** <0.01 SOL.
**Effect:** `mint_state.treasury` → `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC`.
**Why now:** doing it before authority handoff means one single-sig tx instead of a multisig proposal later.

## Step 4 — Propose authority transfer

```bash
node scripts/propose-authority.js \
  --network mainnet \
  --new-authority Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC
```

**Cost:** <0.01 SOL.
**Effect:** `mint_state.pending_authority` → Realms vault. You still control until Step 5 completes.

## Step 5 — Realms accepts authority

In Realms UI (mainnet, NOT devnet):

1. Open your DAO at https://app.realms.today/
2. Click **Create Proposal** → **Programmatic / Executable on-chain instructions**
3. Title: `Accept TOBE authority transfer`
4. Add Custom Instruction with these exact values:

**Program ID:**
```
Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX
```

**Accounts (in order):**
| # | Address | Signer | Writable |
|---|---|---|---|
| 1 | `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` (Treasury → new_authority) | ✅ | ❌ |
| 2 | mint_state PDA (computed at launch; print from `scripts/mainnet-initialize.js` output) | ❌ | ✅ |

**Instruction data (hex):** `6b56c65b210c6ba0`

5. Vote Yes from 2 of 3 council members.
6. Click **Execute**.

**Verify with:**
```bash
node scripts/verify-multisig.js --network mainnet --expected Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC
```
Should print `✅`.

## Step 6 — 🟢 Protocol is fully fair-launched

At this point:
- Authority is the Realms multisig (no single human can unilaterally pause/configure)
- Treasury is the Realms vault (peg-arb proceeds flow to the DAO)
- Vault is empty (0 TOBE)
- No Raydium pool exists yet
- **Waiting for community to mint**

**Public announcement:** "TOBESTABLE is live at `Eekx6ftd...`. First mint at 10 SOL produces 524,288 TOBE. No founder allocation. Pool creation enabled by first minter."

## Step 7 — Community member mints round 1

Out of your hands. You announce, they mint.

**What happens on-chain when someone mints:**
- They pay 10 SOL, receive 524,288 TOBE in their wallet
- Vault gets 524,288 TOBE (50% of round 1)
- `pool_sol_reserve` gets 5 SOL
- `vault_sol_reserve` gets 5 SOL
- `current_round` → 1

## Step 8 — Pool creation (by community minter, or coordinated by you)

The first minter (or anyone with TOBE) can create the Raydium pool:

```bash
TOBE_MINT=<mainnet TOBE mint from Step 2> node scripts/mainnet-create-raydium-pool.js
```

**Cost:** ~0.5 SOL.
**Output:** prints 5 pool addresses + saves them to `scripts/.mainnet-pool.json`.

Whoever runs this needs:
- At least 1000 TOBE in their wallet (or different `--seed-tobe` amount)
- ~0.5 SOL for pool seed + fees

## Step 9 — Realms proposal: `set_pool_config`

In Realms UI, create another Programmatic proposal:

**Program ID:**
```
Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX
```

**Args (u8 bool `tobe_is_token_0`):**
- `0x01` if `tobeIsToken0` in `scripts/.mainnet-pool.json` is `true`
- `0x00` if `false`

**Accounts (in order):**
| # | Address | Signer | Writable |
|---|---|---|---|
| 1 | `Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC` (authority) | ✅ | ✅ |
| 2 | mint_state PDA | ❌ | ✅ |
| 3 | `raydium_pool_state` from `.mainnet-pool.json` | ❌ | ❌ |
| 4 | `raydium_pool_authority` | ❌ | ❌ |
| 5 | `raydium_lp_mint` | ❌ | ❌ |
| 6 | `raydium_token_0_vault` | ❌ | ❌ |
| 7 | `raydium_token_1_vault` | ❌ | ❌ |

**Instruction data:** `d857417d716eb978` + `01` (or `00`) for `tobe_is_token_0`
- Full example if `tobe_is_token_0 = true`: `d857417d716eb97801`
- Full example if `tobe_is_token_0 = false`: `d857417d716eb97800`

Vote 2 of 3, execute. After this, `flush_lp_to_raydium` becomes callable.

## Step 10 — Anyone calls `flush_lp_to_raydium`

Permissionless. Once `pool_sol_balance` ≥ 1 SOL (true after Step 7's mint), anyone can call this and trigger an automatic pool deepening. The frontend has a button for this.

## Frontend update (parallel workstream)

After Step 2 (you know the mainnet program ID + TOBE mint), update `tobe-mint` repo similar to PR #1 pattern:
- Replace `CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ` → `Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX`
- Replace `4fFD96LWnsgCiWMtLJym12k7xLofH6FdSDtr5MgyYmHV` → new mainnet TOBE mint
- Change `NETWORK` constant to `'mainnet'`
- Cache-bust `lang.js?v=phase-c` → `?v=mainnet`

## Other admin discriminators (for future Realms proposals)

| Instruction | Discriminator (hex) | Use case |
|---|---|---|
| `accept_authority` | `6b56c65b210c6ba0` | Step 5 |
| `set_pool_config` | `d857417d716eb978` | Step 9 |
| `update_treasury` | `3c10f342603bfe83` | If you need to redirect peg-arb proceeds again |
| `pause` | `d316ddfb4a79c12f` | Emergency stop minting |
| `unpause` | `a99004260a8dbcff` | Resume after emergency |

## Rollback / Recovery scenarios

### If something goes wrong between Step 2 and Step 5
You still hold authority. Use the existing admin instructions to fix anything. Worst case: `pause`, redeploy with fixes (programs are upgradable until upgrade authority is rotated/revoked), unpause.

### If Step 4 sets wrong pending authority (typo'd pubkey)
Call `propose_authority` again with the correct pubkey from your current authority wallet. The 2-step pattern is designed for this: until `accept_authority` runs, the propose can be overwritten.

### If Step 5 doesn't reach quorum
The pending_authority sits indefinitely. Nothing breaks. You retain control. Either get the votes or re-propose with a different new_authority.

### Loss of program upgrade keypair AFTER deploy
You can no longer upgrade the deployed program. Existing functionality continues to work — only fixes/improvements are blocked. **Don't lose `target/deploy/neco_token-keypair.json`.**

### Loss of TOBE mint keypair
Symbolic only. The mint authority is the `mint_authority` PDA, not the mint keypair. The mint keypair can only close the mint account (and only if supply is 0, which it won't be). Loss is essentially harmless. Still, back it up.

## Estimated total cost

| Step | Cost (SOL) |
|---|---|
| 1 Deploy | 3.3 |
| 2 Initialize | 0.05 |
| 3 Update treasury | <0.01 |
| 4 Propose authority | <0.01 |
| 5 Realms accept | <0.01 (paid from Realms council deposits) |
| 8 Pool seed (whoever creates) | 0.5 + minimum SOL liquidity (e.g., 0.02) |
| 9 Realms set_pool_config | <0.01 |
| **Total for you** | **~3.4 SOL** (you pay steps 1-4; 5-9 paid by Realms/community) |

## Listings (separate timeline; see docs/listings/)

After Step 9 (pool live + configured) and 7+ days of mint activity:

1. Submit Jupiter Verified Token List (see `docs/listings/jupiter-verified-token-list.md`)
2. Wait ~1 week, submit CoinGecko (see `docs/listings/coingecko-submission.md`)
3. Wait ~1 month after CG, submit CoinMarketCap (see `docs/listings/coinmarketcap-submission.md`)

## Frontend listings checklist (token-metadata.json)

After Step 9, update `tobe-mint/token-metadata.json` extensions section with:
- Real Twitter handle once social presence established
- CoinGecko ID after listing approved
- CMC ID after listing approved

See `tobe-mint/docs/TOKEN_METADATA.md` for the update procedure.
