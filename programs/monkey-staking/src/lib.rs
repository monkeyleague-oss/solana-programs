use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use std::convert::TryInto;

#[cfg(not(feature = "local-testing"))]
declare_id!("MLnE7HFVmVdVTqGQEYWyBPhNQisb7RVUfKdU8cgAzET");
#[cfg(feature = "local-testing")]
declare_id!("tMLq5fBEh9rULZb2ZhWhDRjgzMZXKxi1wRRegWVfkKP");

pub const STAKING_PDA_SEED: &[u8] = b"staking";

#[program]
pub mod monkey_staking {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        staking_account_bump: u8,
        lock_end_date: u64,
        token_mint_key: Pubkey,
    ) -> Result<()> {
        if staking_account_bump != *ctx.bumps.get("staking_account").unwrap() {
            return Err(ErrorCode::IncorrectStakingAccountBump.into());
        }
        let vault_bump = *ctx.bumps.get("token_vault").unwrap();
        let staking_account = StakingAccount {
            vault_bump: vault_bump,
            initializer_key: *ctx.accounts.initializer.key,
            lock_end_date: lock_end_date,
            freeze_program: false,
            total_pool_shares: 0,
            token_mint_key: token_mint_key,
        };

        ctx.accounts.staking_account.set_inner(staking_account);
        return Ok(());
    }

    pub fn update_lock_end_date(
        ctx: Context<UpdateLockEndDate>,
        _staking_account_bump: u8,
        new_lock_end_date: u64,
    ) -> Result<()> {
        ctx.accounts.staking_account.lock_end_date = new_lock_end_date;

        Ok(())
    }

    pub fn update_admin(
        ctx: Context<UpdateAdmin>,
        _staking_account_bump: u8,
        new_admin: Pubkey,
    ) -> Result<()> {
        ctx.accounts.staking_account.initializer_key = new_admin;

        Ok(())
    }

    pub fn toggle_freeze_program(
        ctx: Context<FreezeProgram>,
        _staking_account_bump: u8,
        new_freeze_program: bool,
    ) -> Result<()> {
        ctx.accounts.staking_account.freeze_program = new_freeze_program;

        Ok(())
    }

    pub fn stake(
        ctx: Context<Stake>,
        _staking_account_bump: u8,
        _user_staking_bump: u8,
        amount: u64,
    ) -> Result<()> {
        let total_token = ctx.accounts.token_vault.amount;
        let total_pool_shares = ctx.accounts.staking_account.total_pool_shares;
        let old_price = get_price(&ctx.accounts.token_vault, &ctx.accounts.staking_account);

        //mint x tokens
        if total_token == 0 || total_pool_shares == 0 {
            ctx.accounts.staking_account.total_pool_shares =
                (ctx.accounts.staking_account.total_pool_shares as u128)
                    .checked_add(amount as u128)
                    .unwrap()
                    .try_into()
                    .unwrap();
            ctx.accounts.user_staking_account.pool_shares_amount =
                (ctx.accounts.user_staking_account.pool_shares_amount as u128)
                    .checked_add(amount as u128)
                    .unwrap()
                    .try_into()
                    .unwrap();
        } else {
            let what: u64 = (amount as u128)
                .checked_mul(total_pool_shares as u128)
                .unwrap()
                .checked_div(total_token as u128)
                .unwrap()
                .try_into()
                .unwrap();

            ctx.accounts.staking_account.total_pool_shares =
                (ctx.accounts.staking_account.total_pool_shares as u128)
                    .checked_add(what as u128)
                    .unwrap()
                    .try_into()
                    .unwrap();
            ctx.accounts.user_staking_account.pool_shares_amount =
                (ctx.accounts.user_staking_account.pool_shares_amount as u128)
                    .checked_add(what as u128)
                    .unwrap()
                    .try_into()
                    .unwrap();
        }

        //transfer the users tokens to the vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.token_from.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.token_from_authority.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;

        (&mut ctx.accounts.token_vault).reload()?;

        //plus user staking amount
        ctx.accounts.user_staking_account.amount = (ctx.accounts.user_staking_account.amount
            as u128)
            .checked_add(amount as u128)
            .unwrap()
            .try_into()
            .unwrap();

        let new_price = get_price(&ctx.accounts.token_vault, &ctx.accounts.staking_account);

        emit!(PriceChange {
            old_token_per_pool_share_e9: old_price.0,
            old_token_per_pool_share: old_price.1,
            new_token_per_pool_share_e9: new_price.0,
            new_token_per_pool_share: new_price.1,
        });

        Ok(())
    }

    pub fn unstake(
        ctx: Context<Unstake>,
        _staking_account_bump: u8,
        _user_staking_bump: u8,
        amount: u64,
    ) -> Result<()> {
        let now_ts = Clock::get().unwrap().unix_timestamp;
        let lock_end_date = ctx.accounts.staking_account.lock_end_date;

        if (now_ts as u64) < lock_end_date {
            return Err(ErrorCode::NotExceedLockEndDate.into());
        }

        let total_token = ctx.accounts.token_vault.amount;
        let total_pool_shares = ctx.accounts.staking_account.total_pool_shares;
        let old_price = get_price(&ctx.accounts.token_vault, &ctx.accounts.staking_account);

        //burn what is being sent
        ctx.accounts.staking_account.total_pool_shares =
            (ctx.accounts.staking_account.total_pool_shares as u128)
                .checked_sub(amount as u128)
                .unwrap()
                .try_into()
                .unwrap();
        ctx.accounts.user_staking_account.pool_shares_amount =
            (ctx.accounts.user_staking_account.pool_shares_amount as u128)
                .checked_sub(amount as u128)
                .unwrap()
                .try_into()
                .unwrap();

        //determine user share of vault
        let what: u64 = (amount as u128)
            .checked_mul(total_token as u128)
            .unwrap()
            .checked_div(total_pool_shares as u128)
            .unwrap()
            .try_into()
            .unwrap();

        //compute vault signer seeds
        let token_mint_key = ctx.accounts.token_mint.key();
        let seeds = &[
            token_mint_key.as_ref(),
            &[ctx.accounts.staking_account.vault_bump],
        ];
        let signer = &[&seeds[..]];

        //transfer from vault to user
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.token_to.to_account_info(),
                authority: ctx.accounts.token_vault.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, what)?;

        (&mut ctx.accounts.token_vault).reload()?;

        //determine user staking amount
        let new_total_token = ctx.accounts.token_vault.amount;
        let new_total_pool_shares = ctx.accounts.staking_account.total_pool_shares;

        if new_total_token == 0 || new_total_pool_shares == 0 {
            ctx.accounts.user_staking_account.amount = 0;
        } else {
            let new_what: u64 = (ctx.accounts.user_staking_account.pool_shares_amount as u128)
                .checked_mul(new_total_token as u128)
                .unwrap()
                .checked_div(new_total_pool_shares as u128)
                .unwrap()
                .try_into()
                .unwrap();

            if new_what < ctx.accounts.user_staking_account.amount {
                ctx.accounts.user_staking_account.amount = new_what;
            }
        }

        let new_price = get_price(&ctx.accounts.token_vault, &ctx.accounts.staking_account);

        emit!(PriceChange {
            old_token_per_pool_share_e9: old_price.0,
            old_token_per_pool_share: old_price.1,
            new_token_per_pool_share_e9: new_price.0,
            new_token_per_pool_share: new_price.1,
        });

        Ok(())
    }

    pub fn emit_price(ctx: Context<EmitPrice>) -> Result<()> {
        let price = get_price(&ctx.accounts.token_vault, &ctx.accounts.staking_account);
        emit!(Price {
            token_per_pool_share_e9: price.0,
            token_per_pool_share: price.1,
        });
        Ok(())
    }

    pub fn emit_reward(ctx: Context<EmitReward>) -> Result<()> {
        let total_token = ctx.accounts.token_vault.amount;
        let total_pool_shares = ctx.accounts.staking_account.total_pool_shares;
        let reward: u64 = (ctx.accounts.user_staking_account.pool_shares_amount as u128)
            .checked_mul(total_token as u128)
            .unwrap()
            .checked_div(total_pool_shares as u128)
            .unwrap()
            .checked_sub(ctx.accounts.user_staking_account.amount as u128)
            .unwrap()
            .try_into()
            .unwrap();
        emit!(Reward {
            deposit: ctx.accounts.user_staking_account.amount,
            reward: reward,
        });
        Ok(())
    }
}

const E9: u128 = 1000000000;

pub fn get_price<'info>(
    vault: &Account<'info, TokenAccount>,
    staking: &Account<'info, StakingAccount>,
) -> (u64, String) {
    let total_token = vault.amount;
    let total_pool_shares = staking.total_pool_shares;

    if total_pool_shares == 0 {
        return (0, String::from("0"));
    }

    let price_uint = (total_token as u128)
        .checked_mul(E9 as u128)
        .unwrap()
        .checked_div(total_pool_shares as u128)
        .unwrap()
        .try_into()
        .unwrap();
    let price_float = (total_token as f64) / (total_pool_shares as f64);
    return (price_uint, price_float.to_string());
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8, _lock_end_date: u64, token_mint_key: Pubkey)]
pub struct Initialize<'info> {
    #[account(address = token_mint_key)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = initializer,
        token::mint = token_mint,
        token::authority = token_vault, //the PDA address is both the vault account and the authority (and event the mint authority)
        seeds = [ token_mint_key.as_ref() ],
        bump,
    )]
    ///the not-yet-created, derived token vault pubkey
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        space = 8 + StakingAccount::LEN,
        payer = initializer,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump,
    )]
    pub staking_account: Account<'info, StakingAccount>,

    #[account(mut)]
    ///pays rent on the initializing accounts
    pub initializer: Signer<'info>,

    ///used by anchor for init of the token
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8)]
pub struct UpdateLockEndDate<'info> {
    pub initializer: Signer<'info>,

    #[account(
        mut,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump = staking_account_bump,
        constraint = staking_account.initializer_key == *initializer.key @ ErrorCode::Forbidden,
    )]
    pub staking_account: Account<'info, StakingAccount>,
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8)]
pub struct UpdateAdmin<'info> {
    pub initializer: Signer<'info>,

    #[account(
        mut,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump = staking_account_bump,
        constraint = staking_account.initializer_key == *initializer.key @ ErrorCode::Forbidden,
    )]
    pub staking_account: Account<'info, StakingAccount>,
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8)]
pub struct FreezeProgram<'info> {
    pub initializer: Signer<'info>,

    #[account(
        mut,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump = staking_account_bump,
        constraint = staking_account.initializer_key == *initializer.key @ ErrorCode::Forbidden,
    )]
    pub staking_account: Account<'info, StakingAccount>,
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8, user_staking_bump: u8)]
pub struct Stake<'info> {
    #[account(address = staking_account.token_mint_key)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    //the token account to withdraw from
    pub token_from: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    //the authority allowed to transfer from token_from
    pub token_from_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ token_mint.key().as_ref() ],
        bump = staking_account.vault_bump,
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump = staking_account_bump,
        constraint = !staking_account.freeze_program @ ErrorCode::ProgramIsFrozen,
    )]
    pub staking_account: Account<'info, StakingAccount>,

    #[account(
        init_if_needed,
        space = 8 + UserStakingAccount::LEN,
        payer = token_from_authority,
        seeds = [ token_from_authority.key().as_ref() ],
        bump,
    )]
    pub user_staking_account: Account<'info, UserStakingAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(staking_account_bump: u8, user_staking_bump: u8, amount: u64)]
pub struct Unstake<'info> {
    #[account(address = staking_account.token_mint_key)]
    pub token_mint: Box<Account<'info, Mint>>,

    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump = staking_account_bump,
        constraint = !staking_account.freeze_program @ ErrorCode::ProgramIsFrozen,
    )]
    pub staking_account: Account<'info, StakingAccount>,

    #[account(
        mut,
        seeds = [ token_mint.key().as_ref() ],
        bump = staking_account.vault_bump,
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [ user.key().as_ref() ],
        bump = user_staking_bump,
        constraint = user_staking_account.pool_shares_amount >= amount @ ErrorCode::NotEnoughShares,
    )]
    pub user_staking_account: Account<'info, UserStakingAccount>,

    #[account(mut)]
    //the token account to send token
    pub token_to: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmitPrice<'info> {
    #[account(address = staking_account.token_mint_key)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ token_mint.key().as_ref() ],
        bump = staking_account.vault_bump,
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump,
    )]
    pub staking_account: Account<'info, StakingAccount>,
}

#[derive(Accounts)]
pub struct EmitReward<'info> {
    #[account(address = staking_account.token_mint_key)]
    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ token_mint.key().as_ref() ],
        bump = staking_account.vault_bump,
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [ STAKING_PDA_SEED.as_ref() ],
        bump,
    )]
    pub staking_account: Account<'info, StakingAccount>,

    /// CHECK: EmitReward is read-only, no need to verify Signer
    pub token_from_authority: AccountInfo<'info>,

    #[account(
        seeds = [ token_from_authority.key().as_ref() ],
        bump,
    )]
    pub user_staking_account: Account<'info, UserStakingAccount>,
}

#[account]
#[derive(Default)]
pub struct StakingAccount {
    pub vault_bump: u8,
    pub initializer_key: Pubkey,
    pub lock_end_date: u64,
    pub total_pool_shares: u64,
    pub freeze_program: bool,
    pub token_mint_key: Pubkey,
}

impl StakingAccount {
    pub const LEN: usize =
        1 // vault_bump
        + 32 // initializer_key
        + 8 // lock_end_date
        + 8 // total_x_token
        + 1 // freeze_program
        + 32 // token_mint_key
        ;
}

#[account]
#[derive(Default)]
pub struct UserStakingAccount {
    pub amount: u64,
    pub pool_shares_amount: u64,
}

impl UserStakingAccount {
    pub const LEN: usize = 8 /* amount */ + 8 /* x_token_amount */;
}

#[event]
pub struct PriceChange {
    pub old_token_per_pool_share_e9: u64,
    pub old_token_per_pool_share: String,
    pub new_token_per_pool_share_e9: u64,
    pub new_token_per_pool_share: String,
}

#[event]
pub struct Price {
    pub token_per_pool_share_e9: u64,
    pub token_per_pool_share: String,
}

#[event]
pub struct Reward {
    pub deposit: u64,
    pub reward: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Not exceed lock end date")]
    NotExceedLockEndDate,

    #[msg("Incorrect staking_account_bump")]
    IncorrectStakingAccountBump,

    #[msg("Program is frozen. Check back later")]
    ProgramIsFrozen,

    #[msg("Forbidden")]
    Forbidden,

    #[msg("User account has less shares than requested amount")]
    NotEnoughShares,
}
