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

// Metaplex Token Metadata Program: metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
pub static MPL_TOKEN_METADATA_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

declare_id!("DnMvWs2dDim57TLBcJp7FKkDUFw2KnLmJybzpbTZuc65");

const MINT_COST: u64 = 10_000_000_000; // 10 SOL in lamports (9 decimals)
const MAX_ROUNDS: u64 = 1024;
const TOKENS_PER_UNIT: u64 = 1024;
const TOBE_DECIMALS_FACTOR: u64 = 1_000_000_000; // 9 decimals
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

        // Round 1: split 50/50 between treasury and pool SOL reserve
        // All other rounds: full 10 SOL to treasury
        if round == 1 {
            let half_cost = MINT_COST / 2;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.minter.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                half_cost,
            )?;
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
        } else {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.minter.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
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
        mint_state.total_minted = mint_state
            .total_minted
            .checked_add(total_tokens)
            .ok_or(TobeError::MathOverflow)?;

        msg!("Round {}: {} TOBE minted ({} to minter, {} to vault)",
            round, token_units, minter_tokens, vault_tokens);
        Ok(())
    }

    /// Keeper bot calls this when price > peg.
    /// Buyer pays SOL, receives TOBE from vault. SOL goes to treasury.
    /// Keeper (authority) specifies token_amount and the SOL cost (sol_lamports).
    pub fn vault_release(ctx: Context<VaultRelease>, token_amount: u64, sol_lamports: u64) -> Result<()> {
        let mint_state = &mut ctx.accounts.mint_state;

        require!(token_amount > 0, TobeError::InvalidAmount);
        require!(sol_lamports > 0, TobeError::InvalidAmount);
        require!(
            token_amount <= mint_state.vault_balance,
            TobeError::InsufficientVault
        );

        // Buyer pays SOL to treasury
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            sol_lamports,
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

        msg!("Vault released {} TOBE for {} lamports SOL", token_amount, sol_lamports);
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

    /// Treasury wallet that receives 10 SOL
    #[account(
        mut,
        constraint = treasury.key() == mint_state.treasury @ TobeError::Unauthorized
    )]
    pub treasury: SystemAccount<'info>,

    /// CHECK: PDA for pool SOL reserve (receives 50% on round 1)
    #[account(mut, seeds = [b"pool_sol_reserve"], bump)]
    pub pool_sol_reserve: UncheckedAccount<'info>,

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

    /// Treasury wallet that receives SOL from buyer
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
}
