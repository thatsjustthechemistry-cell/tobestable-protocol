// ═══════════════════════════════════════════════════════════════════════════
//  TOBE STABLE — live program (SOL version).
//  Cost: 10 SOL per mint round. Users deal with SOL + $TOBE only.
//  This is the single source of truth; build with `anchor build` from here.
// ═══════════════════════════════════════════════════════════════════════════

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};
use anchor_spl::token;
use anchor_spl::token::{MintTo, Token, Transfer};
use anchor_spl::token_interface::{Mint, TokenAccount};
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

// Metaplex Token Metadata Program: metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
pub static MPL_TOKEN_METADATA_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

declare_id!("Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX");

const MINT_COST: u64 = 10_000_000_000; // 10 SOL in lamports (9 decimals)
const MAX_ROUNDS: u64 = 1024;

// ─── Disclosed team allocation ───
// The team wallet (stored immutably in MintState at initialize; mainnet passes
// Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf) gets its first
// TEAM_FREE_MINT_CAP mints with the 10 SOL payment waived. Those rounds inject
// NO SOL into the LP accumulator or the floor reserve; the token split stays
// identical to a paid mint (50% wallet / 50% vault). Beyond the cap the team
// wallet pays like any other minter. There is no setter — the wallet cannot be
// changed after initialize. Free mints are tagged in program logs and disclosed
// on the site (FAQ + live feed "team" tag).
const TEAM_FREE_MINT_CAP: u64 = 8;

const TOKENS_PER_UNIT: u64 = 1024;
const TOBE_DECIMALS_FACTOR: u64 = 1_000_000_000; // 9 decimals
const LP_LOCK_DURATION: i64 = 2 * 365 * 24 * 60 * 60; // 2 years in seconds

// Pyth SOL/USD feed ID on mainnet (hex without 0x prefix).
// See: https://pyth.network/developers/price-feed-ids
const SOL_USD_FEED_ID_HEX: &str =
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Reject Pyth prices older than this many seconds. Kept tight to shrink the
// window in which a caller can post the most favorable recent price (timing
// arbitrage against the vault).
const PYTH_MAX_STALENESS_SECS: u64 = 15;
// Reject Pyth prices where confidence interval > 1% of price.
const PYTH_MAX_CONF_BPS: u128 = 100;

// ─── Pyth helpers ───

/// Read Pyth SOL/USD price, validate freshness and confidence.
/// Returns (price_raw, exponent) where USD = price_raw * 10^exponent.
fn read_sol_usd_price(price_update: &Account<PriceUpdateV2>) -> Result<(i64, i32)> {
    let feed_id = get_feed_id_from_hex(SOL_USD_FEED_ID_HEX)
        .map_err(|_| error!(TobeError::InvalidPriceFeed))?;
    let price = price_update
        .get_price_no_older_than(&Clock::get()?, PYTH_MAX_STALENESS_SECS, &feed_id)
        .map_err(|_| error!(TobeError::StalePriceFeed))?;

    require!(price.price > 0, TobeError::NonPositivePrice);
    // A reported confidence of 0 is degenerate (uninitialized / aggregation
    // anomaly), not "perfectly precise" — reject it rather than letting the
    // conf_bps check pass trivially.
    require!(price.conf > 0, TobeError::PriceConfidenceTooWide);

    // conf / price <= PYTH_MAX_CONF_BPS / 10000
    let conf_bps = (price.conf as u128)
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(price.price as u128))
        .ok_or(TobeError::MathOverflow)?;
    require!(conf_bps <= PYTH_MAX_CONF_BPS, TobeError::PriceConfidenceTooWide);

    Ok((price.price, price.exponent))
}

/// Convert lamports of SOL into TOBE (raw, 9 decimals) at $1/TOBE.
/// Math: tobe_raw = lamports * sol_usd_price / 10^|exponent|
/// Both lamports and TOBE have 9 decimals so unit conversion is preserved.
fn lamports_to_tobe_at_one_usd(lamports: u64, sol_usd_price: i64, exponent: i32) -> Result<u64> {
    require!(sol_usd_price > 0, TobeError::NonPositivePrice);
    require!(exponent <= 0, TobeError::InvalidPriceFeed);
    let abs_exp = (-exponent) as u32;
    let scale = 10u128.checked_pow(abs_exp).ok_or(TobeError::MathOverflow)?;
    let tobe = (lamports as u128)
        .checked_mul(sol_usd_price as u128)
        .ok_or(TobeError::MathOverflow)?
        .checked_div(scale)
        .ok_or(TobeError::MathOverflow)?;
    u64::try_from(tobe).map_err(|_| error!(TobeError::MathOverflow))
}

/// Convert TOBE raw amount into lamports of SOL at $1/TOBE.
/// Math: lamports = tobe_raw * 10^|exponent| / sol_usd_price
fn tobe_to_lamports_at_one_usd(tobe_raw: u64, sol_usd_price: i64, exponent: i32) -> Result<u64> {
    require!(sol_usd_price > 0, TobeError::NonPositivePrice);
    require!(exponent <= 0, TobeError::InvalidPriceFeed);
    let abs_exp = (-exponent) as u32;
    let scale = 10u128.checked_pow(abs_exp).ok_or(TobeError::MathOverflow)?;
    let lamports = (tobe_raw as u128)
        .checked_mul(scale)
        .ok_or(TobeError::MathOverflow)?
        .checked_div(sol_usd_price as u128)
        .ok_or(TobeError::MathOverflow)?;
    u64::try_from(lamports).map_err(|_| error!(TobeError::MathOverflow))
}

/// Pure arming gate for `arm_floor`: has TOBE reached $1, given the pool's TOBE
/// and SOL reserves and the SOL/USD price? TOBE/USD ≥ $1 ⇔ the USD value of the
/// pool's SOL, expressed in TOBE at $1/TOBE, is at least the number of TOBE in
/// the pool (both legs are 9-decimal, so the scale cancels). Factored out of
/// `arm_floor` so the peg boundary is unit-testable without a live Pyth/Raydium
/// runtime (the authority gate + account validation still live on the ix).
fn tobe_at_or_above_one_usd(
    pool_tobe: u64,
    pool_sol: u64,
    sol_usd_price: i64,
    exponent: i32,
) -> Result<bool> {
    let tobe_at_one_usd = lamports_to_tobe_at_one_usd(pool_sol, sol_usd_price, exponent)?;
    Ok(tobe_at_one_usd >= pool_tobe)
}

/// 30% of the vault-TOBE baseline captured at `set_pool_config`. Vault TOBE
/// backs the $1 ceiling, so neither `flush_lp_to_raydium` nor `buy_from_vault`
/// may take it below this line.
const VAULT_FLOOR_BPS: u128 = 3000; // 30%

/// Pure vault-floor gate: would removing `tobe_out` leave at least
/// `VAULT_FLOOR_BPS` of `floor_baseline` in the vault?
/// Errors (rather than returning false) if the withdrawal underflows the vault.
///
/// ⚠️ **Only `flush_lp_to_raydium` calls this now.** `buy_from_vault` used it as the
/// Round-5 F1 mitigation; that floor was removed from the buy path by founder decision
/// on 2026-07-26 (see the note there and SELF_AUDIT.md). The floor is retained on flush
/// because it is load-bearing there rather than a policy choice: flush needs vault TOBE
/// to pair with `pool_sol_reserve` SOL, and nothing else drains that reserve.
///
/// ⚠️ The BASELINE is the security-critical choice, not the percentage. The discussion
/// below is kept because it is what makes the retained flush floor meaningful, and
/// because `buy_from_vault` still derives its founder-cut high-water mark from the same
/// monotonic quantity:
///
/// * A baseline snapshotted once (`vault_tobe_at_config`) protects a FIXED
///   QUANTITY. As the vault keeps growing with every mint, that quantity decays
///   into a rounding error: config at round 20 leaves ~99% of the round-1024
///   vault extractable. Fine where the drawdown is bounded by other means.
/// * A baseline recomputed from the CURRENT balance would be worse still — it is
///   ratchetable, since each withdrawal lowers the balance and therefore the next
///   floor (1000 → 300 → 90 → 27 → …), draining to zero by repetition.
/// * A MONOTONIC baseline (`total_minted / 2` — what the vault would hold had
///   nothing ever been withdrawn) is the only one that gives a true cumulative
///   bound: `total_minted` never decreases, so no sequence of withdrawals can
///   lower the floor.
/// Founder cut for a `buy_from_vault`, paid ONLY on the portion of the buy that takes
/// the vault to a NEW net-depletion high (H2 fix, audit Round 6).
///
/// ─── Why ───
///
/// `buy_from_vault` splits proceeds 50/50 DAO/founder. Round 6 found that a flat 50%
/// makes a round trip profitable for the founder and unbounded:
///
///   buy_from_vault(X)        founder pays X, receives X/2 back as founder_cut
///   sell_to_vault(tobe_out)  founder receives X at par from vault_sol_reserve
///   net                      founder +X/2, vault_sol_reserve -X, and vault_balance is
///                            RESTORED — so the 30% TOBE floor is never reached
///
/// The 30% floor bounds TOBE *leaving* the vault; it cannot bound this, because the
/// TOBE comes back. Two intuitive fixes do NOT work and must not be retried:
///
/// * A SPREAD on `sell_to_vault` — the founder's effective purchase price is already
///   half face value, so the spread would have to exceed 50%, i.e. a "$1 floor" paying
///   $0.50. A 1% spread only cuts per-cycle profit from 50% to 49%.
/// * TIMELOCKING `founder_cut` — deferring the payout does not change the protocol's
///   net position: buy at full price, sell back at par, break even, collect later.
///
/// ─── The mechanism ───
///
/// Net depletion is `total_minted / 2` (what the vault would hold had nothing ever
/// left) minus the current balance. `max_vault_depletion` is its high-water mark. The
/// founder is paid only on ground *beyond* that mark:
///
/// * A round trip returns the TOBE, so the vault comes back to a level already covered
///   by the mark. The next buy breaks no new ground → **cut is 0**. The cycle earns
///   nothing, in either order (buy→sell or sell→buy).
/// * Genuine net demand pushes the vault to a new low → the founder earns the full 50%
///   on the incremental portion, **uncapped**.
///
/// This also correctly pays nothing when the vault is merely re-selling TOBE it bought
/// back through the floor: the protocol paid out reserve SOL to acquire it, so paying a
/// cut to re-sell the same tokens would make the protocol net-negative on a wash.
///
/// Returns `(founder_cut, new_max_depletion)`. The caller assigns the remainder to
/// `dao_cut`, so the buyer always pays exactly `sol_in_lamports`.
fn founder_cut_on_new_depletion(
    sol_in_lamports: u64,
    tobe_out: u64,
    never_withdrawn: u64,
    vault_balance: u64,
    max_depletion: u64,
) -> Result<(u64, u64)> {
    require!(tobe_out > 0, TobeError::ZeroAmount);
    let remaining_vault = vault_balance
        .checked_sub(tobe_out)
        .ok_or(TobeError::MathOverflow)?;
    // Saturating: `vault_balance` can EXCEED `never_withdrawn` after net selling into
    // the vault (see L1), in which case net depletion is zero, not negative.
    let depletion_after = never_withdrawn.saturating_sub(remaining_vault);
    let new_max = core::cmp::max(max_depletion, depletion_after);
    // Ground broken beyond the previous high-water mark, clamped to this buy's own
    // size — a buy cannot be credited with more new ground than the TOBE it removed.
    let new_ground = core::cmp::min(
        depletion_after.saturating_sub(max_depletion),
        tobe_out,
    );
    // Pro-rata: the nominal half, scaled by the fraction of this buy that is new
    // ground. u128 throughout — nominal x new_ground overflows u64 at realistic sizes.
    let nominal = (sol_in_lamports / 2) as u128;
    let cut = nominal
        .checked_mul(new_ground as u128)
        .and_then(|v| v.checked_div(tobe_out as u128))
        .ok_or(TobeError::MathOverflow)?;
    // `new_ground <= tobe_out`, so `cut <= nominal` and the cast cannot truncate.
    Ok((cut as u64, new_max))
}

fn vault_withdrawal_within_floor(
    vault_balance: u64,
    floor_baseline: u64,
    tobe_out: u64,
) -> Result<bool> {
    let floor: u64 = ((floor_baseline as u128)
        .checked_mul(VAULT_FLOOR_BPS)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(TobeError::MathOverflow)?) as u64;
    let projected = vault_balance
        .checked_sub(tobe_out)
        .ok_or(TobeError::VaultFloorBreach)?;
    Ok(projected >= floor)
}

#[program]
pub mod neco_token {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        admin_authority: Pubkey,
        founder: Pubkey,
        team_wallet: Pubkey,
    ) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.authority = admin_authority;
        mint_state.treasury = treasury;
        // Founder revenue wallet: receives 50% of buy_from_vault (ceiling-
        // arbitrage) proceeds; the other 50% goes to `treasury` (the DAO).
        // This is a DISCLOSED founder fee — see docs + FAQ.
        mint_state.founder = founder;
        // Disclosed team allocation wallet (immutable — no setter exists):
        // first TEAM_FREE_MINT_CAP mints from this wallet are payment-free.
        mint_state.team_wallet = team_wallet;
        mint_state.team_free_mints_used = 0;
        mint_state.founder_cut_paid = 0;
        mint_state.max_vault_depletion = 0;
        mint_state.current_round = 0;
        mint_state.tobe_mint = ctx.accounts.tobe_mint.key();
        mint_state.vault_balance = 0;
        mint_state.total_vault_released = 0;
        mint_state.lp_locked = false;
        mint_state.paused = false;
        mint_state.pool_seeded = false;
        mint_state.pending_authority = Pubkey::default();
        mint_state.lp_mint = Pubkey::default();
        mint_state.lp_lock_until = 0;
        mint_state.bump = ctx.bumps.mint_authority;
        mint_state.vault_bump = ctx.bumps.vault_authority;
        mint_state.lp_lock_bump = ctx.bumps.lp_lock_authority;
        mint_state.total_minted = 0;
        mint_state.pool_sol_balance = 0;
        mint_state.raydium_pool_state = Pubkey::default();
        mint_state.raydium_pool_authority = Pubkey::default();
        mint_state.raydium_lp_mint = Pubkey::default();
        mint_state.raydium_token_0_vault = Pubkey::default();
        mint_state.raydium_token_1_vault = Pubkey::default();
        mint_state.tobe_is_token_0 = false;
        mint_state.vault_tobe_at_config = 0;
        mint_state.floor_active = false;

        // Create token metadata via Metaplex CPI (manual instruction)
        let name = "TOBESTABLE".to_string();
        let symbol = "TOBE".to_string();
        let uri = "https://tobestable.com/token-metadata.json".to_string();

        // CreateMetadataAccountV3 instruction discriminator = 33
        let mut data_buf: Vec<u8> = vec![33];
        data_buf.extend_from_slice(&(name.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(name.as_bytes());
        data_buf.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(symbol.as_bytes());
        data_buf.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(uri.as_bytes());
        data_buf.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
        data_buf.push(0); // creators: None
        data_buf.push(0); // collection: None
        data_buf.push(0); // uses: None
        data_buf.push(1); // is_mutable: true
        data_buf.push(0); // collection_details: None

        let accounts = vec![
            AccountMeta::new(ctx.accounts.metadata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.tobe_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint_authority.key(), true),
            AccountMeta::new(ctx.accounts.authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.mint_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ];

        let ix = Instruction {
            program_id: MPL_TOKEN_METADATA_ID,
            accounts,
            data: data_buf,
        };

        let seeds = &[b"mint_authority".as_ref(), &[ctx.bumps.mint_authority]];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.tobe_mint.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        Ok(())
    }

    /// `referrer` is optional and purely informational — it does not change any
    /// token/SOL amounts (no reward, no fee). It is written to the program log
    /// (`msg!`) so the referral is permanently part of this transaction's
    /// on-chain record, retrievable via any explorer or `getTransaction`.
    pub fn mint_tobe(ctx: Context<MintTobe>, referrer: Option<Pubkey>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(!mint_state.paused, TobeError::MintingPaused);
        require!(
            mint_state.current_round < MAX_ROUNDS,
            TobeError::AllRoundsMinted
        );
        if let Some(r) = referrer {
            require!(r != ctx.accounts.minter.key(), TobeError::SelfReferral);
        }

        mint_state.current_round += 1;
        let round = mint_state.current_round;

        let token_units = TOKENS_PER_UNIT
            .checked_mul(MAX_ROUNDS + 1 - round)
            .ok_or(TobeError::MathOverflow)?;
        let total_tokens = token_units
            .checked_mul(TOBE_DECIMALS_FACTOR)
            .ok_or(TobeError::MathOverflow)?;

        // 50% to minter, 50% to vault
        let minter_tokens = total_tokens / 2;
        let vault_tokens = total_tokens - minter_tokens;

        // Disclosed team allocation: free while under the cap, then pays like everyone.
        let is_team_free = ctx.accounts.minter.key() == mint_state.team_wallet
            && mint_state.team_free_mints_used < TEAM_FREE_MINT_CAP;

        // Every paid round: 5 SOL → pool_sol_reserve (LP injection accumulator)
        //                   5 SOL → vault_sol_reserve (floor defense reserve)
        // Team free rounds transfer nothing — no SOL enters either reserve.
        let half_cost = MINT_COST / 2;
        if is_team_free {
            mint_state.team_free_mints_used = mint_state
                .team_free_mints_used
                .checked_add(1)
                .ok_or(TobeError::MathOverflow)?;
        } else {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.minter.to_account_info(),
                        to: ctx.accounts.pool_sol_reserve.to_account_info(),
                    },
                ),
                half_cost,
            )?;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.minter.to_account_info(),
                        to: ctx.accounts.vault_sol_reserve.to_account_info(),
                    },
                ),
                half_cost,
            )?;
        }

        // Mint 50% TOBE to the minter
        let seeds = &[b"mint_authority".as_ref(), &[mint_state.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.tobe_mint.to_account_info(),
                    to: ctx.accounts.minter_tobe.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            minter_tokens,
        )?;

        // Mint 50% TOBE to the vault
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.tobe_mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            vault_tokens,
        )?;

        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_add(vault_tokens)
            .ok_or(TobeError::MathOverflow)?;
        mint_state.total_minted = mint_state
            .total_minted
            .checked_add(total_tokens)
            .ok_or(TobeError::MathOverflow)?;
        if !is_team_free {
            mint_state.pool_sol_balance = mint_state
                .pool_sol_balance
                .checked_add(half_cost)
                .ok_or(TobeError::MathOverflow)?;
        }

        if is_team_free {
            msg!("Round {}: TEAM FREE MINT (disclosed allocation {}/{}): {} TOBE minted ({} to team, {} to vault); 0 SOL paid",
                round, mint_state.team_free_mints_used, TEAM_FREE_MINT_CAP, token_units, minter_tokens, vault_tokens);
        } else {
            msg!("Round {}: {} TOBE minted ({} to minter, {} to vault); 5 SOL → pool, 5 SOL → vault_sol",
                round, token_units, minter_tokens, vault_tokens);
        }
        match referrer {
            Some(r) => msg!("Referral: minter={}, referrer={}", ctx.accounts.minter.key(), r),
            None => msg!("Referral: minter={}, referrer=none", ctx.accounts.minter.key()),
        }
        Ok(())
    }

    /// Permissionless: anyone can buy TOBE from the vault at $1/TOBE when Pyth says
    /// SOL/USD is positive (i.e., always, since this caps the upside at $1).
    /// Buyer sends `sol_in_lamports`, receives equivalent TOBE at $1 each.
    /// Received SOL is split 50/50: half to the DAO treasury, half to the
    /// founder wallet (a disclosed founder fee on ceiling-arbitrage proceeds).
    pub fn buy_from_vault(ctx: Context<BuyFromVault>, sol_in_lamports: u64) -> Result<()> {
        require!(!ctx.accounts.mint_state.paused, TobeError::MintingPaused);
        require!(sol_in_lamports > 0, TobeError::ZeroAmount);
        // Guard: never split to an unset (zero) founder — that would burn 50%
        // to the system address. Fresh initialize always sets it; this protects
        // against a migrated state where the field defaulted to zero.
        require!(
            ctx.accounts.mint_state.founder != Pubkey::default(),
            TobeError::Unauthorized
        );

        let (price, exponent) = read_sol_usd_price(&ctx.accounts.pyth_price_update)?;
        let tobe_out = lamports_to_tobe_at_one_usd(sol_in_lamports, price, exponent)?;
        require!(tobe_out > 0, TobeError::ZeroAmount);

        // ─── F2 fix (Round 5): enforce the documented ceiling condition ───
        //
        // The site, FAQ and announcement all describe this path as active only
        // "when TOBE trades at or above $1" — but the code never checked, so the
        // vault would also sell its reserve BELOW peg. That is pure value
        // destruction for the protocol (it hands over an asset worth less than
        // $1 and books $1), and it is *profitable* for the founder, who receives
        // 50% of the proceeds back and so breaks even at $0.50.
        //
        // Above $1 nothing changes: selling vault TOBE at $1 IS the ceiling doing
        // its job. This only blocks the below-peg case. Price is derived exactly
        // as arm_floor does (pool reserves x Pyth SOL/USD, same audited helper);
        // the vaults are constrained to the recorded pool config, so the read
        // cannot be spoofed with unrelated token accounts.
        //
        // Reads pool state BEFORE the &mut borrow of mint_state below.
        {
            let ms = &ctx.accounts.mint_state;
            let (pool_tobe, pool_sol) = if ms.tobe_is_token_0 {
                (
                    ctx.accounts.raydium_token_0_vault.amount,
                    ctx.accounts.raydium_token_1_vault.amount,
                )
            } else {
                (
                    ctx.accounts.raydium_token_1_vault.amount,
                    ctx.accounts.raydium_token_0_vault.amount,
                )
            };
            require!(pool_tobe > 0 && pool_sol > 0, TobeError::EmptyPoolReserves);
            require!(
                tobe_at_or_above_one_usd(pool_tobe, pool_sol, price, exponent)?,
                TobeError::PriceBelowPeg
            );
        }

        let mint_state = &mut ctx.accounts.mint_state;
        require!(
            tobe_out <= mint_state.vault_balance,
            TobeError::InsufficientVault
        );

        // ─── NO VAULT FLOOR ON THIS PATH (deliberate, 2026-07-26) ───
        //
        // Round 5's F1 mitigation applied `flush_lp_to_raydium`'s 30% floor here too,
        // capping extraction at 70% of the vault. That floor was REMOVED from this
        // instruction by founder decision: it only ever binds after ~188M TOBE has
        // been sold at $1 (~$188M of arbitrage), and at exactly that point it starts
        // REFUSING genuine buyers — which breaks the $1 ceiling upward anyway. It
        // reserved 30% that could never be used for the very purpose it was held for.
        //
        // ⚠️ CONSEQUENCES, accepted knowingly (see SELF_AUDIT.md "F1 residual"):
        //
        //  * F1 is now UNBOUNDED on this path. The founder receives 50% of proceeds,
        //    so as the buyer their net cost is half — they can acquire the ENTIRE
        //    vault at an effective 50% off, not merely 70% of it. (A `buyer !=
        //    founder` check does not help; it is bypassable with a second wallet.)
        //  * `flush_lp_to_raydium` can be starved. It pairs `pool_sol_reserve` SOL
        //    with vault TOBE, and nothing else consumes that reserve — so if this
        //    path drains the vault below flush's own (retained) floor, future
        //    accumulation there is stranded with no instruction able to release it.
        //    Previously the buy floor (30% of the GROWING total_minted/2) sat well
        //    above flush's floor (30% of the EARLY vault_tobe_at_config snapshot),
        //    so it shielded flush as a side effect. That shield is gone.
        //
        // NOT a consequence: "the ceiling becomes exhaustible". It always was — the
        // ceiling works only while the vault holds TOBE to sell. The floor made it
        // exhaust EARLIER (at 70% depletion, with the last 30% reserved and unusable
        // for the very purpose it was held for). Removing it EXTENDS ceiling capacity
        // from ~188M to the full ~268.7M TOBE.
        //
        // H2 is NOT reopened by this: the founder cut is paid only on new net vault
        // depletion, so round trips still earn nothing regardless of any floor.
        //
        // flush_lp_to_raydium KEEPS its floor — it is load-bearing there, not a
        // policy choice. See the note at that call site.
        //
        // Pool config is still required, for the F2 price gate below/above: the gate
        // reads the recorded pool's reserves, and there is no market to arbitrage
        // against before a pool exists.
        require!(
            mint_state.raydium_pool_state != Pubkey::default(),
            TobeError::PoolNotConfigured
        );
        // Still needed — not as a floor, but as the baseline for the founder-cut
        // depletion high-water mark below. `total_minted / 2` is what the vault would
        // hold if nothing had ever been withdrawn; it is MONOTONIC (total_minted only
        // grows), which is what makes the high-water mark un-ratchetable.
        //
        // Exact by construction: each mint gives the minter total_tokens/2 and the
        // vault the remainder, and total_tokens is always even (x 1e9 decimals).
        let never_withdrawn = mint_state
            .total_minted
            .checked_div(2)
            .ok_or(TobeError::MathOverflow)?;

        // 1. Split proceeds DAO/founder. The founder's nominal half is paid only on
        //    the portion of this buy that takes the vault to a NEW net-depletion high
        //    (H2 fix — see `founder_cut_on_new_depletion`). A round trip returns the
        //    TOBE, so the next buy breaks no new ground and earns nothing; genuine net
        //    demand earns the full 50%, uncapped.
        //
        //    Whatever the founder does not earn goes to the DAO instead, so the buyer
        //    always pays exactly `sol_in_lamports` and dao_cut + founder_cut equals it.
        //    The integer split still gives any odd lamport to the DAO.
        //
        //    `never_withdrawn` is the same monotonic baseline the floor check above
        //    uses — deliberately reused so the two cannot disagree about what the
        //    vault "should" hold.
        let (founder_cut, new_max_depletion) = founder_cut_on_new_depletion(
            sol_in_lamports,
            tobe_out,
            never_withdrawn,
            mint_state.vault_balance,
            mint_state.max_vault_depletion,
        )?;
        mint_state.max_vault_depletion = new_max_depletion;
        let dao_cut = sol_in_lamports
            .checked_sub(founder_cut)
            .ok_or(TobeError::MathOverflow)?;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            dao_cut,
        )?;
        // Skipped when the buy breaks no new ground — a 0-lamport transfer is a
        // pointless CPI. The `founder` account stays REQUIRED on BuyFromVault either
        // way, so this is not a wire-format change.
        if founder_cut > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to: ctx.accounts.founder.to_account_info(),
                    },
                ),
                founder_cut,
            )?;
            mint_state.founder_cut_paid = mint_state
                .founder_cut_paid
                .checked_add(founder_cut)
                .ok_or(TobeError::MathOverflow)?;
        }

        // 2. Vault TOBE → buyer (vault PDA signs).
        let seeds = &[b"vault_authority".as_ref(), &[mint_state.vault_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.buyer_tobe.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            tobe_out,
        )?;

        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_sub(tobe_out)
            .ok_or(TobeError::MathOverflow)?;
        mint_state.total_vault_released = mint_state
            .total_vault_released
            .checked_add(tobe_out)
            .ok_or(TobeError::MathOverflow)?;

        msg!(
            "buy_from_vault: {} lamports ({} DAO + {} founder) → {} TOBE @ $1 (SOL/USD={}e{}); net-depletion high-water={} (founder paid only on new ground); founder_cut_paid={}",
            sol_in_lamports, dao_cut, founder_cut, tobe_out, price, exponent,
            mint_state.max_vault_depletion, mint_state.founder_cut_paid
        );
        Ok(())
    }

    /// Permissionless: anyone can sell TOBE to the vault at $1/TOBE.
    /// Seller sends TOBE, receives SOL drawn from vault_sol_reserve at $1 each.
    /// Bought TOBE returns to vault to replenish the upside-cap reserve.
    pub fn sell_to_vault(ctx: Context<SellToVault>, tobe_in_raw: u64) -> Result<()> {
        require!(!ctx.accounts.mint_state.paused, TobeError::MintingPaused);
        // The $1 floor stays disabled until TOBE has first reached $1 (latched on
        // by arm_floor). Before that, selling to the vault at $1 would be a pure
        // below-peg drain (mint cost is far under $1), so it is blocked.
        require!(ctx.accounts.mint_state.floor_active, TobeError::FloorNotActive);
        require!(tobe_in_raw > 0, TobeError::ZeroAmount);

        let (price, exponent) = read_sol_usd_price(&ctx.accounts.pyth_price_update)?;
        let sol_out = tobe_to_lamports_at_one_usd(tobe_in_raw, price, exponent)?;
        require!(sol_out > 0, TobeError::ZeroAmount);

        // 1. Seller TOBE → vault (replenish reserve).
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_tobe.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            tobe_in_raw,
        )?;

        // 2. Vault SOL reserve → seller. vault_sol_reserve is owned by the System
        //    program (only ever funded via system_program::transfer), so lamports
        //    must leave via a PDA-signed system transfer — a program may not
        //    direct-mutate the lamports of an account it does not own. (Same
        //    pattern as flush_lp_to_raydium for pool_sol_reserve.)
        let vault_sol_lamports = ctx.accounts.vault_sol_reserve.lamports();
        require!(vault_sol_lamports >= sol_out, TobeError::VaultSolInsufficient);
        let vault_sol_seeds: &[&[u8]] = &[b"vault_sol_reserve", &[ctx.bumps.vault_sol_reserve]];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault_sol_reserve.to_account_info(),
                    to: ctx.accounts.seller.to_account_info(),
                },
                &[vault_sol_seeds],
            ),
            sol_out,
        )?;

        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_add(tobe_in_raw)
            .ok_or(TobeError::MathOverflow)?;

        msg!(
            "sell_to_vault: {} TOBE → {} lamports @ $1 (SOL/USD price={}, exp={})",
            tobe_in_raw, sol_out, price, exponent
        );
        Ok(())
    }

    /// Authority-gated one-way latch: arms the $1 floor (enables sell_to_vault)
    /// once TOBE's market price has genuinely reached $1. Once set, floor_active
    /// stays true forever.
    ///
    /// SECURITY (H1 fix): arming is restricted to the authority — a 2-of-3 council
    /// multisig after migration. The on-chain check below reads the Raydium pool
    /// SPOT reserves × Pyth SOL/USD, which is manipulable within a single tx, so
    /// it is kept ONLY as a secondary sanity guard, not the sole gate. The
    /// human/multisig confirms TOBE truly reached $1 (e.g. via an off-chain TWAP)
    /// before arming — that human gate is what prevents a premature-arm drain of
    /// vault_sol_reserve. Previously permissionless, which let anyone flash-skew
    /// the pool ratio across $1 and latch the floor early.
    pub fn arm_floor(ctx: Context<ArmFloor>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        require!(
            mint_state.raydium_pool_state != Pubkey::default(),
            TobeError::PoolNotConfigured
        );
        require!(!mint_state.floor_active, TobeError::FloorAlreadyActive);

        let (pool_tobe, pool_sol) = if mint_state.tobe_is_token_0 {
            (
                ctx.accounts.raydium_token_0_vault.amount,
                ctx.accounts.raydium_token_1_vault.amount,
            )
        } else {
            (
                ctx.accounts.raydium_token_1_vault.amount,
                ctx.accounts.raydium_token_0_vault.amount,
            )
        };
        require!(pool_tobe > 0 && pool_sol > 0, TobeError::EmptyPoolReserves);

        // TOBE/USD ≥ $1 gate — see `tobe_at_or_above_one_usd` (unit-tested). Uses
        // the audited Pyth price helper; below peg reverts with PriceBelowPeg.
        let (price, exponent) = read_sol_usd_price(&ctx.accounts.pyth_price_update)?;
        require!(
            tobe_at_or_above_one_usd(pool_tobe, pool_sol, price, exponent)?,
            TobeError::PriceBelowPeg
        );

        mint_state.floor_active = true;
        msg!(
            "Floor armed: TOBE reached $1 (pool_tobe={}, pool_sol={}, sol_usd={}e{})",
            pool_tobe, pool_sol, price, exponent
        );
        Ok(())
    }

    // M1 fix: `seed_pool` was REMOVED. It was a legacy, fair-launch-unused
    // authority primitive that handed round-1 vault TOBE (524,288) + the entire
    // pool_sol_reserve to an unconstrained destination — effectively "move vault
    // funds anywhere the authority chooses." The fair launch never calls it
    // (community creates the pool externally), and ongoing liquidity deepening is
    // handled by the permissionless, floor-protected flush_lp_to_raydium. Deleting
    // it removes the primitive and the trust concern. The vestigial `pool_seeded`
    // field is retained (never read now) to keep the on-chain account layout stable
    // for the already-migrated devnet state.

    // ─── Phase 2: Raydium auto-LP injection ───
    //
    // After authority creates the Raydium CPMM TOBE/wSOL pool externally
    // (e.g., via scripts/create-raydium-pool.js using @raydium-io/raydium-sdk-v2),
    // they call set_pool_config ONCE to record the pool addresses on-chain.
    //
    // Then anyone can call flush_lp_to_raydium when ≥1 SOL has accumulated in
    // pool_sol_reserve. The instruction:
    //   1. Pulls all pool_sol_reserve SOL → wraps to wSOL
    //   2. Pulls matching TOBE from vault (proportional to current pool ratio)
    //   3. CPI deposit into Raydium pool
    //   4. Burns the LP token receipt (locks liquidity forever)
    //
    // Floor protection: never drain vault TOBE below 30% of vault_tobe_at_config.

    pub fn set_pool_config(ctx: Context<SetPoolConfig>, tobe_is_token_0: bool) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        // The fair-launch flow creates the Raydium pool externally (a community
        // minter). vault_tobe_at_config (the 30%-floor baseline, set below) is
        // captured from the current vault_balance at config time.
        require!(
            mint_state.raydium_pool_state == Pubkey::default(),
            TobeError::PoolAlreadyConfigured
        );

        // Cross-check the recorded accounts against the typed pool so the config
        // is trustworthy by construction (defense-in-depth vs an authority typo):
        // the vaults + lp_mint must belong to THIS pool, both legs must be
        // 9-decimal, and the legs must be exactly TOBE and native wSOL — the
        // 9-decimal assumption arm_floor's price math relies on (its decimals
        // cancel in the ratio). This makes the floor-price source sound and
        // removes the one-way config-typo DoS risk for flush.
        {
            let pool = ctx.accounts.raydium_pool_state.load()?;
            require!(ctx.accounts.raydium_token_0_vault.key() == pool.token_0_vault, TobeError::PoolMismatch);
            require!(ctx.accounts.raydium_token_1_vault.key() == pool.token_1_vault, TobeError::PoolMismatch);
            require!(ctx.accounts.raydium_lp_mint.key() == pool.lp_mint, TobeError::PoolMismatch);
            require!(pool.mint_0_decimals == 9 && pool.mint_1_decimals == 9, TobeError::PoolMismatch);
            let (tobe_leg, wsol_leg) = if tobe_is_token_0 {
                (pool.token_0_mint, pool.token_1_mint)
            } else {
                (pool.token_1_mint, pool.token_0_mint)
            };
            require!(tobe_leg == mint_state.tobe_mint, TobeError::PoolMismatch);
            require!(wsol_leg == anchor_spl::token::spl_token::native_mint::ID, TobeError::PoolMismatch);
        }

        mint_state.raydium_pool_state = ctx.accounts.raydium_pool_state.key();
        mint_state.raydium_pool_authority = ctx.accounts.raydium_pool_authority.key();
        mint_state.raydium_lp_mint = ctx.accounts.raydium_lp_mint.key();
        mint_state.raydium_token_0_vault = ctx.accounts.raydium_token_0_vault.key();
        mint_state.raydium_token_1_vault = ctx.accounts.raydium_token_1_vault.key();
        mint_state.tobe_is_token_0 = tobe_is_token_0;
        mint_state.vault_tobe_at_config = mint_state.vault_balance;

        msg!(
            "Pool configured: pool={}, lp_mint={}, tobe_is_token_0={}, vault_baseline={}",
            mint_state.raydium_pool_state,
            mint_state.raydium_lp_mint,
            tobe_is_token_0,
            mint_state.vault_balance,
        );
        Ok(())
    }

    pub fn flush_lp_to_raydium(ctx: Context<FlushLpToRaydium>, max_tobe_to_pair: u64) -> Result<()> {
        const FLUSH_MIN_LAMPORTS: u64 = 1_000_000_000; // 1 SOL

        let mint_state = &mut ctx.accounts.mint_state;

        require!(!mint_state.paused, TobeError::MintingPaused);
        require!(
            mint_state.raydium_pool_state != Pubkey::default(),
            TobeError::PoolNotConfigured
        );
        require!(
            mint_state.pool_sol_balance >= FLUSH_MIN_LAMPORTS,
            TobeError::BelowFlushThreshold
        );

        let sol_to_deposit = mint_state.pool_sol_balance;

        // Read pool reserves
        let (pool_tobe_amount, pool_sol_amount) = if mint_state.tobe_is_token_0 {
            (
                ctx.accounts.raydium_token_0_vault.amount,
                ctx.accounts.raydium_token_1_vault.amount,
            )
        } else {
            (
                ctx.accounts.raydium_token_1_vault.amount,
                ctx.accounts.raydium_token_0_vault.amount,
            )
        };
        require!(
            pool_tobe_amount > 0 && pool_sol_amount > 0,
            TobeError::EmptyPoolReserves
        );

        // tobe_to_pair = sol_to_deposit * pool_tobe / pool_sol  (rounded up by + 1)
        let tobe_to_pair: u64 = (sol_to_deposit as u128)
            .checked_mul(pool_tobe_amount as u128)
            .ok_or(TobeError::MathOverflow)?
            .checked_div(pool_sol_amount as u128)
            .ok_or(TobeError::MathOverflow)?
            .checked_add(1)
            .ok_or(TobeError::MathOverflow)?
            .try_into()
            .map_err(|_| error!(TobeError::MathOverflow))?;

        // Slippage / sandwich protection: tobe_to_pair is derived from the LIVE
        // (attacker-influenceable) pool ratio. An honest keeper passes a
        // max_tobe_to_pair computed off-chain from current reserves; if someone
        // front-runs to skew the ratio, the required TOBE exceeds that bound and
        // we revert rather than deposit at a manipulated ratio.
        require!(tobe_to_pair <= max_tobe_to_pair, TobeError::SlippageExceeded);

        // Floor protection. NOTE the baseline here is deliberately the
        // `vault_tobe_at_config` snapshot, NOT the monotonic `total_minted / 2`
        // that buy_from_vault uses. The two instructions do different things:
        //
        //   buy_from_vault  — TOBE leaves the protocol to a buyer. Extraction.
        //                     Needs a genuine cumulative bound (see there).
        //   flush           — TOBE becomes Raydium liquidity and the LP receipt is
        //                     BURNED. Nothing leaves; the vault's TOBE converts into
        //                     permanently locked liquidity backing this same token.
        //
        // Applying the tighter monotonic floor here would throttle LP injection —
        // the mechanism that builds the market — to protect against a "drain" that
        // is not a drain. Left as-is deliberately.
        //
        // ⚠️ Consequence: flush's floor still decays relative to a growing vault, so
        // it is a weak constraint late in the mint schedule. That is acceptable only
        // because flush cannot move TOBE to an arbitrary destination — re-audit this
        // if flush ever gains a caller-chosen recipient.
        require!(
            vault_withdrawal_within_floor(
                mint_state.vault_balance,
                mint_state.vault_tobe_at_config,
                tobe_to_pair
            )?,
            TobeError::VaultFloorBreach
        );

        // Target LP tokens: sol_to_deposit / pool_sol * lp_supply
        let pool_lp_supply = ctx.accounts.raydium_pool_state.load()?.lp_supply;
        let target_lp: u64 = (sol_to_deposit as u128)
            .checked_mul(pool_lp_supply as u128)
            .ok_or(TobeError::MathOverflow)?
            .checked_div(pool_sol_amount as u128)
            .ok_or(TobeError::MathOverflow)?
            .try_into()
            .map_err(|_| error!(TobeError::MathOverflow))?;
        require!(target_lp > 0, TobeError::LpAmountZero);

        // 1. Move SOL from pool_sol_reserve PDA → wsol_temp via system program
        //    (PDA-signed transfer; can't direct-mutate lamports since pool_sol_reserve
        //    is owned by the system program, not by our program).
        let pool_sol_seeds: &[&[u8]] = &[b"pool_sol_reserve", &[ctx.bumps.pool_sol_reserve]];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.pool_sol_reserve.to_account_info(),
                    to: ctx.accounts.wsol_temp.to_account_info(),
                },
                &[pool_sol_seeds],
            ),
            sol_to_deposit,
        )?;

        // 2. sync_native so wSOL token account reflects new lamport balance
        let vault_authority_seeds: &[&[u8]] = &[b"vault_authority", &[mint_state.vault_bump]];
        let vault_signer = &[vault_authority_seeds];
        token::sync_native(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: ctx.accounts.wsol_temp.to_account_info(),
            },
            vault_signer,
        ))?;

        // 3. Determine token_0_account vs token_1_account based on ordering
        let (token_0_account, token_1_account) = if mint_state.tobe_is_token_0 {
            (
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.wsol_temp.to_account_info(),
            )
        } else {
            (
                ctx.accounts.wsol_temp.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
            )
        };
        // Cap the TOBE Raydium may pull at the caller's slippage bound, so even a
        // skewed ratio cannot drain more than tolerated.
        let max_tobe = mint_state.vault_balance.min(max_tobe_to_pair);
        let max_sol = sol_to_deposit;
        // Snapshot real vault TOBE before the deposit so we can decrement state by
        // the ACTUAL amount Raydium consumed, not a pre-CPI estimate (#6).
        let vault_tobe_before = ctx.accounts.vault_token_account.amount;
        let (max_token_0, max_token_1) = if mint_state.tobe_is_token_0 {
            (max_tobe, max_sol)
        } else {
            (max_sol, max_tobe)
        };

        // 4. Raydium CPI deposit (vault_authority signs)
        let cpi_accounts = raydium_cp_swap::cpi::accounts::Deposit {
            owner: ctx.accounts.vault_authority.to_account_info(),
            authority: ctx.accounts.raydium_pool_authority.to_account_info(),
            pool_state: ctx.accounts.raydium_pool_state.to_account_info(),
            owner_lp_token: ctx.accounts.lp_receipt.to_account_info(),
            token_0_account,
            token_1_account,
            token_0_vault: ctx.accounts.raydium_token_0_vault.to_account_info(),
            token_1_vault: ctx.accounts.raydium_token_1_vault.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
            vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
            vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
            lp_mint: ctx.accounts.raydium_lp_mint.to_account_info(),
        };
        raydium_cp_swap::cpi::deposit(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                cpi_accounts,
                vault_signer,
            ),
            target_lp,
            max_token_0,
            max_token_1,
        )?;

        // 5. Burn the LP receipt (locks liquidity forever)
        ctx.accounts.lp_receipt.reload()?;
        let lp_received = ctx.accounts.lp_receipt.amount;
        require!(lp_received > 0, TobeError::LpAmountZero);
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.raydium_lp_mint.to_account_info(),
                    from: ctx.accounts.lp_receipt.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                vault_signer,
            ),
            lp_received,
        )?;

        // 6. Reconcile the SOL side like the TOBE side. Raydium consumes SOL
        //    based on the fee-EXCLUDED (net) vault, while target_lp is sized from
        //    the raw vault, so on a fee-bearing pool some wrapped SOL is left
        //    unconsumed in wsol_temp. Measure that residual and close wsol_temp
        //    to the protocol's pool_sol_reserve (NOT the caller) so the leftover
        //    protocol SOL + this account's rent return to the protocol instead of
        //    being swept by the permissionless caller. The residual rolls forward
        //    in accounting for the next flush.
        ctx.accounts.wsol_temp.reload()?;
        let sol_residual = ctx.accounts.wsol_temp.amount;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ctx.accounts.wsol_temp.to_account_info(),
                destination: ctx.accounts.pool_sol_reserve.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            vault_signer,
        ))?;
        // lp_receipt only holds rent after the burn — return that to the caller.
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ctx.accounts.lp_receipt.to_account_info(),
                destination: ctx.accounts.caller.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            vault_signer,
        ))?;

        // 7. Update state. Decrement vault_balance by the TOBE Raydium ACTUALLY
        //    consumed (measured), so the counter stays equal to the real token
        //    account balance — never drifts off a pre-CPI estimate (#6).
        ctx.accounts.vault_token_account.reload()?;
        let tobe_spent = vault_tobe_before
            .checked_sub(ctx.accounts.vault_token_account.amount)
            .ok_or(TobeError::MathOverflow)?;
        // Roll the unconsumed SOL forward instead of zeroing (which would drop
        // the leaked-then-reclaimed residual from accounting).
        mint_state.pool_sol_balance = sol_residual;
        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_sub(tobe_spent)
            .ok_or(TobeError::MathOverflow)?;

        msg!(
            "Flush: deposited {} TOBE + {} lamports → {} LP burned",
            tobe_spent,
            sol_to_deposit,
            lp_received,
        );
        Ok(())
    }

    pub fn update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
        ctx.accounts.mint_state.treasury = new_treasury;
        Ok(())
    }

    /// Change the founder revenue wallet (receives 50% of buy_from_vault).
    /// Authority-only (a 2-of-3 council proposal after migration). Rejects the
    /// zero address, which would burn the founder half.
    pub fn update_founder(ctx: Context<UpdateTreasury>, new_founder: Pubkey) -> Result<()> {
        require!(new_founder != Pubkey::default(), TobeError::InvalidAmount);
        ctx.accounts.mint_state.founder = new_founder;
        Ok(())
    }

    /// One-time migration: reallocates the existing mint_state PDA to fit
    /// new MintState fields (raydium pool config). New bytes are zero-init,
    /// which is exactly the "unconfigured" default for Pubkey + u64 + bool.
    /// Authority-only. Idempotent (no-op if already at new size).
    pub fn migrate_state_v2(ctx: Context<MigrateStateV2>) -> Result<()> {
        let mint_state = &ctx.accounts.mint_state;

        // Manually validate authority by reading from raw data (UncheckedAccount).
        let stored_authority = {
            let data = mint_state.try_borrow_data()?;
            require!(data.len() >= 40, TobeError::Unauthorized);
            Pubkey::new_from_array(data[8..40].try_into().unwrap())
        };
        require_keys_eq!(
            stored_authority,
            ctx.accounts.authority.key(),
            TobeError::Unauthorized
        );

        let new_size = 8usize + MintState::INIT_SPACE;
        let current_size = mint_state.data_len();
        if new_size <= current_size {
            msg!("MintState already at v2 size ({} bytes); no-op", current_size);
            return Ok(());
        }

        // Top up rent if needed
        let rent = Rent::get()?;
        let new_min_lamports = rent.minimum_balance(new_size);
        let current_lamports = mint_state.lamports();
        if new_min_lamports > current_lamports {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: mint_state.to_account_info(),
                    },
                ),
                new_min_lamports - current_lamports,
            )?;
        }

        // Realloc with zero-init for new bytes
        mint_state.to_account_info().realloc(new_size, true)?;

        msg!(
            "MintState reallocated: {} → {} bytes (Phase 2 fields zero-initialized)",
            current_size,
            new_size,
        );
        Ok(())
    }

    /// Emergency pause — stops all minting. Only authority can call.
    pub fn pause(ctx: Context<AuthorityOnly>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        require!(!mint_state.paused, TobeError::AlreadyPaused);
        mint_state.paused = true;
        msg!("Minting paused by authority");
        Ok(())
    }

    /// Resume minting after a pause. Only authority can call.
    pub fn unpause(ctx: Context<AuthorityOnly>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        require!(mint_state.paused, TobeError::NotPaused);
        mint_state.paused = false;
        msg!("Minting resumed by authority");
        Ok(())
    }

    /// Step 1 of authority transfer: current authority proposes a new one.
    pub fn propose_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.pending_authority = new_authority;
        msg!("Authority transfer proposed to {}", new_authority);
        Ok(())
    }

    /// Step 2 of authority transfer: new authority accepts.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.authority = ctx.accounts.new_authority.key();
        mint_state.pending_authority = Pubkey::default();
        msg!("Authority transferred to {}", mint_state.authority);
        Ok(())
    }

    /// Lock LP tokens in a PDA for 2 years. Can only be called once.
    pub fn lock_lp(ctx: Context<LockLp>, amount: u64) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(!mint_state.lp_locked, TobeError::LpAlreadyLocked);
        require!(amount > 0, TobeError::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_lp_account.to_account_info(),
                    to: ctx.accounts.lp_lock_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;

        let clock = Clock::get()?;
        mint_state.lp_mint = ctx.accounts.lp_mint.key();
        mint_state.lp_lock_until = clock.unix_timestamp
            .checked_add(LP_LOCK_DURATION)
            .ok_or(TobeError::MathOverflow)?;
        mint_state.lp_locked = true;

        msg!("LP locked: {} tokens until {}", amount, mint_state.lp_lock_until);
        Ok(())
    }

    /// Update token metadata (name, symbol, URI). Authority only.
    pub fn update_metadata(
        ctx: Context<UpdateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let mut data_buf: Vec<u8> = vec![15]; // UpdateMetadataAccountV2 discriminator
        data_buf.push(1); // Option<DataV2>: Some
        data_buf.extend_from_slice(&(name.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(name.as_bytes());
        data_buf.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(symbol.as_bytes());
        data_buf.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data_buf.extend_from_slice(uri.as_bytes());
        data_buf.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
        data_buf.push(0); // creators: None
        data_buf.push(0); // collection: None
        data_buf.push(0); // uses: None
        data_buf.push(0); // new_update_authority: None
        data_buf.push(0); // primary_sale_happened: None
        data_buf.push(0); // is_mutable: None

        let accounts = vec![
            AccountMeta::new(ctx.accounts.metadata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint_authority.key(), true),
        ];

        let ix = Instruction {
            program_id: MPL_TOKEN_METADATA_ID,
            accounts,
            data: data_buf,
        };

        let seeds = &[b"mint_authority".as_ref(), &[ctx.accounts.mint_state.bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!("Metadata updated: {} ({}) - {}", name, symbol, uri);
        Ok(())
    }

    /// Withdraw LP tokens after the 2-year lock expires.
    pub fn unlock_lp(ctx: Context<UnlockLp>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(mint_state.lp_locked, TobeError::LpNotLocked);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= mint_state.lp_lock_until,
            TobeError::LpStillLocked
        );

        let vault_balance = ctx.accounts.lp_lock_vault.amount;

        let seeds = &[b"lp_lock_authority".as_ref(), &[mint_state.lp_lock_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lp_lock_vault.to_account_info(),
                    to: ctx.accounts.authority_lp_account.to_account_info(),
                    authority: ctx.accounts.lp_lock_authority.to_account_info(),
                },
                &[seeds],
            ),
            vault_balance,
        )?;

        mint_state.lp_locked = false;

        msg!("LP unlocked: {} tokens returned to authority", vault_balance);
        Ok(())
    }
}

// ─── Account Structs ───

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + MintState::INIT_SPACE,
        seeds = [b"mint_state"],
        bump
    )]
    pub mint_state: Account<'info, MintState>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 9,
        mint::authority = mint_authority,
    )]
    pub tobe_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        token::mint = tobe_mint,
        token::authority = vault_authority,
        seeds = [b"vault_token"],
        bump
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA LP lock authority
    #[account(seeds = [b"lp_lock_authority"], bump)]
    pub lp_lock_authority: UncheckedAccount<'info>,

    /// CHECK: Metaplex metadata account (PDA derived from mint)
    #[account(
        mut,
        seeds = [
            b"metadata",
            MPL_TOKEN_METADATA_ID.as_ref(),
            tobe_mint.key().as_ref(),
        ],
        bump,
        seeds::program = MPL_TOKEN_METADATA_ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex Token Metadata Program
    #[account(address = MPL_TOKEN_METADATA_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    // Bind initialize to the program's upgrade authority so the one-shot init
    // (which sets authority + treasury) cannot be front-run by anyone else in
    // the deploy window. Only the wallet that deployed/upgrades this program can
    // initialize it.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ TobeError::Unauthorized)]
    pub program: Program<'info, crate::program::NecoToken>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ TobeError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintTobe<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    #[account(mut, address = mint_state.tobe_mint)]
    pub tobe_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA mint authority
    #[account(seeds = [b"mint_authority"], bump = mint_state.bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA for pool SOL reserve (receives 5 SOL/mint, accumulates for LP injection)
    #[account(mut, seeds = [b"pool_sol_reserve"], bump)]
    pub pool_sol_reserve: UncheckedAccount<'info>,

    /// CHECK: PDA for vault SOL reserve (receives 5 SOL/mint, used by sell_to_vault floor defense)
    #[account(mut, seeds = [b"vault_sol_reserve"], bump)]
    pub vault_sol_reserve: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = minter_tobe.mint == tobe_mint.key(),
        constraint = minter_tobe.owner == minter.key()
    )]
    pub minter_tobe: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyFromVault<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA vault authority — signs the TOBE transfer out.
    #[account(seeds = [b"vault_authority"], bump = mint_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// DAO treasury wallet — receives 50% of buy_from_vault proceeds.
    #[account(
        mut,
        constraint = treasury.key() == mint_state.treasury @ TobeError::Unauthorized
    )]
    pub treasury: SystemAccount<'info>,

    /// Founder wallet — receives the other 50% (disclosed founder fee).
    #[account(
        mut,
        constraint = founder.key() == mint_state.founder @ TobeError::Unauthorized
    )]
    pub founder: SystemAccount<'info>,

    /// Pool vaults, for the F2 price gate (TOBE must be >= $1 to buy from the
    /// vault). Validated against the recorded pool config exactly as ArmFloor
    /// does, so the price read cannot be spoofed with unrelated token accounts.
    #[account(constraint = raydium_token_0_vault.key() == mint_state.raydium_token_0_vault @ TobeError::PoolMismatch)]
    pub raydium_token_0_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = raydium_token_1_vault.key() == mint_state.raydium_token_1_vault @ TobeError::PoolMismatch)]
    pub raydium_token_1_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_tobe.mint == mint_state.tobe_mint,
        constraint = buyer_tobe.owner == buyer.key()
    )]
    pub buyer_tobe: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pyth SOL/USD price update account. Feed identity is verified inside
    /// `read_sol_usd_price` against the hardcoded SOL/USD feed_id, so any
    /// PriceUpdateV2 with the right feed_id is accepted (sponsored, ephemeral,
    /// or user-posted via Hermes).
    pub pyth_price_update: Account<'info, PriceUpdateV2>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellToVault<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA holding floor-defense SOL (drained by sell_to_vault).
    #[account(mut, seeds = [b"vault_sol_reserve"], bump)]
    pub vault_sol_reserve: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = seller_tobe.mint == mint_state.tobe_mint,
        constraint = seller_tobe.owner == seller.key()
    )]
    pub seller_tobe: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pyth SOL/USD price update account. Feed identity is verified inside
    /// `read_sol_usd_price` against the hardcoded SOL/USD feed_id, so any
    /// PriceUpdateV2 with the right feed_id is accepted (sponsored, ephemeral,
    /// or user-posted via Hermes).
    pub pyth_price_update: Account<'info, PriceUpdateV2>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ArmFloor<'info> {
    // H1 fix: arming the $1 floor is authority-only (a 2-of-3 council multisig
    // after migration). This removes the permissionless flash-manipulation path
    // where anyone could skew the pool spot ratio across $1 and latch the floor
    // early to unlock a vault_sol_reserve drain.
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// Pool vaults are validated against the recorded pool config so the price
    /// read cannot be spoofed with unrelated token accounts.
    #[account(constraint = raydium_token_0_vault.key() == mint_state.raydium_token_0_vault @ TobeError::PoolMismatch)]
    pub raydium_token_0_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = raydium_token_1_vault.key() == mint_state.raydium_token_1_vault @ TobeError::PoolMismatch)]
    pub raydium_token_1_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub pyth_price_update: Account<'info, PriceUpdateV2>,
}

// ─── Phase 2: Raydium account structs ───

#[derive(Accounts)]
pub struct SetPoolConfig<'info> {
    #[account(
        mut,
        constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// Pool ID; typed as AccountLoader so Anchor enforces it is a genuine
    /// Raydium CP-swap pool account (owned by the Raydium program) at config
    /// time, not an arbitrary key. Address is recorded into state.
    pub raydium_pool_state: AccountLoader<'info, raydium_cp_swap::states::PoolState>,

    /// CHECK: Raydium pool authority PDA; recorded into state.
    pub raydium_pool_authority: UncheckedAccount<'info>,

    /// CHECK: pool's LP mint; recorded into state.
    pub raydium_lp_mint: UncheckedAccount<'info>,

    /// CHECK: pool's token_0 vault; recorded into state.
    pub raydium_token_0_vault: UncheckedAccount<'info>,

    /// CHECK: pool's token_1 vault; recorded into state.
    pub raydium_token_1_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FlushLpToRaydium<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    // Boxed to keep this large context's try_accounts off the SBF stack frame
    // (the Raydium CPI has ~18 accounts; a non-boxed MintState here trips the
    // 4KB stack-frame limit).
    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Box<Account<'info, MintState>>,

    #[account(mut, address = mint_state.tobe_mint)]
    pub tobe_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA vault authority — signs all CPI account transfers
    #[account(seeds = [b"vault_authority"], bump = mint_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// Vault TOBE — source of token side
    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA holding accumulated SOL pending LP injection
    #[account(mut, seeds = [b"pool_sol_reserve"], bump)]
    pub pool_sol_reserve: UncheckedAccount<'info>,

    /// Wrapped-SOL temp account owned by vault_authority. init_if_needed each flush.
    #[account(
        init_if_needed,
        payer = caller,
        seeds = [b"wsol_temp"],
        bump,
        token::mint = wsol_mint,
        token::authority = vault_authority,
    )]
    pub wsol_temp: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// LP receipt — receives LP tokens from CPI, then immediately burned. init_if_needed.
    #[account(
        init_if_needed,
        payer = caller,
        seeds = [b"lp_receipt"],
        bump,
        token::mint = raydium_lp_mint,
        token::authority = vault_authority,
    )]
    pub lp_receipt: Box<InterfaceAccount<'info, TokenAccount>>,

    // Raydium pool accounts (validated against state)
    #[account(
        mut,
        constraint = raydium_pool_state.key() == mint_state.raydium_pool_state
            @ TobeError::PoolMismatch,
    )]
    pub raydium_pool_state: AccountLoader<'info, raydium_cp_swap::states::PoolState>,

    #[account(
        mut,
        constraint = raydium_lp_mint.key() == mint_state.raydium_lp_mint
            @ TobeError::PoolMismatch,
    )]
    pub raydium_lp_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Raydium pool authority; address validated against state.
    #[account(
        constraint = raydium_pool_authority.key() == mint_state.raydium_pool_authority
            @ TobeError::PoolMismatch,
    )]
    pub raydium_pool_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = raydium_token_0_vault.key() == mint_state.raydium_token_0_vault
            @ TobeError::PoolMismatch,
    )]
    pub raydium_token_0_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = raydium_token_1_vault.key() == mint_state.raydium_token_1_vault
            @ TobeError::PoolMismatch,
    )]
    pub raydium_token_1_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = raydium_token_0_vault.mint)]
    pub vault_0_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = raydium_token_1_vault.mint)]
    pub vault_1_mint: Box<InterfaceAccount<'info, Mint>>,

    pub raydium_program: Program<'info, raydium_cp_swap::program::RaydiumCpSwap>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, anchor_spl::token_2022::Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MigrateStateV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: deserialized manually (old layout); validated by reading authority from raw data.
    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        constraint = new_authority.key() == mint_state.pending_authority @ TobeError::NoPendingAuthority
    )]
    pub new_authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,
}

#[derive(Accounts)]
pub struct LockLp<'info> {
    #[account(
        mut,
        constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    pub lp_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA authority for the LP lock vault
    #[account(seeds = [b"lp_lock_authority"], bump)]
    pub lp_lock_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        token::mint = lp_mint,
        token::authority = lp_lock_authority,
        seeds = [b"lp_lock_vault"],
        bump
    )]
    pub lp_lock_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_lp_account.mint == lp_mint.key(),
        constraint = authority_lp_account.owner == authority.key()
    )]
    pub authority_lp_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnlockLp<'info> {
    #[account(
        constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA authority for the LP lock vault
    #[account(seeds = [b"lp_lock_authority"], bump = mint_state.lp_lock_bump)]
    pub lp_lock_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"lp_lock_vault"],
        bump,
        constraint = lp_lock_vault.mint == mint_state.lp_mint
    )]
    pub lp_lock_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_lp_account.mint == mint_state.lp_mint,
        constraint = authority_lp_account.owner == authority.key()
    )]
    pub authority_lp_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA mint authority (also the update authority for metadata)
    #[account(seeds = [b"mint_authority"], bump = mint_state.bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: Metaplex metadata account
    #[account(
        mut,
        seeds = [
            b"metadata",
            MPL_TOKEN_METADATA_ID.as_ref(),
            mint_state.tobe_mint.as_ref(),
        ],
        bump,
        seeds::program = MPL_TOKEN_METADATA_ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex Token Metadata Program
    #[account(address = MPL_TOKEN_METADATA_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
}

// ─── State ───

#[account]
#[derive(InitSpace)]
pub struct MintState {
    pub authority: Pubkey,           // 32
    pub pending_authority: Pubkey,   // 32
    pub treasury: Pubkey,            // 32
    pub tobe_mint: Pubkey,           // 32
    pub lp_mint: Pubkey,             // 32
    pub current_round: u64,          // 8
    pub vault_balance: u64,          // 8
    pub total_vault_released: u64,   // 8
    pub lp_lock_until: i64,          // 8
    pub lp_locked: bool,             // 1
    pub paused: bool,                // 1
    pub pool_seeded: bool,           // 1
    pub bump: u8,                    // 1
    pub vault_bump: u8,              // 1
    pub lp_lock_bump: u8,            // 1
    pub total_minted: u64,           // 8
    pub pool_sol_balance: u64,       // 8 — accumulated SOL pending LP injection

    // ─── Phase 2: Raydium pool config (set once via set_pool_config) ───
    pub raydium_pool_state: Pubkey,        // 32 — pool ID; default = unconfigured
    pub raydium_pool_authority: Pubkey,    // 32 — Raydium-derived auth PDA
    pub raydium_lp_mint: Pubkey,           // 32 — pool's LP mint
    pub raydium_token_0_vault: Pubkey,     // 32 — pool's vault for token_0
    pub raydium_token_1_vault: Pubkey,     // 32 — pool's vault for token_1
    pub tobe_is_token_0: bool,             // 1  — true if TOBE is token_0 in the pool
    pub vault_tobe_at_config: u64,         // 8  — vault balance baseline for floor protection
    pub floor_active: bool,                // 1  — one-way latch: sell_to_vault floor is disabled
                                           //      until TOBE first reaches $1 (see arm_floor),
                                           //      preventing the early below-$1 drain arbitrage
    pub founder: Pubkey,                   // 32 — receives 50% of buy_from_vault proceeds
                                           //      (disclosed founder fee); other 50% → treasury

    // ─── Phase 3: disclosed team allocation ───
    pub team_wallet: Pubkey,               // 32 — set once at initialize, no setter; this wallet's
                                           //      first TEAM_FREE_MINT_CAP mints are payment-free
    pub team_free_mints_used: u64,         // 8  — free team mints consumed (cap: TEAM_FREE_MINT_CAP);
                                           //      appended fields — run migrate_state_v2 after upgrade
                                           //      to realloc + zero-init on existing deployments

    // ─── Round 6: H2 fix — founder cut on new depletion only ───
    pub founder_cut_paid: u64,             // 8  — cumulative lamports paid to `founder` by
                                           //      buy_from_vault (telemetry / transparency)
    pub max_vault_depletion: u64,          // 8  — high-water mark of net vault depletion
                                           //      (total_minted/2 - vault_balance). The founder
                                           //      is paid only on ground beyond this, so a
                                           //      buy→sell round trip earns nothing while
                                           //      genuine net demand earns the full 50%.
}

// ─── Errors ───

#[error_code]
pub enum TobeError {
    #[msg("All 1024 mint rounds have been completed")]
    AllRoundsMinted,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient vault balance")]
    InsufficientVault,
    #[msg("LP tokens are already locked")]
    LpAlreadyLocked,
    #[msg("LP tokens are not locked")]
    LpNotLocked,
    #[msg("LP tokens are still locked — 2 year lock has not expired")]
    LpStillLocked,
    #[msg("Minting is paused")]
    MintingPaused,
    #[msg("Minting is already paused")]
    AlreadyPaused,
    #[msg("Minting is not paused")]
    NotPaused,
    #[msg("No pending authority transfer")]
    NoPendingAuthority,
    #[msg("Pool has already been seeded")]
    PoolAlreadySeeded,
    #[msg("Pyth price feed account does not match the configured feed")]
    InvalidPriceFeed,
    #[msg("Pyth price feed is stale")]
    StalePriceFeed,
    #[msg("Pyth confidence interval too wide")]
    PriceConfidenceTooWide,
    #[msg("Pyth price is non-positive")]
    NonPositivePrice,
    #[msg("Vault has insufficient SOL for this trade")]
    VaultSolInsufficient,
    #[msg("Pool SOL reserve has insufficient lamports for this trade")]
    PoolSolInsufficient,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Cannot refer yourself")]
    SelfReferral,
    // ─── Phase 2: Raydium flush errors ───
    #[msg("Pool config has not been set; call set_pool_config first")]
    PoolNotConfigured,
    #[msg("Pool config does not match accounts passed in")]
    PoolMismatch,
    #[msg("Pool config has already been set; cannot reconfigure")]
    PoolAlreadyConfigured,
    #[msg("LP-pending SOL is below flush threshold (1 SOL)")]
    BelowFlushThreshold,
    #[msg("Pulling TOBE from vault would breach the floor protection (30% of baseline)")]
    VaultFloorBreach,
    #[msg("Raydium CPI returned zero LP tokens")]
    LpAmountZero,
    #[msg("Pool reserves are empty; cannot compute deposit ratio")]
    EmptyPoolReserves,
    #[msg("Flush slippage exceeded: required TOBE exceeds caller's max_tobe_to_pair")]
    SlippageExceeded,
    #[msg("The $1 floor is not active yet; it arms once TOBE first reaches $1 (call arm_floor)")]
    FloorNotActive,
    #[msg("The $1 floor is already active")]
    FloorAlreadyActive,
    #[msg("TOBE market price is below $1; cannot arm the floor yet")]
    PriceBelowPeg,
}

#[cfg(test)]
mod pyth_math_tests {
    use super::{
        founder_cut_on_new_depletion, lamports_to_tobe_at_one_usd, tobe_at_or_above_one_usd,
        tobe_to_lamports_at_one_usd, vault_withdrawal_within_floor,
    };

    #[test]
    fn lamports_to_tobe_at_150_usd_per_sol() {
        // 1 SOL (1e9 lamports) at $150/SOL → should yield 150 TOBE = 150 * 1e9 raw.
        let tobe = lamports_to_tobe_at_one_usd(1_000_000_000, 15_000_000_000, -8).unwrap();
        assert_eq!(tobe, 150_000_000_000);
    }

    #[test]
    fn tobe_to_lamports_at_150_usd_per_sol() {
        // 150 TOBE @ $1 = $150 = 1 SOL when SOL = $150.
        let lamports = tobe_to_lamports_at_one_usd(150_000_000_000, 15_000_000_000, -8).unwrap();
        assert_eq!(lamports, 1_000_000_000);
    }

    #[test]
    fn round_trip_preserves_value() {
        let original_lamports = 5_000_000_000u64; // 5 SOL
        let sol_usd = 12_345_000_000i64; // $123.45
        let tobe = lamports_to_tobe_at_one_usd(original_lamports, sol_usd, -8).unwrap();
        let back = tobe_to_lamports_at_one_usd(tobe, sol_usd, -8).unwrap();
        // Allow tiny rounding error.
        assert!((original_lamports as i64 - back as i64).abs() <= 1);
    }

    #[test]
    fn rejects_negative_price() {
        assert!(lamports_to_tobe_at_one_usd(1_000_000_000, -1, -8).is_err());
        assert!(tobe_to_lamports_at_one_usd(1_000_000_000, -1, -8).is_err());
    }

    // ── arm_floor peg gate ──
    // At $150/SOL, 1 SOL backs 150 TOBE at $1. tobe_at_or_above_one_usd is the
    // exact condition arm_floor requires before latching floor_active = true.

    #[test]
    fn arm_gate_true_at_peg() {
        // Pool holds exactly what its SOL backs at $1 (150 TOBE, 1 SOL @ $150) →
        // TOBE/USD == $1 → arm. Boundary is inclusive (>=), matching arm_floor.
        assert!(
            tobe_at_or_above_one_usd(150_000_000_000, 1_000_000_000, 15_000_000_000, -8).unwrap()
        );
    }

    #[test]
    fn arm_gate_true_above_peg() {
        // Fewer TOBE (100) than the pool's SOL backs at $1 (150) → TOBE/USD > $1 → arm.
        assert!(
            tobe_at_or_above_one_usd(100_000_000_000, 1_000_000_000, 15_000_000_000, -8).unwrap()
        );
    }

    #[test]
    fn arm_gate_false_below_peg() {
        // More TOBE (151) than the SOL backs at $1 (150) → TOBE/USD < $1 → do NOT arm.
        // This is the flash-manipulation case the H1 fix + this gate must reject.
        assert!(
            !tobe_at_or_above_one_usd(151_000_000_000, 1_000_000_000, 15_000_000_000, -8).unwrap()
        );
    }

    #[test]
    fn arm_gate_rejects_bad_price() {
        // A non-positive SOL price must surface an error, never silently arm the floor.
        assert!(tobe_at_or_above_one_usd(1, 1_000_000_000, -1, -8).is_err());
    }

    // ── vault floor ──
    // Baseline 1000 => floor is 300 (30%). Guards flush_lp_to_raydium ONLY: the
    // buy_from_vault floor (Round 5's F1 mitigation) was removed by founder decision
    // on 2026-07-26. These still pin the helper's arithmetic for the flush path, and
    // the monotonic-baseline reasoning they encode is what buy_from_vault's founder-cut
    // high-water mark relies on.

    #[test]
    fn vault_floor_allows_withdrawal_down_to_the_line() {
        // 1000 - 700 = 300 == floor. Inclusive, matching the `>=` in both callers.
        assert!(vault_withdrawal_within_floor(1000, 1000, 700).unwrap());
    }

    #[test]
    fn vault_floor_blocks_crossing_the_line() {
        // 1000 - 701 = 299 < 300 → must be refused.
        assert!(!vault_withdrawal_within_floor(1000, 1000, 701).unwrap());
        // The F1 case: draining the vault outright.
        assert!(!vault_withdrawal_within_floor(1000, 1000, 1000).unwrap());
    }

    #[test]
    fn vault_floor_errors_on_underflow() {
        // Taking more than the vault holds must error, not wrap to a huge number.
        assert!(vault_withdrawal_within_floor(1000, 1000, 1001).is_err());
    }

    #[test]
    fn vault_floor_monotonic_baseline_cannot_be_ratcheted_down() {
        // The bug this guards against: anchoring the floor to the CURRENT balance
        // lets repeated withdrawals walk the vault to zero, because each one lowers
        // the balance and therefore the next floor (1000 -> 300 -> 90 -> 27 -> ...).
        //
        // A monotonic baseline never decreases. Simulate a vault drained toward the
        // floor while the baseline stays put: once at the line, EVERY further
        // withdrawal must be refused.
        let baseline = 1000u64; // total_minted/2, monotonic
        let mut vault = 1000u64;
        // Walk down to the floor (300) in chunks.
        for _ in 0..10 {
            if vault_withdrawal_within_floor(vault, baseline, 100).unwrap() {
                vault -= 100;
            } else {
                break;
            }
        }
        assert_eq!(vault, 300, "should stop exactly at 30% of the fixed baseline");
        // At the floor, nothing more may leave — not even 1 unit.
        assert!(!vault_withdrawal_within_floor(vault, baseline, 1).unwrap());
    }

    #[test]
    fn vault_floor_rises_as_minting_continues() {
        // The stale-snapshot bug: a baseline captured early decays into
        // irrelevance. With the monotonic baseline the floor tracks the vault, so
        // the protected FRACTION stays 30% no matter how large the vault grows.
        for &minted in &[10_000u64, 1_000_000, 500_000_000] {
            let baseline = minted / 2; // vault if nothing withdrawn
            let vault = baseline; // untouched vault
            let floor = baseline * 30 / 100;
            // Taking everything above the floor is allowed...
            assert!(vault_withdrawal_within_floor(vault, baseline, vault - floor).unwrap());
            // ...but one unit more is not, at every scale.
            assert!(!vault_withdrawal_within_floor(vault, baseline, vault - floor + 1).unwrap());
        }
    }

    #[test]
    fn vault_floor_is_zero_when_the_baseline_is_zero() {
        // A zero baseline yields a zero floor, permitting a full drain. This is why
        // the choice of baseline matters more than the percentage.
        //
        // Applies to FLUSH, whose baseline (`vault_tobe_at_config`) is 0 until
        // set_pool_config runs — flush separately requires the pool to be configured,
        // so it can never be called in that window. Flush is now the only caller.
        assert!(vault_withdrawal_within_floor(1000, 0, 1000).unwrap());
    }

    // ── founder cut on NEW net depletion (H2 fix, Round 6) ──
    // never_withdrawn = total_minted/2. Depletion = never_withdrawn - vault_balance.
    // The founder is paid only on ground beyond the high-water mark.

    #[test]
    fn founder_earns_the_full_half_on_a_fresh_vault() {
        // Untouched vault (balance == never_withdrawn, mark 0). The whole buy is new
        // ground, so the founder earns the entire nominal half.
        let (cut, mark) =
            founder_cut_on_new_depletion(1_000_000_000, 1_000, 10_000, 10_000, 0).unwrap();
        assert_eq!(cut, 500_000_000);
        assert_eq!(mark, 1_000);
    }

    #[test]
    fn h2_round_trip_earns_the_founder_nothing() {
        // THE H2 TEST. buy → sell → buy. The sell restores the vault, so the second
        // buy re-covers ground the high-water mark already holds and earns 0. This is
        // what makes the drain cycle pointless.
        let never_withdrawn = 10_000u64;
        // 1st buy: 1000 TOBE out of a full vault.
        let (cut1, mark) =
            founder_cut_on_new_depletion(1_000_000_000, 1_000, never_withdrawn, 10_000, 0).unwrap();
        assert_eq!(cut1, 500_000_000, "genuine first buy pays in full");
        assert_eq!(mark, 1_000);
        // sell_to_vault returns the 1000 TOBE — vault back to 10_000, mark unchanged.
        // 2nd buy, identical: depletion returns to 1_000, which the mark already covers.
        let (cut2, mark2) =
            founder_cut_on_new_depletion(1_000_000_000, 1_000, never_withdrawn, 10_000, mark)
                .unwrap();
        assert_eq!(cut2, 0, "round-tripped buy must earn nothing");
        assert_eq!(mark2, 1_000, "mark must not move");
        // ...and it stays 0 however many times the cycle is repeated.
        for _ in 0..1_000 {
            let (c, m) =
                founder_cut_on_new_depletion(1_000_000_000, 1_000, never_withdrawn, 10_000, mark2)
                    .unwrap();
            assert_eq!(c, 0);
            assert_eq!(m, mark2);
        }
    }

    #[test]
    fn h2_reverse_order_round_trip_also_earns_nothing() {
        // sell → buy, the mirror attack. The founder sells TOBE in first (vault rises
        // above never_withdrawn, depletion clamps to 0), then buys back out. Buying
        // back down to a level the mark already covers earns nothing.
        let never_withdrawn = 10_000u64;
        let mark = 1_000u64; // vault has previously been drawn down to 9_000
        // Founder sells 2_000 in: vault 9_000 -> 11_000, above never_withdrawn.
        // Now buys 2_000 back out: vault 11_000 -> 9_000, depletion back to 1_000.
        let (cut, new_mark) =
            founder_cut_on_new_depletion(1_000_000_000, 2_000, never_withdrawn, 11_000, mark)
                .unwrap();
        assert_eq!(cut, 0, "buying back ground already covered must earn nothing");
        assert_eq!(new_mark, 1_000);
    }

    #[test]
    fn founder_earns_pro_rata_on_the_new_portion_only() {
        // The partial case needs the mark ABOVE current depletion: the vault was
        // previously drawn to 9_000 (mark 1_000) and has since been partly refilled by
        // floor buybacks to 9_500 (depletion 500). A 1_000-TOBE buy takes depletion
        // 500 -> 1_500, of which only the 500 past the mark is new ground. The founder
        // earns half the nominal half; the other half goes to the DAO.
        let (cut, mark) =
            founder_cut_on_new_depletion(1_000_000_000, 1_000, 10_000, 9_500, 1_000).unwrap();
        assert_eq!(cut, 250_000_000, "500 of 1000 new => half the nominal half");
        assert_eq!(mark, 1_500);
    }

    #[test]
    fn genuine_sequential_demand_earns_the_full_half_each_time() {
        // Real arbitrage keeps pushing the vault to new lows, so every buy is entirely
        // new ground. This is the uncapped upside the mechanism preserves.
        let never_withdrawn = 100_000u64;
        let mut vault = 100_000u64;
        let mut mark = 0u64;
        for _ in 0..10 {
            let (cut, m) =
                founder_cut_on_new_depletion(1_000_000_000, 1_000, never_withdrawn, vault, mark)
                    .unwrap();
            assert_eq!(cut, 500_000_000, "net-new demand always pays the full half");
            mark = m;
            vault -= 1_000;
        }
        assert_eq!(mark, 10_000);
    }

    #[test]
    fn no_cut_while_the_vault_holds_more_than_was_ever_minted_into_it() {
        // After heavy net selling the vault can exceed never_withdrawn (see L1).
        // Depletion clamps at 0, so buying back down into that surplus earns nothing —
        // correct, because the protocol paid reserve SOL to acquire those tokens.
        let (cut, mark) =
            founder_cut_on_new_depletion(1_000_000_000, 5_000, 10_000, 20_000, 0).unwrap();
        assert_eq!(cut, 0);
        assert_eq!(mark, 0);
    }

    #[test]
    fn founder_split_always_sums_to_the_amount_paid() {
        // The mechanism must never create or destroy lamports: whatever the founder
        // does not earn goes to the DAO, so the buyer's payment is fully accounted for.
        for &(sol_in, tobe_out, never, vault, mark) in &[
            (1_000_000_000u64, 1_000u64, 10_000u64, 10_000u64, 0u64), // all new
            (1_000_000_000, 1_000, 10_000, 9_500, 500),               // partial
            (1_000_000_000, 1_000, 10_000, 10_000, 5_000),            // none new
            (3, 1_000, 10_000, 10_000, 0),                            // odd lamport
        ] {
            let (cut, _) =
                founder_cut_on_new_depletion(sol_in, tobe_out, never, vault, mark).unwrap();
            let dao = sol_in.checked_sub(cut).unwrap();
            assert_eq!(cut + dao, sol_in);
            assert!(cut <= sol_in / 2, "cut must never exceed the nominal half");
        }
    }

    #[test]
    fn depletion_math_does_not_overflow_at_full_supply_scale() {
        // Realistic worst case: the full 268.7M-TOBE vault (9 decimals) against a large
        // buy. nominal x new_ground exceeds u64, so the u128 intermediate is required.
        let never = 268_697_600u64 * 1_000_000_000;
        let tobe_out = 1_000_000u64 * 1_000_000_000;
        let (cut, mark) =
            founder_cut_on_new_depletion(u64::MAX / 2, tobe_out, never, never, 0).unwrap();
        assert_eq!(cut, (u64::MAX / 2) / 2);
        assert_eq!(mark, tobe_out);
    }
}
