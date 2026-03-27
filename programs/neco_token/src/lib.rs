use anchor_lang::prelude::*;
use anchor_spl::token;
use anchor_spl::token::{MintTo, Token, Transfer};
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("CWZGdSh1EGsR95CnkK8AkEgtFX63Z9FurafK7rTFWJ4s");

const MINT_COST: u64 = 1_024_000_000; // $1024 in USDC (6 decimals)
const HALF_MINT_COST: u64 = 512_000_000; // $512 in USDC
const MAX_ROUNDS: u64 = 1024;
const TOKENS_PER_UNIT: u64 = 1024;
const TOBE_DECIMALS_FACTOR: u64 = 1_000_000_000; // 9 decimals
const ONE_DOLLAR: u64 = 1_000_000; // $1 in USDC (6 decimals)
const LP_LOCK_DURATION: i64 = 2 * 365 * 24 * 60 * 60; // 2 years in seconds

#[program]
pub mod neco_token {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey, admin_authority: Pubkey) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.authority = admin_authority;
        mint_state.treasury = treasury;
        mint_state.current_round = 0;
        mint_state.tobe_mint = ctx.accounts.tobe_mint.key();
        mint_state.usdc_mint = ctx.accounts.usdc_mint.key();
        mint_state.vault_balance = 0;
        mint_state.total_vault_released = 0;
        mint_state.pool_seeded = false;
        mint_state.lp_locked = false;
        mint_state.paused = false;
        mint_state.pending_authority = Pubkey::default();
        mint_state.lp_mint = Pubkey::default();
        mint_state.lp_lock_until = 0;
        mint_state.bump = ctx.bumps.mint_authority;
        mint_state.vault_bump = ctx.bumps.vault_authority;
        mint_state.lp_lock_bump = ctx.bumps.lp_lock_authority;
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

        if round == 1 {
            // ── ROUND 1 SPECIAL ──
            // Split USDC: 512 to treasury + 512 to pool reserve
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.minter_usdc.to_account_info(),
                        to: ctx.accounts.treasury_usdc.to_account_info(),
                        authority: ctx.accounts.minter.to_account_info(),
                    },
                ),
                HALF_MINT_COST,
            )?;
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.minter_usdc.to_account_info(),
                        to: ctx.accounts.pool_usdc_reserve.to_account_info(),
                        authority: ctx.accounts.minter.to_account_info(),
                    },
                ),
                HALF_MINT_COST,
            )?;
        } else {
            // ── ROUNDS 2-1024 ──
            // Full 1024 USDC to treasury
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.minter_usdc.to_account_info(),
                        to: ctx.accounts.treasury_usdc.to_account_info(),
                        authority: ctx.accounts.minter.to_account_info(),
                    },
                ),
                MINT_COST,
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

        msg!("Round {}: {} TOBE minted ({} to minter, {} to vault)",
            round, token_units, minter_tokens, vault_tokens);
        Ok(())
    }

    /// Authority calls after Round 1 to release vault tokens + pool USDC
    /// for Raydium pool creation. Can only be called once.
    pub fn seed_pool(ctx: Context<SeedPool>) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(!mint_state.pool_seeded, TobeError::PoolAlreadySeeded);
        require!(mint_state.current_round >= 1, TobeError::NoRoundsCompleted);

        // Round 1 vault tokens = 1024 * 1024 * 10^9 / 2 = 524,288 * 10^9
        let round1_vault = TOKENS_PER_UNIT
            .checked_mul(MAX_ROUNDS)
            .ok_or(TobeError::MathOverflow)?
            .checked_mul(TOBE_DECIMALS_FACTOR)
            .ok_or(TobeError::MathOverflow)?
            / 2;

        let pool_tokens = round1_vault.min(mint_state.vault_balance);

        let vault_seeds = &[b"vault_authority".as_ref(), &[mint_state.vault_bump]];

        // Transfer TOBE from vault to pool destination
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
            pool_tokens,
        )?;

        // Transfer USDC from pool reserve to pool destination
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_usdc_reserve.to_account_info(),
                    to: ctx.accounts.pool_usdc_destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_seeds],
            ),
            HALF_MINT_COST,
        )?;

        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_sub(pool_tokens)
            .ok_or(TobeError::MathOverflow)?;
        mint_state.pool_seeded = true;

        msg!("Pool seeded with {} TOBE + {} USDC", pool_tokens, HALF_MINT_COST);
        Ok(())
    }

    /// Keeper bot calls this when price > $1.
    /// Releases tokens from vault at exactly $1 each.
    /// Buyer pays USDC, receives TOBE from vault. USDC goes to treasury.
    pub fn vault_release(ctx: Context<VaultRelease>, token_amount: u64) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(token_amount > 0, TobeError::InvalidAmount);
        require!(
            token_amount <= mint_state.vault_balance,
            TobeError::InsufficientVault
        );

        // Cost = token_amount / TOBE_DECIMALS_FACTOR * ONE_DOLLAR (sell at $1 each)
        let usdc_cost = (token_amount as u128)
            .checked_mul(ONE_DOLLAR as u128)
            .ok_or(TobeError::MathOverflow)?
            .checked_div(TOBE_DECIMALS_FACTOR as u128)
            .ok_or(TobeError::MathOverflow)? as u64;

        require!(usdc_cost > 0, TobeError::InvalidAmount);

        // Buyer pays USDC to treasury
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    to: ctx.accounts.treasury_usdc.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            usdc_cost,
        )?;

        // Transfer TOBE from vault to buyer
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
            token_amount,
        )?;

        mint_state.vault_balance = mint_state
            .vault_balance
            .checked_sub(token_amount)
            .ok_or(TobeError::MathOverflow)?;
        mint_state.total_vault_released = mint_state
            .total_vault_released
            .checked_add(token_amount)
            .ok_or(TobeError::MathOverflow)?;

        msg!("Vault released {} TOBE for {} USDC", token_amount, usdc_cost);
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

        // Transfer LP tokens from authority to lock vault PDA
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
        mint_state.lp_locked = true;
        mint_state.lp_lock_until = clock.unix_timestamp
            .checked_add(LP_LOCK_DURATION)
            .ok_or(TobeError::MathOverflow)?;

        msg!("LP locked: {} tokens until {}", amount, mint_state.lp_lock_until);
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

        // Transfer all LP tokens from lock vault back to authority
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

    pub usdc_mint: InterfaceAccount<'info, Mint>,

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

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = vault_authority,
        seeds = [b"pool_usdc_reserve"],
        bump
    )]
    pub pool_usdc_reserve: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA LP lock authority (bump stored at init for later use)
    #[account(seeds = [b"lp_lock_authority"], bump)]
    pub lp_lock_authority: UncheckedAccount<'info>,

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

    #[account(mut, seeds = [b"pool_usdc_reserve"], bump)]
    pub pool_usdc_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = minter_usdc.mint == mint_state.usdc_mint,
        constraint = minter_usdc.owner == minter.key()
    )]
    pub minter_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_usdc.mint == mint_state.usdc_mint
    )]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = minter_tobe.mint == tobe_mint.key(),
        constraint = minter_tobe.owner == minter.key()
    )]
    pub minter_tobe: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SeedPool<'info> {
    #[account(
        constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA vault authority
    #[account(seeds = [b"vault_authority"], bump = mint_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, seeds = [b"pool_usdc_reserve"], bump)]
    pub pool_usdc_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination for TOBE tokens (Raydium pool token account)
    #[account(mut)]
    pub pool_tobe_destination: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination for USDC (Raydium pool USDC account)
    #[account(mut)]
    pub pool_usdc_destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VaultRelease<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        constraint = keeper.key() == mint_state.authority @ TobeError::Unauthorized
    )]
    pub keeper: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,

    /// CHECK: PDA vault authority
    #[account(seeds = [b"vault_authority"], bump = mint_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"vault_token"], bump)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_usdc.mint == mint_state.usdc_mint,
        constraint = buyer_usdc.owner == buyer.key()
    )]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_usdc.mint == mint_state.usdc_mint
    )]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_tobe.mint == mint_state.tobe_mint,
        constraint = buyer_tobe.owner == buyer.key()
    )]
    pub buyer_tobe: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,
}

/// Shared struct for pause, unpause, propose_authority
#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(constraint = authority.key() == mint_state.authority @ TobeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"mint_state"], bump)]
    pub mint_state: Account<'info, MintState>,
}

/// Step 2: new authority accepts the transfer
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

    /// The LP token mint (from Raydium pool creation)
    pub lp_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA authority for the LP lock vault
    #[account(seeds = [b"lp_lock_authority"], bump)]
    pub lp_lock_authority: UncheckedAccount<'info>,

    /// PDA vault that holds locked LP tokens
    #[account(
        init_if_needed,
        payer = authority,
        token::mint = lp_mint,
        token::authority = lp_lock_authority,
        seeds = [b"lp_lock_vault"],
        bump
    )]
    pub lp_lock_vault: InterfaceAccount<'info, TokenAccount>,

    /// Authority's LP token account (source)
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

    /// Authority's LP token account (destination)
    #[account(
        mut,
        constraint = authority_lp_account.mint == mint_state.lp_mint,
        constraint = authority_lp_account.owner == authority.key()
    )]
    pub authority_lp_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─── State ───

#[account]
#[derive(InitSpace)]
pub struct MintState {
    pub authority: Pubkey,          // 32
    pub pending_authority: Pubkey,  // 32
    pub treasury: Pubkey,           // 32
    pub tobe_mint: Pubkey,          // 32
    pub usdc_mint: Pubkey,          // 32
    pub lp_mint: Pubkey,            // 32
    pub current_round: u64,         // 8
    pub vault_balance: u64,         // 8
    pub total_vault_released: u64,  // 8
    pub lp_lock_until: i64,         // 8
    pub pool_seeded: bool,          // 1
    pub lp_locked: bool,            // 1
    pub paused: bool,               // 1
    pub bump: u8,                   // 1
    pub vault_bump: u8,             // 1
    pub lp_lock_bump: u8,           // 1
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
    #[msg("Pool has already been seeded")]
    PoolAlreadySeeded,
    #[msg("No rounds completed yet")]
    NoRoundsCompleted,
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
}
