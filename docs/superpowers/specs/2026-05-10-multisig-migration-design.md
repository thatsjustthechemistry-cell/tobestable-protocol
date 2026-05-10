# Multisig Migration + SECURITY.md Refresh — Design

**Status:** Approved
**Date:** 2026-05-10
**Repo:** tobestable-protocol
**Scope:** Documentation + helper scripts. No on-chain code changes. No actual authority transfer (that's user-action when they're ready).

## Goal

Two doc-only fixes shipped together as one PR:

1. **SECURITY.md is materially stale** — it references the old program ID, old TOBE mint, and the deprecated `vault_release` instruction. It has no entry for any Phase 2 instruction. Anyone reading the security model today gets misinformation.
2. **No multisig migration runbook exists** — the program supports `propose_authority` / `accept_authority` (2-step transfer pattern), but there's no documented procedure for using them with Squads to replace the single-key authority before mainnet.

## Non-goals

- Executing the actual migration on devnet or mainnet (requires user signers)
- Writing a Squads SDK integration (Squads UI handles all multisig interactions; our scripts only call our own program)
- Audit prep (separate workstream)

## What changes

### SECURITY.md refresh

| Section | Action |
|---|---|
| Program ID | Update `DnMvWs2dDim...` → `CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ` |
| TOBE Mint | Update `h611YQ3w...` → `4fFD96LWnsgCiWMtLJym12k7xLofH6FdSDtr5MgyYmHV` |
| Access Control Matrix | Remove `vault_release` row; add 6 new rows for `buy_from_vault`, `sell_to_vault`, `set_pool_config`, `flush_lp_to_raydium`, `migrate_state_v2`; update `update_treasury` description (no longer receives mint payments) |
| New section: "Pyth oracle dependency" | Document on-chain Pyth integration: feed_id, freshness check (60s), confidence cap (1%), mainnet-only constraint |
| New section: "Permanent LP burn" | Document that `flush_lp_to_raydium` burns the LP token receipt — no rug possible from authority |
| New section: "Vault floor protection" | Document the 30%-of-baseline floor on `vault_balance` during flush operations |

### docs/MULTISIG_MIGRATION.md (new)

Runbook in 7 sections:

1. **Pre-flight checklist** — wallets needed (current authority + N signer wallets), SOL on each, hardware wallet recommendation
2. **Step 1: Devnet dry-run** — create devnet Squads V4, propose+accept on devnet, verify with script
3. **Step 2: Mainnet rehearsal** — create the real mainnet Squads (no transfer yet)
4. **Step 3: Mainnet authority transfer** — call `propose_authority(squads_vault_pubkey)` from current authority; multisig signers approve `accept_authority` via Squads UI
5. **Step 4: Verification** — run `verify-multisig.js`; confirm `mint_state.authority` equals the Squads vault
6. **Step 5: Operational implications** — all future admin instructions (`pause`, `unpause`, `set_pool_config`, `update_treasury`, `migrate_state_v2`) now require multisig threshold
7. **Recovery scenarios** — losing a signer key (rotate via multisig), losing the multisig itself (you don't — that's the point)

### scripts/propose-authority.js (new)

~60-line Node script. Inputs: target authority pubkey (multisig vault). Reads current `mint_state`, validates caller is current authority, builds + sends `propose_authority` tx. Prints next-step instructions.

### scripts/verify-multisig.js (new)

~40-line Node script. Inputs: expected multisig vault pubkey. Reads current `mint_state.authority`. Confirms it equals the expected Squads vault. Read-only; no signing.

## Design decisions locked

| Decision | Choice | Why |
|---|---|---|
| Squads version | **V4** | Squads V4 is what Squads themselves promote in 2026; V3 is in maintenance mode. Battle-tested by Marinade and Drift. |
| Devnet dry-run | **Mandatory** | Catches wallet-config mistakes before touching real keys |
| Threshold guidance | **3-of-5 minimum for production**; 2-of-3 acceptable for early-stage solo founder | 2-of-3 survives one key loss; 3-of-5 survives two |
| Helper scripts | **Two:** `propose-authority.js` + `verify-multisig.js` | Keeps runbook executable; reduces room for error |
| Squads SDK | **Not used in our scripts** | The Squads UI handles all multisig interactions; our scripts only touch our own program |

## Risks

1. **Stale SECURITY.md persists if PR isn't merged** — anyone visiting the repo today sees misleading info. Argues for fast review/merge of this PR.
2. **Squads V4 version drift** — Squads ships updates; the runbook may reference UI elements that change. Mitigation: link to Squads' official docs rather than embed screenshots.
3. **Threshold guidance is opinion, not consensus** — different projects use different M-of-N. The runbook frames as recommendations, not mandates.
4. **No actual migration verification** — the runbook is unverified end-to-end until the user actually executes it. Mitigation: scripts include sanity-checks; runbook explicitly recommends devnet dry-run first.

## Test plan

- [ ] Both scripts pass `node --check`
- [ ] Runbook references match the latest deployed program (CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ on devnet)
- [ ] SECURITY.md access control matrix matches the actual `lib.rs` instruction list
- [ ] Squads V4 URL in runbook resolves
- [ ] PR opened against main

## Definition of done

- [ ] SECURITY.md updated with new program ID, mint, and 6 new instruction rows + 3 new sections
- [ ] `docs/MULTISIG_MIGRATION.md` exists with all 7 sections
- [ ] `scripts/propose-authority.js` and `scripts/verify-multisig.js` written and pass syntax check
- [ ] PR opened against `main`
