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

#[program]
pub mod neco_token {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        admin_authority: Pubkey,
    ) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.authority = admin_authority;
        mint_state.treasury = treasury;
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

    pub fn mint_tobe(ctx: Context<MintTobe>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(!mint_state.paused, TobeError::MintingPaused);
        require!(
            mint_state.current_round < MAX_ROUNDS,
            TobeError::AllRoundsMinted
        );

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

        // Every round: 5 SOL → pool_sol_reserve (LP injection accumulator)
        //              5 SOL → vault_sol_reserve (floor defense reserve)
        let half_cost = MINT_COST / 2;
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
        mint_state.pool_sol_balance = mint_state
            .pool_sol_balance
            .checked_add(half_cost)
            .ok_or(TobeError::MathOverflow)?;

        msg!("Round {}: {} TOBE minted ({} to minter, {} to vault); 5 SOL → pool, 5 SOL → vault_sol",
            round, token_units, minter_tokens, vault_tokens);
        Ok(())
    }

    /// Permissionless: anyone can buy TOBE from the vault at $1/TOBE when Pyth says
    /// SOL/USD is positive (i.e., always, since this caps the upside at $1).
    /// Buyer sends `sol_in_lamports`, receives equivalent TOBE at $1 each.
    /// All received SOL flows to the treasury (authority's wallet).
    pub fn buy_from_vault(ctx: Context<BuyFromVault>, sol_in_lamports: u64) -> Result<()> {
        require!(!ctx.accounts.mint_state.paused, TobeError::MintingPaused);
        require!(sol_in_lamports > 0, TobeError::ZeroAmount);

        let (price, exponent) = read_sol_usd_price(&ctx.accounts.pyth_price_update)?;
        let tobe_out = lamports_to_tobe_at_one_usd(sol_in_lamports, price, exponent)?;
        require!(tobe_out > 0, TobeError::ZeroAmount);

        let mint_state = &mut ctx.accounts.mint_state;
        require!(
            tobe_out <= mint_state.vault_balance,
            TobeError::InsufficientVault
        );

        // 1. Buyer SOL → treasury (authority earns).
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            sol_in_lamports,
        )?;

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
            "buy_from_vault: {} lamports → {} TOBE @ $1 (SOL/USD price={}, exp={})",
            sol_in_lamports, tobe_out, price, exponent
        );
        Ok(())
    }

    /// Permissionless: anyone can sell TOBE to the vault at $1/TOBE.
    /// Seller sends TOBE, receives SOL drawn from vault_sol_reserve at $1 each.
    /// Bought TOBE returns to vault to replenish the upside-cap reserve.
    pub fn sell_to_vault(ctx: Context<SellToVault>, tobe_in_raw: u64) -> Result<()> {
        require!(!ctx.accounts.mint_state.paused, TobeError::MintingPaused);
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
        //    pattern as seed_pool / flush_lp_to_raydium for pool_sol_reserve.)
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

    /// Seed the initial Raydium pool. Releases round 1's vault TOBE + pool SOL reserve.
    /// Authority calls this once after round 1 to create the TOBE/SOL pool.
    pub fn seed_pool(ctx: Context<SeedPool>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        require!(!mint_state.paused, TobeError::MintingPaused);
        require!(!mint_state.pool_seeded, TobeError::PoolAlreadySeeded);

        // Round 1 vault tokens: 1024 * 1024 * 10^9 / 2 = 524,288,000,000,000
        let round1_total = TOKENS_PER_UNIT
            .checked_mul(MAX_ROUNDS)
            .ok_or(TobeError::MathOverflow)?
            .checked_mul(TOBE_DECIMALS_FACTOR)
            .ok_or(TobeError::MathOverflow)?;
        let round1_vault = round1_total / 2;

        // Transfer TOBE from vault to pool destination
        let vault_seeds = &[b"vault_authority".as_ref(), &[mint_state.vault_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.pool_tobe_destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_seeds],
            ),
            round1_vault,
        )?;

        // Transfer SOL from pool reserve PDA to authority
        let sol_balance = ctx.accounts.pool_sol_reserve.lamports();
        let pool_seeds = &[b"pool_sol_reserve".as_ref(), &[ctx.bumps.pool_sol_reserve]];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.pool_sol_reserve.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
                &[pool_seeds],
            ),
            sol_balance,
        )?;

        mint_state.vault_balance = mint_state.vault_balance
            .checked_sub(round1_vault)
            .ok_or(TobeError::MathOverflow)?;
        // seed_pool drains the entire physical pool_sol_reserve above, so the
        // logical accumulator must be zeroed to stay in sync — otherwise
        // flush_lp_to_raydium would later try to move more SOL than exists.
        mint_state.pool_sol_balance = 0;
        mint_state.pool_seeded = true;

        msg!("Pool seeded: {} TOBE + {} lamports SOL", round1_vault, sol_balance);
        Ok(())
    }

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
        // Must run AFTER seed_pool so the 30%-floor baseline (vault_tobe_at_config,
        // set below) is captured against the post-seed vault_balance. Capturing it
        // pre-seed would set the floor too high and could soft-lock flush.
        require!(mint_state.pool_seeded, TobeError::PoolNotConfigured);
        require!(
            mint_state.raydium_pool_state == Pubkey::default(),
            TobeError::PoolAlreadyConfigured
        );

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
        const VAULT_FLOOR_BPS: u128 = 3000; // 30%

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

        // Floor protection
        let floor: u64 = ((mint_state.vault_tobe_at_config as u128)
            .checked_mul(VAULT_FLOOR_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(TobeError::MathOverflow)?) as u64;
        let projected_vault = mint_state
            .vault_balance
            .checked_sub(tobe_to_pair)
            .ok_or(TobeError::VaultFloorBreach)?;
        require!(projected_vault >= floor, TobeError::VaultFloorBreach);

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

        // 6. Close wsol_temp and the (now-empty) lp_receipt, returning rent to caller
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ctx.accounts.wsol_temp.to_account_info(),
                destination: ctx.accounts.caller.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            vault_signer,
        ))?;
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
        mint_state.pool_sol_balance = 0;
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

    /// Treasury wallet — receives SOL from buyer (authority earns).
    #[account(
        mut,
        constraint = treasury.key() == mint_state.treasury @ TobeError::Unauthorized
    )]
    pub treasury: SystemAccount<'info>,

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
pub struct SeedPool<'info> {
    #[account(mut, constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA vault authority
    #[account(seeds = [b"vault_authority"], bump = mint_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA holding SOL for pool seeding
    #[account(mut, seeds = [b"pool_sol_reserve"], bump)]
    pub pool_sol_reserve: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_tobe_destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

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
}

#[cfg(test)]
mod pyth_math_tests {
    use super::{lamports_to_tobe_at_one_usd, tobe_to_lamports_at_one_usd};

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
}
