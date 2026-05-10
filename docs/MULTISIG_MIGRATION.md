# Multisig Authority Migration

> **Status:** Pre-mainnet recommended migration. Not yet executed.
> **Read this whole doc before starting.** Test on devnet first.

## Why migrate

The TOBE program is currently controlled by a single-key authority (`BzvTL4PYZzBPs51jmd2LwMYeDDbu319XmHrDLJFEuZzh` on devnet). A single key means a single point of failure: lose the key → lose admin control. A compromised key → an attacker can pause minting, redirect arbitrage proceeds, change Pyth feed, and so on.

Replacing the single key with a Squads multisig means:
- **No single point of failure** — `M-of-N` signers required for any admin action
- **Verifiable on-chain governance** — every admin tx is signed by the multisig vault, visible on Solana Explorer
- **Standard practice** — used by Marinade, Drift, Mango, Jito, Pyth itself, etc.

The TOBE program already supports the migration: `propose_authority` + `accept_authority` (2-step transfer) work with **any** Solana account, including a Squads multisig vault.

## What you'll do

In one sentence: create a Squads V4 multisig, point the TOBE authority at its vault, then verify on-chain that the transfer succeeded.

You will:
1. Decide on signers and threshold
2. Create the Squads V4 multisig (devnet first, then mainnet)
3. Run `scripts/propose-authority.js` from your current authority wallet
4. Have multisig signers approve the `accept_authority` call via the Squads UI
5. Run `scripts/verify-multisig.js` to confirm the transfer

Total time: ~30 minutes including reading. The on-chain transfer itself is <2 minutes once you have signers ready.

---

## Pre-flight checklist

Before you start, you'll need:

- [ ] **Current authority wallet** with at least 0.05 SOL (for tx fees on `propose_authority`)
  - Devnet: `BzvTL4PYZzBPs51jmd2LwMYeDDbu319XmHrDLJFEuZzh`
  - Mainnet: TBD (whichever wallet deploys mainnet program)
- [ ] **Signer wallets** — at least 2 distinct wallets, ideally 3-5
  - Each signer needs a tiny amount of SOL for tx fees (~0.01 SOL each)
  - **Hardware wallets recommended** for production signers (Ledger via Phantom)
- [ ] **Threshold decision** — see [Threshold guidance](#threshold-guidance) below
- [ ] **Squads V4 web app** open: https://v4.squads.so

---

## Threshold guidance

| Setup | Threshold | Survives… | Use when |
|---|---|---|---|
| Solo founder, 2 wallets | 2-of-2 | Nothing (one lost = locked out) | Never recommended |
| Solo founder + 1 trusted other | **2-of-3** | One key loss | Acceptable for early-stage; minimum viable |
| Small team | **3-of-5** | Two key losses | Standard for production DeFi |
| Established protocol | 4-of-7 or larger | Three+ key losses | Once revenue justifies signer overhead |

**Minimum recommendation: 2-of-3** for any mainnet deployment with real value. **3-of-5 once the protocol holds significant TVL.**

You can always rotate signers and adjust threshold via the multisig itself later — start conservative.

---

## Step 1: Devnet dry-run

**Purpose:** Practice the full transfer + verify flow with throwaway wallets, before touching anything that matters.

1. **Create a devnet Squads:**
   - Go to https://v4.squads.so
   - Connect your devnet authority wallet (set the Squads UI to devnet first)
   - Create new multisig → add 2-3 of your test wallets as signers → set threshold (e.g., 2-of-3)
   - Note the **vault pubkey** — this is the address that will become the new authority

2. **Run propose_authority from current authority:**
   ```bash
   node scripts/propose-authority.js \
     --network devnet \
     --new-authority <SQUADS_VAULT_PUBKEY>
   ```
   This calls `propose_authority(squads_vault_pubkey)` from your current authority wallet. Output includes the tx signature.

3. **Accept from multisig via Squads UI:**
   - In the Squads UI, click "Create transaction"
   - Choose "Custom instruction" (or "Raw bytes" depending on Squads UI version)
   - Build an instruction that calls `accept_authority` on the TOBE program with the multisig vault as `new_authority`
   - Get threshold signatures
   - Execute

4. **Verify:**
   ```bash
   node scripts/verify-multisig.js \
     --network devnet \
     --expected <SQUADS_VAULT_PUBKEY>
   ```
   Should print `✅ on-chain authority matches expected multisig vault`.

5. **Test admin operations:**
   - Try calling `pause` from your old authority wallet — should FAIL (no longer authority)
   - Try calling `pause` via the multisig — should succeed with threshold signatures

If anything goes wrong on devnet, you can redo with a fresh Squads. **Do not proceed to mainnet until devnet succeeds end-to-end.**

---

## Step 2: Mainnet rehearsal (no transfer yet)

Once devnet works, repeat the multisig CREATION on mainnet (no authority transfer yet):

1. Switch Squads UI to mainnet
2. Connect signer wallets you intend to use for production (this might mean inviting other people if it's not all your wallets)
3. Create the production multisig with your final threshold
4. **Note the mainnet vault pubkey**
5. Fund each signer wallet with ~0.01 SOL for ongoing tx fees

At this point you have a mainnet multisig but the TOBE program is still controlled by your single key. **Stop here and verify the multisig works** by sending it some test SOL and having the signers approve a withdrawal.

---

## Step 3: Mainnet authority transfer

Once you trust the mainnet multisig:

1. Run `propose-authority` against mainnet:
   ```bash
   node scripts/propose-authority.js \
     --network mainnet \
     --new-authority <MAINNET_SQUADS_VAULT>
   ```

2. From the mainnet Squads UI, create + execute the `accept_authority` transaction (same flow as devnet dry-run).

3. Verify:
   ```bash
   node scripts/verify-multisig.js \
     --network mainnet \
     --expected <MAINNET_SQUADS_VAULT>
   ```

---

## Step 4: Verification checklist

After the transfer, confirm:

- [ ] `verify-multisig.js` reports authority matches Squads vault
- [ ] Solana Explorer shows the latest tx as signed by the Squads vault PDA
- [ ] Old authority wallet calling `pause` is rejected with `Unauthorized` error
- [ ] Multisig calling `pause` succeeds with threshold signatures
- [ ] `accept_authority` is the **last** tx your old authority key needs to sign for this program (you can move that key to cold storage now)

---

## Step 5: Operational implications

After migration, **every admin instruction requires multisig threshold approval**:

| Instruction | Frequency | Notes |
|---|---|---|
| `pause` / `unpause` | Emergency only | Should be fast — keep at least one signer always reachable |
| `update_treasury` | Rare | Only when changing where `buy_from_vault` proceeds go |
| `set_pool_config` | Once total | First call after mainnet pool creation |
| `migrate_state_v2` | Once per state-layout upgrade | Future Phase N+ migrations |
| `update_metadata` | Rare | Token name/symbol/URI changes |
| `lock_lp` | Optional | Legacy alternative to `flush_lp_to_raydium`'s burn |
| `propose_authority` | Once per rotation | Signers can rotate themselves OR transfer to a new multisig |

User-facing instructions (`mint_tobe`, `buy_from_vault`, `sell_to_vault`, `flush_lp_to_raydium`) are **permissionless** and continue to work without any multisig involvement.

---

## Recovery scenarios

### Scenario: One signer loses their key
- Other signers create a `propose_authority` tx through the multisig that sets the authority back to the same multisig but with the lost signer removed (Squads supports rotating signers without changing the vault address)
- Threshold of remaining signers approves
- Done. Vault address unchanged; lost key no longer has any access.

### Scenario: One signer goes rogue
- Same as above — rotate them out via threshold of remaining signers
- They cannot single-handedly do anything (that's the whole point of M-of-N)

### Scenario: Squads program upgraded with breaking change
- Squads ships upgrades carefully and signaled in advance
- If a breaking change is announced, do a full multisig migration: create new Squads, transfer TOBE authority to it, abandon the old one
- This is a 30-minute operation — the same flow as initial migration

### Scenario: You lose access to ALL multisig signers
- You don't. That's why M-of-N exists.
- If somehow all keys are lost (catastrophe): the program admin functions become unreachable forever. User-facing instructions still work permissionlessly. Treasury proceeds still flow. The protocol becomes "fully decentralized" in the most accidental way possible. (Don't let this happen.)

---

## FAQ

**Q: Why Squads V4 instead of V3?**
Squads V4 is what Squads themselves promote in 2026. V3 is in maintenance mode. V4 has cleaner UI and is actively developed. Both are battle-tested by major Solana protocols.

**Q: Why not Realms / SPL Governance?**
SPL Governance is for token-weighted DAO voting. We have a fixed-supply admin role, not a DAO. Squads is the right tool for "small group of trusted humans signs together."

**Q: Can I use a single wallet as the multisig "vault" so I'm the only signer?**
Technically yes (1-of-1 multisig) but pointless — you'd just have a single point of failure with extra steps. The whole value is M-of-N where N > M > 1.

**Q: Does the multisig vault PDA hold any funds?**
For TOBE specifically: no. The Squads vault becomes the *authority* of the TOBE program — it signs admin instructions but doesn't hold the protocol's treasury or vault SOL. Those live in their own program-controlled PDAs.

**Q: How do I revoke if signers are compromised?**
Threshold of remaining (uncompromised) signers can `propose_authority` to a new multisig and `accept_authority` from there. Documented in [Recovery scenarios](#recovery-scenarios).
