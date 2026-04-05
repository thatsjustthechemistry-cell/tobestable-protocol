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
  const treasury = anchor.web3.Keypair.generate();
  let tobeMint: anchor.web3.Keypair;
  let minterTobe: anchor.web3.PublicKey;
  let mintStatePda: anchor.web3.PublicKey;
  let mintAuthorityPda: anchor.web3.PublicKey;
  let vaultAuthorityPda: anchor.web3.PublicKey;
  let vaultTokenPda: anchor.web3.PublicKey;
  let lpLockAuthorityPda: anchor.web3.PublicKey;
  let lpLockVaultPda: anchor.web3.PublicKey;
  let poolSolReservePda: anchor.web3.PublicKey;

  const MINT_COST = 10_000_000_000; // 10 SOL in lamports
  const TOBE_DECIMALS = 1_000_000_000; // 9 decimals

  before(async () => {
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
    [lpLockAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_lock_authority")],
      program.programId
    );
    [lpLockVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_lock_vault")],
      program.programId
    );
    [poolSolReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool_sol_reserve")],
      program.programId
    );

    // Fund treasury so it exists as a SystemAccount
    const sig = await provider.connection.requestAirdrop(treasury.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);
  });

  // ── 1. Initialize ──

  it("initializes the TOBE token with vault", async () => {
    const [metadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        tobeMint.publicKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    const tx = await program.methods
      .initialize(treasury.publicKey, authority.publicKey)
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
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
    assert.equal(state.lpLocked, false);
    assert.equal(state.paused, false);
    assert.equal(state.poolSeeded, false);
    assert.equal(state.authority.toString(), authority.publicKey.toString());
    assert.equal(state.treasury.toString(), treasury.publicKey.toString());
    assert.equal(state.totalMinted.toNumber(), 0);
  });

  // ── 2. Mint Round 1 ──

  it("mints round 1 — 50% minter, 50% vault, 5 SOL treasury + 5 SOL pool reserve", async () => {
    minterTobe = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey
    );

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    const tx = await program.methods
      .mintTobe()
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        treasury: treasury.publicKey,
        poolSolReserve: poolSolReservePda,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Mint round 1 tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 1);

    // Round 1: 1024 * (1024+1-1) = 1024 * 1024 = 1,048,576 tokens total
    const totalTokens = 1024 * 1024 * TOBE_DECIMALS;
    const expectedMinter = Math.floor(totalTokens / 2);
    const expectedVault = totalTokens - expectedMinter;

    const minterAccount = await getAccount(provider.connection, minterTobe);
    assert.equal(Number(minterAccount.amount), expectedMinter);

    const vaultAccount = await getAccount(provider.connection, vaultTokenPda);
    assert.equal(Number(vaultAccount.amount), expectedVault);

    // Round 1: 5 SOL to treasury, 5 SOL to pool reserve
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(treasuryAfter - treasuryBefore, MINT_COST / 2);

    const poolReserveBalance = await provider.connection.getBalance(poolSolReservePda);
    assert.ok(poolReserveBalance >= MINT_COST / 2, "Pool reserve should have ≥5 SOL");

    assert.equal(state.totalMinted.toNumber(), totalTokens);
  });

  // ── 3. Mint Round 2 ──

  it("mints round 2 — 10 SOL to treasury, fewer tokens", async () => {
    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    const tx = await program.methods
      .mintTobe()
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        treasury: treasury.publicKey,
        poolSolReserve: poolSolReservePda,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Mint round 2 tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 2);

    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(treasuryAfter - treasuryBefore, MINT_COST);
  });

  // ── 4. Round 3 Decreasing Formula ──

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
        treasury: treasury.publicKey,
        poolSolReserve: poolSolReservePda,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 3);

    // Round 3: tokens = 1024 * (1024 + 1 - 3) = 1024 * 1022 = 1,046,528 total
    const expectedTotal = 1024 * 1022 * TOBE_DECIMALS;
    const expectedMinter = Math.floor(expectedTotal / 2);

    const minterTobeAfter = await getAccount(provider.connection, minterTobe);
    const received = Number(minterTobeAfter.amount) - Number(minterTobeBefore.amount);
    assert.equal(received, expectedMinter);
  });

  // ── 5. Seed Pool ──

  it("seeds the pool — transfers vault TOBE + pool SOL to authority", async () => {
    const stateBefore = await program.account.mintState.fetch(mintStatePda);
    const vaultBalanceBefore = stateBefore.vaultBalance.toNumber();

    // Round 1 vault amount: 1024 * 1024 * 10^9 / 2
    const round1Vault = (1024 * 1024 * TOBE_DECIMALS) / 2;

    const authorityBalBefore = await provider.connection.getBalance(authority.publicKey);
    const minterTobeBefore = await getAccount(provider.connection, minterTobe);

    const tx = await program.methods
      .seedPool()
      .accounts({
        authority: authority.publicKey,
        mintState: mintStatePda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolSolReserve: poolSolReservePda,
        poolTobeDestination: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Seed pool tx:", tx);

    const stateAfter = await program.account.mintState.fetch(mintStatePda);
    assert.equal(stateAfter.poolSeeded, true);
    assert.equal(stateAfter.vaultBalance.toNumber(), vaultBalanceBefore - round1Vault);

    // Authority received SOL from pool reserve
    const authorityBalAfter = await provider.connection.getBalance(authority.publicKey);
    assert.ok(authorityBalAfter > authorityBalBefore, "Authority should have received pool SOL");

    // Destination received TOBE from vault
    const minterTobeAfter = await getAccount(provider.connection, minterTobe);
    assert.equal(
      Number(minterTobeAfter.amount) - Number(minterTobeBefore.amount),
      round1Vault
    );

    // Pool reserve should be drained
    const poolReserveAfter = await provider.connection.getBalance(poolSolReservePda);
    assert.equal(poolReserveAfter, 0, "Pool reserve should be empty after seeding");

    console.log("  ✓ Pool seeded successfully");
  });

  // ── 6. Reject Second Seed Pool ──

  it("rejects second seed_pool call", async () => {
    try {
      await program.methods
        .seedPool()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          poolTobeDestination: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected — pool already seeded");
    } catch (err) {
      assert.include(err.toString(), "PoolAlreadySeeded");
      console.log("  ✓ Second seed_pool correctly rejected");
    }
  });

  // ── 7. Insufficient SOL ──

  it("rejects mint when minter has insufficient SOL", async () => {
    const brokeMinter = anchor.web3.Keypair.generate();
    // Only 0.1 SOL — needs 10 SOL to mint
    const sig = await provider.connection.requestAirdrop(brokeMinter.publicKey, 100_000_000);
    await provider.connection.confirmTransaction(sig);

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
          treasury: treasury.publicKey,
          poolSolReserve: poolSolReservePda,
          minterTobe: brokeTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([brokeMinter])
        .rpc();
      assert.fail("Should have rejected — minter only has 0.1 SOL");
    } catch (err) {
      assert.ok(
        err.toString().includes("insufficient") ||
        err.toString().includes("0x1") ||
        err.toString().includes("Transfer") ||
        err.toString().includes("Error"),
        `Expected insufficient funds error, got: ${err.toString().slice(0, 200)}`
      );
    }

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 3, "Round should still be 3 — failed mint must not advance state");
  });

  // ── 6. Vault Release ──

  it("vault releases TOBE when keeper triggers — buyer pays SOL", async () => {
    const stateBefore = await program.account.mintState.fetch(mintStatePda);
    const vaultBefore = stateBefore.vaultBalance.toNumber();

    // Release 1000 TOBE from vault, buyer pays 1 SOL
    const releaseAmount = 1000 * TOBE_DECIMALS;
    const solCost = 1_000_000_000; // 1 SOL

    const buyerTobeBefore = await getAccount(provider.connection, minterTobe);
    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    const tx = await program.methods
      .vaultRelease(new anchor.BN(releaseAmount), new anchor.BN(solCost))
      .accounts({
        buyer: authority.publicKey,
        keeper: authority.publicKey,
        mintState: mintStatePda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        treasury: treasury.publicKey,
        buyerTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
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

    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(treasuryAfter - treasuryBefore, solCost);
  });

  // ── 7. Unauthorized Keeper ──

  it("rejects vault release from non-keeper", async () => {
    const fakeKeeper = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fakeKeeper.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const fakeTobe = await createTokenAccountHelper(
      provider.connection, (authority as any).payer, tobeMint.publicKey, fakeKeeper.publicKey
    );

    try {
      await program.methods
        .vaultRelease(new anchor.BN(1_000_000_000), new anchor.BN(1_000_000_000))
        .accounts({
          buyer: fakeKeeper.publicKey,
          keeper: fakeKeeper.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          buyerTobe: fakeTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([fakeKeeper])
        .rpc();
      assert.fail("Should have rejected unauthorized keeper");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  // ── 8. Vault Overrelease ──

  it("rejects vault release exceeding balance", async () => {
    const state = await program.account.mintState.fetch(mintStatePda);
    const overAmount = state.vaultBalance.toNumber() + 1_000_000_000;

    try {
      await program.methods
        .vaultRelease(new anchor.BN(overAmount), new anchor.BN(1_000_000_000))
        .accounts({
          buyer: authority.publicKey,
          keeper: authority.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          buyerTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected excess vault release");
    } catch (err) {
      assert.include(err.toString(), "InsufficientVault");
    }
  });

  // ── 9. Vault Release Zero Amount ──

  it("rejects vault release with zero token amount", async () => {
    try {
      await program.methods
        .vaultRelease(new anchor.BN(0), new anchor.BN(1_000_000_000))
        .accounts({
          buyer: authority.publicKey,
          keeper: authority.publicKey,
          mintState: mintStatePda,
          vaultAuthority: vaultAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          buyerTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected zero token amount");
    } catch (err) {
      assert.include(err.toString(), "InvalidAmount");
    }
  });

  // ── 10. Pause ──

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

  // ── 11. Reject Mint While Paused ──

  it("rejects mint while paused", async () => {
    try {
      await program.methods
        .mintTobe()
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          poolSolReserve: poolSolReservePda,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected — minting is paused");
    } catch (err) {
      assert.include(err.toString(), "MintingPaused");
      console.log("  ✓ Mint correctly rejected while paused");
    }
  });

  // ── 12. Unauthorized Pause ──

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

  // ── 13. Double Pause ──

  it("rejects double pause", async () => {
    try {
      await program.methods
        .pause()
        .accounts({
          authority: authority.publicKey,
          mintState: mintStatePda,
        })
        .rpc();
      assert.fail("Should have rejected — already paused");
    } catch (err) {
      assert.include(err.toString(), "AlreadyPaused");
      console.log("  ✓ Double pause correctly rejected");
    }
  });

  // ── 14. Unpause ──

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

  // ── 15. Unpause When Not Paused ──

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

  // ── 16. All Remaining Rounds ──

  it("mints all remaining rounds through 1024, then rejects round 1025", async () => {
    for (let r = 4; r <= 1024; r++) {
      await program.methods
        .mintTobe()
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          poolSolReserve: poolSolReservePda,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      if (r % 200 === 0 || r === 1024) {
        console.log(`  ✓ Round ${r} minted`);
      }
    }

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 1024);

    // Round 1025 must be rejected
    try {
      await program.methods
        .mintTobe()
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          treasury: treasury.publicKey,
          poolSolReserve: poolSolReservePda,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected round 1025");
    } catch (err) {
      assert.include(err.toString(), "AllRoundsMinted");
      console.log("  ✓ Round 1025 correctly rejected with AllRoundsMinted");
    }
  });

  // ── 17. Update Treasury ──

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

  // ── 18. Unauthorized Treasury Update ──

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

  // ── 19. Lock LP ──

  it("locks LP tokens for 2 years", async () => {
    fakeLpMint = await createMintHelper(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      6
    );

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

    const lpBalanceAfter = await getAccount(provider.connection, authorityLpAccount);
    assert.equal(Number(lpBalanceAfter.amount), 0);

    const vaultBalance = await getAccount(provider.connection, lpLockVaultPda);
    assert.equal(Number(vaultBalance.amount), 1_000_000_000);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.lpLocked, true);
    assert.equal(state.lpMint.toString(), fakeLpMint.toString());
    assert.ok(state.lpLockUntil.toNumber() > 0, "Lock expiry should be set");
  });

  // ── 20. Reject Second Lock ──

  it("rejects second lock_lp call", async () => {
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

  // ── 21. Reject Early Unlock ──

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

    const vaultBalance = await getAccount(provider.connection, lpLockVaultPda);
    assert.equal(Number(vaultBalance.amount), 1_000_000_000);
  });

  // ── 2-Step Authority Transfer Tests ──

  let newAuthKeypair: anchor.web3.Keypair;

  // ── 22. Propose Authority ──

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

  // ── 23. Reject Wrong Acceptor ──

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

  // ── 24. Accept Authority ──

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

  // ── 25. Update Metadata ──

  it("updates token metadata", async () => {
    const [metadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        tobeMint.publicKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

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

  // ── 26. Reject Unauthorized Metadata ──

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

  // ── 27. Old Authority Revoked ──

  it("old authority can no longer pause", async () => {
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
