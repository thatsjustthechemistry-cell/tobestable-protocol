// ═══════════════════════════════════════════════════════════════════════════
//  TOBE STABLE — SOL VERSION (for future testnet/mainnet deploy)
//  Cost: 10 SOL per mint round (no USDC)
//  Users deal with SOL + $TOBE only.
//
//  DEPLOY CHECKLIST:
//    1. Copy this file over lib.rs before building
//    2. Run: anchor build
//    3. Run: anchor deploy --provider.cluster testnet
//    4. Update frontend: all "1,024 USDC" → "10 SOL"
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

declare_id!("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");

const MINT_COST: u64 = 10_000_000_000; // 10 SOL in lamports (9 decimals)
const MAX_ROUNDS: u64 = 1024;
const TOKENS_PER_UNIT: u64 = 1024;
const TOBE_DECIMALS_FACTOR: u64 = 1_000_000_000; // 9 decimals
const LP_LOCK_DURATION: i64 = 2 * 365 * 24 * 60 * 60; // 2 years in seconds

// Pyth SOL/USD feed ID on mainnet (hex without 0x prefix).
// See: https://pyth.network/developers/price-feed-ids
const SOL_USD_FEED_ID_HEX: &str =
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Reject Pyth prices older than this many seconds.
const PYTH_MAX_STALENESS_SECS: u64 = 60;
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

        // 2. Vault SOL reserve → seller (direct lamport mutation; PDA holds SOL).
        let vault_sol = &ctx.accounts.vault_sol_reserve;
        let vault_sol_lamports = vault_sol.lamports();
        require!(vault_sol_lamports >= sol_out, TobeError::VaultSolInsufficient);
        **vault_sol.try_borrow_mut_lamports()? = vault_sol_lamports
            .checked_sub(sol_out)
            .ok_or(TobeError::VaultSolInsufficient)?;
        **ctx.accounts.seller.try_borrow_mut_lamports()? = ctx
            .accounts
            .seller
            .lamports()
            .checked_add(sol_out)
            .ok_or(TobeError::MathOverflow)?;

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
        mint_state.pool_seeded = true;

        msg!("Pool seeded: {} TOBE + {} lamports SOL", round1_vault, sol_balance);
        Ok(())
    }

    pub fn update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
        ctx.accounts.mint_state.treasury = new_treasury;
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
