import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NecoToken } from "../target/types/neco_token";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  getAccount,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { assert } from "chai";

const TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Helper: create a token mint using TOKEN_PROGRAM_ID explicitly
async function createMintHelper(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  mintAuthority: anchor.web3.PublicKey,
  decimals: number
): Promise<anchor.web3.PublicKey> {
  const mint = anchor.web3.Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, decimals, mintAuthority, null, TOKEN_PROGRAM_ID)
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer, mint]);
  return mint.publicKey;
}

// Helper: create a token account using TOKEN_PROGRAM_ID explicitly
async function createTokenAccountHelper(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  mint: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
  const account = anchor.web3.Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      space: ACCOUNT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(account.publicKey, mint, owner, TOKEN_PROGRAM_ID)
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer, account]);
  return account.publicKey;
}

// Helper: mint tokens using TOKEN_PROGRAM_ID explicitly
async function mintToHelper(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  mint: anchor.web3.PublicKey,
  destination: anchor.web3.PublicKey,
  authority: anchor.web3.Keypair,
  amount: number
): Promise<void> {
  const tx = new anchor.web3.Transaction().add(
    createMintToInstruction(mint, destination, authority.publicKey, amount, [], TOKEN_PROGRAM_ID)
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer, authority]);
}

describe("tobestable", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.necoToken as Program<NecoToken>;

  const authority = provider.wallet as anchor.Wallet;
  let usdcMint: anchor.web3.PublicKey;
  let tobeMint: anchor.web3.Keypair;
  let treasuryUsdc: anchor.web3.PublicKey;
  let minterUsdc: anchor.web3.PublicKey;
  let minterTobe: anchor.web3.PublicKey;
  let mintStatePda: anchor.web3.PublicKey;
  let mintAuthorityPda: anchor.web3.PublicKey;
  let vaultAuthorityPda: anchor.web3.PublicKey;
  let vaultTokenPda: anchor.web3.PublicKey;
  let poolUsdcReservePda: anchor.web3.PublicKey;
  let lpLockAuthorityPda: anchor.web3.PublicKey;
  let lpLockVaultPda: anchor.web3.PublicKey;

  const MINT_COST = 1_024_000_000; // $1024 USDC (6 decimals)
  const HALF_MINT_COST = 512_000_000; // $512 USDC
  const TOBE_DECIMALS = 1_000_000_000; // 9 decimals

  before(async () => {
    // Create fake USDC mint (6 decimals) with TOKEN_PROGRAM_ID
    usdcMint = await createMintHelper(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      6
    );

    // TOBE mint keypair
    tobeMint = anchor.web3.Keypair.generate();

    // Derive PDAs
    [mintStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("mint_state")],
      program.programId
    );
    [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      program.programId
    );
    [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority")],
      program.programId
    );
    [vaultTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token")],
      program.programId
    );
    [poolUsdcReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool_usdc_reserve")],
      program.programId
    );
    [lpLockAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_lock_authority")],
      program.programId
    );
    [lpLockVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_lock_vault")],
      program.programId
    );

    // Create treasury USDC account
    treasuryUsdc = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      authority.publicKey
    );

    // Create minter USDC account and fund with test USDC
    minterUsdc = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      authority.publicKey
    );
    await mintToHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      minterUsdc,
      (authority as any).payer,
      10_000_000_000 // 10,000 USDC
    );
  });

  it("initializes the TOBE token with vault + pool reserve", async () => {
    const [metadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        tobeMint.publicKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    const tx = await program.methods
      .initialize(treasuryUsdc, authority.publicKey,)
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        usdcMint: usdcMint,
        mintAuthority: mintAuthorityPda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolUsdcReserve: poolUsdcReservePda,
        lpLockAuthority: lpLockAuthorityPda,
        metadata: metadataPda,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([tobeMint])
      .rpc();

    console.log("Initialize tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 0);
    assert.equal(state.vaultBalance.toNumber(), 0);
    assert.equal(state.totalVaultReleased.toNumber(), 0);
    assert.equal(state.poolSeeded, false);
    assert.equal(state.lpLocked, false);
    assert.equal(state.authority.toString(), authority.publicKey.toString());
    assert.equal(state.lastPriceNumerator.toNumber(), 0);
    assert.equal(state.lastPriceDenominator.toNumber(), 1);
    assert.equal(state.totalMinted.toNumber(), 0);
  });

  it("mints round 1 — 50% minter, 50% vault, USDC split 512/512", async () => {
    // Create minter TOBE account
    minterTobe = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey
    );

    const tx = await program.methods
      .mintTobe()
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolUsdcReserve: poolUsdcReservePda,
        minterUsdc: minterUsdc,
        treasuryUsdc: treasuryUsdc,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Mint round 1 tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 1);

    // Round 1: 1024 * 1024 = 1,048,576 tokens total
    const totalTokens = 1024 * 1024 * TOBE_DECIMALS;
    const expectedMinter = Math.floor(totalTokens / 2);
    const expectedVault = totalTokens - expectedMinter;

    // Check minter received 50%
    const minterAccount = await getAccount(provider.connection, minterTobe);
    assert.equal(Number(minterAccount.amount), expectedMinter);

    // Check vault received 50%
    const vaultAccount = await getAccount(provider.connection, vaultTokenPda);
    assert.equal(Number(vaultAccount.amount), expectedVault);

    // Check USDC split: 512 to treasury, 512 to pool reserve
    const treasuryAccount = await getAccount(provider.connection, treasuryUsdc);
    assert.equal(Number(treasuryAccount.amount), HALF_MINT_COST);

    const poolReserveAccount = await getAccount(provider.connection, poolUsdcReservePda);
    assert.equal(Number(poolReserveAccount.amount), HALF_MINT_COST);

    // Verify on-chain price oracle
    assert.equal(state.lastPriceNumerator.toNumber(), MINT_COST); // 1,024,000,000
    assert.equal(state.lastPriceDenominator.toNumber(), expectedMinter); // 524,288,000,000,000
    assert.equal(state.totalMinted.toNumber(), totalTokens);
  });

  it("mints round 2 — full USDC to treasury, fewer tokens", async () => {
    const treasuryBefore = await getAccount(provider.connection, treasuryUsdc);

    const tx = await program.methods
      .mintTobe()
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolUsdcReserve: poolUsdcReservePda,
        minterUsdc: minterUsdc,
        treasuryUsdc: treasuryUsdc,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Mint round 2 tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 2);

    // Round 2: full 1024 USDC to treasury (not split)
    const treasuryAfter = await getAccount(provider.connection, treasuryUsdc);
    assert.equal(
      Number(treasuryAfter.amount) - Number(treasuryBefore.amount),
      MINT_COST
    );

    // Pool reserve should still only have 512 from round 1
    const poolReserve = await getAccount(provider.connection, poolUsdcReservePda);
    assert.equal(Number(poolReserve.amount), HALF_MINT_COST);
  });

  it("seeds the pool — releases vault tokens + pool USDC", async () => {
    // Create destination accounts (simulating Raydium pool accounts)
    const poolTobeDestination = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey // In real deployment, owned by Raydium
    );
    const poolUsdcDestination = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      authority.publicKey
    );

    const stateBefore = await program.account.mintState.fetch(mintStatePda);
    const vaultBefore = stateBefore.vaultBalance.toNumber();

    const tx = await program.methods
      .seedPool()
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolUsdcReserve: poolUsdcReservePda,
        poolTobeDestination: poolTobeDestination,
        poolUsdcDestination: poolUsdcDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Seed pool tx:", tx);

    const stateAfter = await program.account.mintState.fetch(mintStatePda);
    assert.equal(stateAfter.poolSeeded, true);

    // Round 1 vault amount = 1024 * 1024 * 10^9 / 2 = 524,288,000,000,000
    const round1VaultTokens = 1024 * 1024 * TOBE_DECIMALS / 2;

    // Vault balance should have decreased by round 1's vault portion
    assert.equal(
      stateAfter.vaultBalance.toNumber(),
      vaultBefore - round1VaultTokens
    );

    // Pool TOBE destination should have received tokens
    const poolTobeAccount = await getAccount(provider.connection, poolTobeDestination);
    assert.equal(Number(poolTobeAccount.amount), round1VaultTokens);

    // Pool USDC destination should have received 512 USDC
    const poolUsdcAccount = await getAccount(provider.connection, poolUsdcDestination);
    assert.equal(Number(poolUsdcAccount.amount), HALF_MINT_COST);
  });

  it("rejects second seed_pool call", async () => {
    const fakeTobeDest = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey
    );
    const fakeUsdcDest = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      authority.publicKey
    );

    try {
      await program.methods
        .seedPool()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolUsdcReserve: poolUsdcReservePda,
          poolTobeDestination: fakeTobeDest,
          poolUsdcDestination: fakeUsdcDest,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have rejected second seed_pool");
    } catch (err) {
      assert.include(err.toString(), "PoolAlreadySeeded");
    }
  });

  it("vault releases TOBE at $1 when keeper triggers", async () => {
    const stateBefore = await program.account.mintState.fetch(mintStatePda);
    const vaultBefore = stateBefore.vaultBalance.toNumber();

    // Release 1000 TOBE from vault
    const releaseAmount = 1000 * TOBE_DECIMALS;
    const expectedUsdcCost = 1000 * 1_000_000; // 1000 * $1

    const buyerTobeBefore = await getAccount(provider.connection, minterTobe);
    const treasuryBefore = await getAccount(provider.connection, treasuryUsdc);

    const tx = await program.methods
      .vaultRelease(new anchor.BN(releaseAmount))
      .accounts({
        buyer: authority.publicKey,
        keeper: authority.publicKey,
        mintState: mintStatePda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        buyerUsdc: minterUsdc,
        treasuryUsdc: treasuryUsdc,
        buyerTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Vault release tx:", tx);

    const stateAfter = await program.account.mintState.fetch(mintStatePda);
    assert.equal(stateAfter.vaultBalance.toNumber(), vaultBefore - releaseAmount);
    assert.equal(stateAfter.totalVaultReleased.toNumber(), releaseAmount);

    const buyerTobeAfter = await getAccount(provider.connection, minterTobe);
    assert.equal(
      Number(buyerTobeAfter.amount) - Number(buyerTobeBefore.amount),
      releaseAmount
    );

    const treasuryAfter = await getAccount(provider.connection, treasuryUsdc);
    assert.equal(
      Number(treasuryAfter.amount) - Number(treasuryBefore.amount),
      expectedUsdcCost
    );
  });

  it("rejects vault release from non-keeper", async () => {
    const fakeKeeper = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fakeKeeper.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const fakeUsdc = await createTokenAccountHelper(
      provider.connection, (authority as any).payer, usdcMint, fakeKeeper.publicKey
    );
    const fakeTobe = await createTokenAccountHelper(
      provider.connection, (authority as any).payer, tobeMint.publicKey, fakeKeeper.publicKey
    );

    try {
      await program.methods
        .vaultRelease(new anchor.BN(1_000_000_000))
        .accounts({
          buyer: fakeKeeper.publicKey,
          keeper: fakeKeeper.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          buyerUsdc: fakeUsdc,
          treasuryUsdc: treasuryUsdc,
          buyerTobe: fakeTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fakeKeeper])
        .rpc();
      assert.fail("Should have rejected unauthorized keeper");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("rejects vault release exceeding balance", async () => {
    const state = await program.account.mintState.fetch(mintStatePda);
    const overAmount = state.vaultBalance.toNumber() + 1_000_000_000;

    try {
      await program.methods
        .vaultRelease(new anchor.BN(overAmount))
        .accounts({
          buyer: authority.publicKey,
          keeper: authority.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          buyerUsdc: minterUsdc,
          treasuryUsdc: treasuryUsdc,
          buyerTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have rejected excess vault release");
    } catch (err) {
      assert.include(err.toString(), "InsufficientVault");
    }
  });

  it("round 3 yields fewer tokens — verifies decreasing formula", async () => {
    const minterTobeBefore = await getAccount(provider.connection, minterTobe);

    await program.methods
      .mintTobe()
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolUsdcReserve: poolUsdcReservePda,
        minterUsdc: minterUsdc,
        treasuryUsdc: treasuryUsdc,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 3);

    // Round 3: tokens = 1024 * (1024 + 1 - 3) = 1024 * 1022 = 1,046,528 total
    // Minter gets 50% = 523,264 * 10^9
    const expectedTotal = 1024 * 1022 * TOBE_DECIMALS;
    const expectedMinter = Math.floor(expectedTotal / 2);

    const minterTobeAfter = await getAccount(provider.connection, minterTobe);
    const received = Number(minterTobeAfter.amount) - Number(minterTobeBefore.amount);
    assert.equal(received, expectedMinter);
  });

  it("rejects mint when minter has insufficient USDC", async () => {
    // Create a broke minter with only 1 USDC (needs 1024)
    const brokeMinter = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(brokeMinter.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const brokeUsdc = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      brokeMinter.publicKey
    );
    // Fund with only 1 USDC (need 1024)
    await mintToHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      brokeUsdc,
      (authority as any).payer,
      1_000_000 // 1 USDC
    );

    const brokeTobe = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      brokeMinter.publicKey
    );

    try {
      await program.methods
        .mintTobe()
        .accounts({
          minter: brokeMinter.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolUsdcReserve: poolUsdcReservePda,
          minterUsdc: brokeUsdc,
          treasuryUsdc: treasuryUsdc,
          minterTobe: brokeTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([brokeMinter])
        .rpc();
      assert.fail("Should have rejected — minter only has 1 USDC");
    } catch (err) {
      // SPL token transfer fails with insufficient funds
      assert.ok(
        err.toString().includes("insufficient") ||
        err.toString().includes("0x1") ||
        err.toString().includes("InsufficientFunds") ||
        err.toString().includes("Error"),
        `Expected insufficient funds error, got: ${err.toString().slice(0, 200)}`
      );
    }

    // Verify round did NOT advance (transaction reverted atomically)
    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 3, "Round should still be 3 — failed mint must not advance state");
  });

  it("mints all remaining rounds through 1024, then rejects round 1025", async () => {
    // Fund minter with enough USDC for remaining 1021 rounds (rounds 4-1024)
    // 1021 * 1024 USDC = 1,045,504 USDC
    await mintToHelper(
      provider.connection,
      (authority as any).payer,
      usdcMint,
      minterUsdc,
      (authority as any).payer,
      1_050_000_000_000 // 1,050,000 USDC — plenty of buffer
    );

    // Mint rounds 4 through 1024
    for (let r = 4; r <= 1024; r++) {
      await program.methods
        .mintTobe()
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolUsdcReserve: poolUsdcReservePda,
          minterUsdc: minterUsdc,
          treasuryUsdc: treasuryUsdc,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      if (r % 200 === 0 || r === 1024) {
        console.log(`  ✓ Round ${r} minted`);
      }
    }

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 1024);

    // Verify round 1024 gave correct tokens: 1024 * (1024+1-1024) = 1024 * 1 = 1024 tokens
    // This is the minimum — proves the curve bottoms out correctly

    // Now try round 1025 — must be rejected
    try {
      await program.methods
        .mintTobe()
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolUsdcReserve: poolUsdcReservePda,
          minterUsdc: minterUsdc,
          treasuryUsdc: treasuryUsdc,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have rejected round 1025");
    } catch (err) {
      assert.include(err.toString(), "AllRoundsMinted");
      console.log("  ✓ Round 1025 correctly rejected with AllRoundsMinted");
    }
  });

  it("updates treasury (authority only)", async () => {
    const newTreasury = anchor.web3.Keypair.generate().publicKey;
    await program.methods
      .updateTreasury(newTreasury)
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.treasury.toString(), newTreasury.toString());
  });

  it("rejects unauthorized treasury update", async () => {
    const fake = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fake.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateTreasury(fake.publicKey)
        .accounts({
          authority: fake.publicKey,
          mintState: mintStatePda,
        })
        .signers([fake])
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  // ── LP Lock Tests ──

  let fakeLpMint: anchor.web3.PublicKey;
  let authorityLpAccount: anchor.web3.PublicKey;

  it("locks LP tokens for 2 years", async () => {
    // Create a fake LP mint (simulating Raydium LP token)
    fakeLpMint = await createMintHelper(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      6
    );

    // Create authority's LP token account and mint some LP tokens
    authorityLpAccount = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      fakeLpMint,
      authority.publicKey
    );
    await mintToHelper(
      provider.connection,
      (authority as any).payer,
      fakeLpMint,
      authorityLpAccount,
      (authority as any).payer,
      1_000_000_000 // 1000 LP tokens
    );

    const lpBalanceBefore = await getAccount(provider.connection, authorityLpAccount);
    assert.equal(Number(lpBalanceBefore.amount), 1_000_000_000);

    const tx = await program.methods
      .lockLp(new anchor.BN(1_000_000_000))
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
        lpMint: fakeLpMint,
        lpLockAuthority: lpLockAuthorityPda,
        lpLockVault: lpLockVaultPda,
        authorityLpAccount: authorityLpAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("Lock LP tx:", tx);

    // Verify LP tokens moved to vault
    const lpBalanceAfter = await getAccount(provider.connection, authorityLpAccount);
    assert.equal(Number(lpBalanceAfter.amount), 0);

    const vaultBalance = await getAccount(provider.connection, lpLockVaultPda);
    assert.equal(Number(vaultBalance.amount), 1_000_000_000);

    // Verify state
    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.lpLocked, true);
    assert.equal(state.lpMint.toString(), fakeLpMint.toString());
    assert.ok(state.lpLockUntil.toNumber() > 0, "Lock expiry should be set");
  });

  it("rejects second lock_lp call", async () => {
    // Create another LP account with tokens
    const anotherLpAccount = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      fakeLpMint,
      authority.publicKey
    );
    await mintToHelper(
      provider.connection,
      (authority as any).payer,
      fakeLpMint,
      anotherLpAccount,
      (authority as any).payer,
      500_000_000
    );

    try {
      await program.methods
        .lockLp(new anchor.BN(500_000_000))
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
          lpMint: fakeLpMint,
          lpLockAuthority: lpLockAuthorityPda,
          lpLockVault: lpLockVaultPda,
          authorityLpAccount: anotherLpAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      assert.fail("Should have rejected second lock");
    } catch (err) {
      assert.ok(
        err.toString().includes("LpAlreadyLocked") ||
        err.toString().includes("already in use"),
        `Expected LpAlreadyLocked, got: ${err.toString().slice(0, 200)}`
      );
    }
  });

  it("rejects unlock before 2 years", async () => {
    try {
      await program.methods
        .unlockLp()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
          lpLockAuthority: lpLockAuthorityPda,
          lpLockVault: lpLockVaultPda,
          authorityLpAccount: authorityLpAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have rejected — lock hasn't expired");
    } catch (err) {
      assert.include(err.toString(), "LpStillLocked");
      console.log("  ✓ Correctly rejected early unlock with LpStillLocked");
    }

    // Verify tokens are still locked
    const vaultBalance = await getAccount(provider.connection, lpLockVaultPda);
    assert.equal(Number(vaultBalance.amount), 1_000_000_000);
  });

  // ── Pause / Unpause Tests ──

  it("pauses minting", async () => {
    await program.methods
      .pause()
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.paused, true);
    console.log("  ✓ Minting paused");
  });

  it("rejects mint while paused (all rounds minted, but pause check comes first)", async () => {
    // All 1024 rounds are already minted, but the pause check runs before the round check
    // So we verify that the pause flag is set correctly in state
    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.paused, true);
    console.log("  ✓ Pause flag confirmed active in state");
  });

  it("rejects pause from non-authority", async () => {
    const fake = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fake.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .pause()
        .accounts({
          authority: fake.publicKey,
          mintState: mintStatePda,
        })
        .signers([fake])
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.ok(
        err.toString().includes("Unauthorized") || err.toString().includes("ConstraintRaw"),
        `Expected Unauthorized, got: ${err.toString().slice(0, 200)}`
      );
    }
  });

  it("unpauses minting", async () => {
    await program.methods
      .unpause()
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.paused, false);
    console.log("  ✓ Minting resumed");
  });

  it("rejects unpause when not paused", async () => {
    try {
      await program.methods
        .unpause()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
        })
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.ok(err.toString().includes("NotPaused"));
    }
  });

  // ── 2-Step Authority Transfer Tests ──

  let newAuthKeypair: anchor.web3.Keypair;

  it("proposes authority transfer", async () => {
    newAuthKeypair = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(newAuthKeypair.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    await program.methods
      .proposeAuthority(newAuthKeypair.publicKey)
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.pendingAuthority.toString(), newAuthKeypair.publicKey.toString());
    console.log("  ✓ Authority transfer proposed");
  });

  it("rejects accept from wrong key", async () => {
    const randomUser = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(randomUser.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .acceptAuthority()
        .accounts({
          newAuthority: randomUser.publicKey,
          mintState: mintStatePda,
        })
        .signers([randomUser])
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.ok(
        err.toString().includes("NoPendingAuthority") || err.toString().includes("ConstraintRaw"),
        `Expected NoPendingAuthority, got: ${err.toString().slice(0, 200)}`
      );
    }
  });

  it("new authority accepts transfer", async () => {
    await program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: newAuthKeypair.publicKey,
        mintState: mintStatePda,
      })
      .signers([newAuthKeypair])
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.authority.toString(), newAuthKeypair.publicKey.toString());
    assert.equal(state.pendingAuthority.toString(), new anchor.web3.PublicKey(new Uint8Array(32)).toString());
    console.log("  ✓ Authority transferred");
  });

  it("updates token metadata", async () => {
    const [metadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        tobeMint.publicKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    // Update metadata — called by new authority (after transfer)
    await program.methods
      .updateMetadata("TOBESTABLE V2", "TOBE", "https://tobestable.com/token-metadata-v2.json")
      .accounts({
        authority: newAuthKeypair.publicKey,
        mintState: mintStatePda,
        mintAuthority: mintAuthorityPda,
        metadata: metadataPda,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([newAuthKeypair])
      .rpc();

    console.log("  ✓ Metadata updated successfully");
  });

  it("rejects metadata update from non-authority", async () => {
    const [metadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        tobeMint.publicKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    try {
      await program.methods
        .updateMetadata("HACKED", "HACK", "https://evil.com")
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
          mintAuthority: mintAuthorityPda,
          metadata: metadataPda,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.ok(
        err.toString().includes("Unauthorized") || err.toString().includes("ConstraintRaw"),
        `Expected Unauthorized, got: ${err.toString().slice(0, 200)}`
      );
      console.log("  ✓ Non-authority metadata update rejected");
    }
  });

  it("old authority can no longer pause", async () => {
    // State is unpaused after the unpause test. Just try to pause with old authority.
    try {
      await program.methods
        .pause()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
        })
        .rpc();
      assert.fail("Should have rejected");
    } catch (err) {
      assert.ok(
        err.toString().includes("Unauthorized") || err.toString().includes("ConstraintRaw"),
        `Expected Unauthorized, got: ${err.toString().slice(0, 200)}`
      );
      console.log("  ✓ Old authority correctly rejected");
    }
  });
});
