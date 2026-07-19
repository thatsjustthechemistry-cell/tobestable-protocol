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
  // Disclosed team allocation wallet (mainnet: Eis6…5Bvf; tests use a throwaway
  // keypair since the real key can't sign here). Stored immutably at initialize.
  const teamWallet = anchor.web3.Keypair.generate();
  const TEAM_FREE_MINT_CAP = 8;
  let teamTobe: anchor.web3.PublicKey;
  let tobeMint: anchor.web3.Keypair;
  let minterTobe: anchor.web3.PublicKey;
  let mintStatePda: anchor.web3.PublicKey;
  let mintAuthorityPda: anchor.web3.PublicKey;
  let vaultAuthorityPda: anchor.web3.PublicKey;
  let vaultTokenPda: anchor.web3.PublicKey;
  let lpLockAuthorityPda: anchor.web3.PublicKey;
  let lpLockVaultPda: anchor.web3.PublicKey;
  let poolSolReservePda: anchor.web3.PublicKey;
  let vaultSolReservePda: anchor.web3.PublicKey;

  // Placeholder Pyth feed pubkey for localnet (no real Pyth here).
  // buy_from_vault / sell_to_vault tests must run on devnet.
  const pythPlaceholder = anchor.web3.Keypair.generate().publicKey;

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
    [vaultSolReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_sol_reserve")],
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
      .initialize(treasury.publicKey, authority.publicKey, authority.publicKey, teamWallet.publicKey)
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
        program: program.programId,
        programData: anchor.web3.PublicKey.findProgramAddressSync(
          [program.programId.toBuffer()],
          new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
        )[0],
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
    // Floor-activation latch (audit hardening): starts OFF; sell_to_vault is
    // disabled until arm_floor latches it true once TOBE first reaches $1.
    assert.equal(state.floorActive, false);
    // Disclosed team allocation: wallet stored immutably, counter starts at 0.
    assert.equal(state.teamWallet.toString(), teamWallet.publicKey.toString());
    assert.equal(state.teamFreeMintsUsed.toNumber(), 0);
  });

  // ── 2. Mint Round 1 ──

  it("mints round 1 — 50% minter, 50% vault, 5 SOL pool reserve + 5 SOL vault SOL reserve", async () => {
    minterTobe = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey
    );

    const tx = await program.methods
      .mintTobe(null)
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolSolReserve: poolSolReservePda,
        vaultSolReserve: vaultSolReservePda,
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

    // 5 SOL to pool reserve, 5 SOL to vault SOL reserve, 0 to treasury
    const poolReserveBalance = await provider.connection.getBalance(poolSolReservePda);
    assert.ok(poolReserveBalance >= MINT_COST / 2, "Pool reserve should have ≥5 SOL");

    const vaultSolBalance = await provider.connection.getBalance(vaultSolReservePda);
    assert.ok(vaultSolBalance >= MINT_COST / 2, "Vault SOL reserve should have ≥5 SOL");

    assert.equal(state.totalMinted.toNumber(), totalTokens);
    assert.equal(state.poolSolBalance.toNumber(), MINT_COST / 2);
    // Minting must NOT arm the floor — only arm_floor (once TOBE ≥ $1) does.
    assert.equal(state.floorActive, false);
  });

  // ── 3. Mint Round 2 ──

  it("mints round 2 — uniform 5/5 split, fewer tokens", async () => {
    const poolBefore = await provider.connection.getBalance(poolSolReservePda);
    const vaultSolBefore = await provider.connection.getBalance(vaultSolReservePda);

    const tx = await program.methods
      .mintTobe(null)
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolSolReserve: poolSolReservePda,
        vaultSolReserve: vaultSolReservePda,
        minterTobe: minterTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Mint round 2 tx:", tx);

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.currentRound.toNumber(), 2);

    // Round 2 also splits 5/5: pool reserve and vault SOL reserve each gain 5 SOL.
    const poolAfter = await provider.connection.getBalance(poolSolReservePda);
    const vaultSolAfter = await provider.connection.getBalance(vaultSolReservePda);
    assert.equal(poolAfter - poolBefore, MINT_COST / 2);
    assert.equal(vaultSolAfter - vaultSolBefore, MINT_COST / 2);
  });

  // ── 4. Round 3 Decreasing Formula ──

  it("round 3 yields fewer tokens — verifies decreasing formula, with a referrer logged on-chain", async () => {
    const minterTobeBefore = await getAccount(provider.connection, minterTobe);
    // Exercise the optional referrer here too (no extra round consumed): it's
    // purely informational — no reward/fee — and should appear in the tx log.
    const referrer = anchor.web3.Keypair.generate().publicKey;

    const tx = await program.methods
      .mintTobe(referrer)
      .accounts({
        minter: authority.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolSolReserve: poolSolReservePda,
        vaultSolReserve: vaultSolReservePda,
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
    // No reward/fee for the referral: minter still gets exactly the round share.
    assert.equal(received, expectedMinter);

    // Referral is logged on-chain (msg!), not stored in state — confirm it
    // shows up in this transaction's program log.
    // getTransaction returns null until the tx is indexed at this commitment —
    // fetching immediately after .rpc() is a race that throws on .meta. Poll.
    let txDetails = null;
    for (let i = 0; i < 30 && txDetails === null; i++) {
      txDetails = await provider.connection.getTransaction(tx, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txDetails === null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(txDetails, "mint transaction should become retrievable");
    const logs = txDetails.meta.logMessages.join("\n");
    assert.ok(
      logs.includes(referrer.toString()),
      "referrer pubkey should appear in the transaction's program log"
    );
  });

  it("rejects self-referral", async () => {
    let threw = false;
    try {
      await program.methods
        .mintTobe(authority.publicKey) // referrer === minter
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
          minterTobe: minterTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      threw = true;
      assert.ok(
        String(e).includes("SelfReferral") || String(e).includes("Cannot refer yourself"),
        `expected SelfReferral error, got: ${e}`
      );
    }
    assert.ok(threw, "self-referral mint should have been rejected");
  });

  // ── 5 & 6. Seed Pool tests REMOVED (M1 audit fix) ──
  // seed_pool was deleted: a legacy, fair-launch-unused authority primitive that
  // moved round-1 vault TOBE + all pool SOL to an unconstrained destination.
  // Ongoing liquidity is handled by the floor-protected flush_lp_to_raydium.

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
        .mintTobe(null)
        .accounts({
          minter: brokeMinter.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
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

  // ── 6. Stabilization (devnet only — needs real Pyth feed) ──
  //
  // The old keeper-driven `vaultRelease` was replaced by two permissionless
  // instructions: `buyFromVault` (SOL → TOBE @ $1) and `sellToVault` (TOBE → SOL @ $1).
  // Both read Pyth SOL/USD. Localnet has no Pyth, so these tests run on devnet.

  // These require real Pyth (and, for flush/arm_floor, real Raydium) accounts
  // that don't exist on localnet, so they can't run under `anchor test`. Use the
  // devnet scripts: scripts/devnet-buy-from-vault.js, scripts/devnet-sell-to-vault.js,
  // scripts/devnet-set-pool-config-and-flush.js, scripts/arm-floor.js.

  it.skip("buy_from_vault: caller pays SOL, receives TOBE at $1 (devnet)", async () => {
    // scripts/devnet-buy-from-vault.js. Expected: TOBE += sol_in*price; treasury gains SOL.
  });

  it.skip("sell_to_vault: caller deposits TOBE, receives SOL at $1 (devnet)", async () => {
    // scripts/devnet-sell-to-vault.js. Covers audit fix #1 (the SOL payout now uses a
    // PDA-signed system_program::transfer, not a forbidden direct lamport debit).
    // PRECONDITION: floor must be armed first (arm_floor once TOBE ≥ $1), else the
    // call reverts with FloorNotActive. Expected: vault_sol_reserve drains by
    // tobe_in / price; seller's SOL balance rises; vault_balance += tobe_in.
  });

  it.skip("sell_to_vault rejects when floor not armed — FloorNotActive (devnet)", async () => {
    // Before arm_floor: sell_to_vault must revert with FloorNotActive (the latch).
  });

  it.skip("buy_from_vault rejects when oracle price is stale (devnet)", async () => {
    // Stage a stale Pyth update; expect StalePriceFeed.
  });

  it.skip("sell_to_vault rejects when vault_sol_reserve has insufficient SOL (devnet)", async () => {
    // Drain vault_sol then attempt sell; expect VaultSolInsufficient.
  });

  it.skip("flush_lp_to_raydium: deposits + burns LP, returns wSOL residual to reserve (devnet)", async () => {
    // scripts/devnet-set-pool-config-and-flush.js. Covers audit fixes #4 (slippage
    // bound), #6 (measured vault_balance delta), and CPI-1 (unconsumed wSOL returns
    // to pool_sol_reserve, not the caller). Expected: LP burned; pool_sol_balance
    // reflects only the unconsumed residual; vault_balance drops by measured TOBE.
  });

  // ── 9b. arm_floor authority gate (H1 fix) ──
  //
  // Covers the Round-4 (Fable 5) H1 fix: arm_floor is authority-only. It used to be
  // permissionless, letting anyone flash-skew the pool spot ratio across $1 to latch
  // floor_active = true early and unlock a vault_sol_reserve drain. The gate is
  // `constraint = authority.key() == mint_state.authority @ Unauthorized` on the
  // ArmFloor.authority signer.
  //
  // Runs on DEVNET (like the arm_floor happy path above) because ArmFloor also takes
  // the real Raydium pool vaults + a Pyth PriceUpdateV2 account that localnet lacks —
  // so the authority rejection can't be exercised under `anchor test`.
  //
  // Runbook (extend scripts/arm-floor.js — it already wires the token0/token1 vaults
  // from mint_state and posts a fresh Pyth SOL/USD update via PythSolanaReceiver):
  //   1. Sign the arm_floor tx with a throwaway keypair that is NOT mint_state.authority.
  //   2. Expect it to revert with Unauthorized (or ConstraintRaw).
  //   3. Assert mint_state.floor_active is unchanged (false) afterward — the hard
  //      invariant: a non-authority must never latch the floor.
  //   4. (Optional) then arm with the real authority and confirm floor_active flips true.
  //
  // The pure TOBE≥$1 arming MATH is unit-tested in CI (no devnet needed): see the
  // `arm_gate_*` cases in the Rust `pyth_math_tests` module (tobe_at_or_above_one_usd).
  // ✅ SUPERSEDED (2026-07-19) — this is now a REAL, RUNNING test, not a devnet
  // runbook. See §28: "arm_floor rejects a non-authority — the H1 gate". CI clones
  // mainnet Raydium + the Pyth receiver + Wormhole into the validator, creates a
  // genuine pool, posts a fresh Hermes price, and asserts both the Unauthorized
  // rejection and that floor_active stays false. The devnet route it described is
  // in fact impossible now: arm_floor requires a configured pool, and
  // set_pool_config cannot succeed on devnet (mainnet Raydium id is compiled in).
  // Kept as a marker so nobody re-adds a manual devnet step that is already covered.

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
        .mintTobe(null)
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
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

  // ── 15b. Disclosed Team Allocation ──

  it("team wallet mints free — no SOL debit, reserves untouched, same 50/50 split, counter increments", async () => {
    // Fund the team wallet: tx fees + rent + the paid 9th mint in the next test
    const fundTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: teamWallet.publicKey,
        lamports: 12_000_000_000,
      })
    );
    await provider.sendAndConfirm(fundTx, []);

    teamTobe = await createTokenAccountHelper(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      teamWallet.publicKey
    );

    const stateBefore = await program.account.mintState.fetch(mintStatePda);
    const roundBefore = stateBefore.currentRound.toNumber();
    const poolBefore = await provider.connection.getBalance(poolSolReservePda);
    const vaultSolBefore = await provider.connection.getBalance(vaultSolReservePda);
    const teamBalBefore = await provider.connection.getBalance(teamWallet.publicKey);

    await program.methods
      .mintTobe(null)
      .accounts({
        minter: teamWallet.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        poolSolReserve: poolSolReservePda,
        vaultSolReserve: vaultSolReservePda,
        minterTobe: teamTobe,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([teamWallet])
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    const round = roundBefore + 1;
    assert.equal(state.currentRound.toNumber(), round);
    assert.equal(state.teamFreeMintsUsed.toNumber(), 1);

    // Only the tx fee left the team wallet — the 10 SOL payment was waived
    const teamBalAfter = await provider.connection.getBalance(teamWallet.publicKey);
    assert.ok(teamBalBefore - teamBalAfter < 100_000, "only the tx fee should be debited");

    // Neither reserve received anything for this round
    assert.equal(await provider.connection.getBalance(poolSolReservePda), poolBefore);
    assert.equal(await provider.connection.getBalance(vaultSolReservePda), vaultSolBefore);
    // LP accounting untouched by the free round
    assert.equal(state.poolSolBalance.toNumber(), stateBefore.poolSolBalance.toNumber());

    // Token split identical to a paid mint: 50% team, 50% vault
    const totalTokens = 1024 * (1024 + 1 - round) * TOBE_DECIMALS;
    const teamAccount = await getAccount(provider.connection, teamTobe);
    assert.equal(Number(teamAccount.amount), Math.floor(totalTokens / 2));
  });

  it("cap enforced: free through mint 8, the 9th team mint pays like everyone", async () => {
    const teamMint = () =>
      program.methods
        .mintTobe(null)
        .accounts({
          minter: teamWallet.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
          minterTobe: teamTobe,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([teamWallet])
        .rpc();

    // Consume the remaining 7 free mints (one was used in the previous test)
    for (let i = 2; i <= TEAM_FREE_MINT_CAP; i++) {
      await teamMint();
    }
    let state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.teamFreeMintsUsed.toNumber(), TEAM_FREE_MINT_CAP);

    // 9th team mint: cap exhausted — full 10 SOL payment applies
    const teamBalBefore = await provider.connection.getBalance(teamWallet.publicKey);
    const poolBefore = await provider.connection.getBalance(poolSolReservePda);
    const vaultSolBefore = await provider.connection.getBalance(vaultSolReservePda);

    await teamMint();

    state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.teamFreeMintsUsed.toNumber(), TEAM_FREE_MINT_CAP, "counter must not pass the cap");

    const teamBalAfter = await provider.connection.getBalance(teamWallet.publicKey);
    assert.ok(teamBalBefore - teamBalAfter >= MINT_COST, "9th team mint must pay the full 10 SOL");
    assert.equal(await provider.connection.getBalance(poolSolReservePda), poolBefore + MINT_COST / 2);
    assert.equal(await provider.connection.getBalance(vaultSolReservePda), vaultSolBefore + MINT_COST / 2);
  });

  // ── 16. All Remaining Rounds ──

  it("mints all remaining rounds through 1024, then rejects round 1025", async () => {
    const st = await program.account.mintState.fetch(mintStatePda);
    for (let r = st.currentRound.toNumber() + 1; r <= 1024; r++) {
      await program.methods
        .mintTobe(null)
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
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
        .mintTobe(null)
        .accounts({
          minter: authority.publicKey,
          mintState: mintStatePda,
          tobeMint: tobeMint.publicKey,
          mintAuthority: mintAuthorityPda,
          vaultTokenAccount: vaultTokenPda,
          poolSolReserve: poolSolReservePda,
          vaultSolReserve: vaultSolReservePda,
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

  // ── 27. Raydium pool + set_pool_config (localnet, cloned mainnet Raydium) ──
  //
  // set_pool_config had NO coverage anywhere: it validates the pool against the
  // MAINNET Raydium CPMM program (the crate is pinned default-features = false,
  // so CPMMoo8… is compiled in and devnet's DRaycpLY… is not), which made devnet
  // structurally useless for it. CI now clones mainnet Raydium into the local
  // validator, so a real pool can be created here and Step 9 exercised for real.
  //
  // These run LAST on purpose: by this point authority has moved to
  // newAuthKeypair, so set_pool_config must be signed by that key, not `authority`.
  //
  // The Raydium SDK is imported DYNAMICALLY inside the test rather than at module
  // top: if the SDK fails to load or its API is unreachable, only these tests
  // fail — the other 30 stay green instead of the whole file dying at import.

  let poolInfo: {
    poolId: anchor.web3.PublicKey;
    poolAuthority: anchor.web3.PublicKey;
    lpMint: anchor.web3.PublicKey;
    vaultA: anchor.web3.PublicKey;
    vaultB: anchor.web3.PublicKey;
    tobeIsToken0: boolean;
  } | null = null;

  it("creates a real TOBE/wSOL Raydium CPMM pool on localnet", async () => {
    const {
      Raydium,
      CREATE_CPMM_POOL_PROGRAM,
      CREATE_CPMM_POOL_FEE_ACC,
      getCpmmPdaAmmConfigId,
      TxVersion,
    } = await import("@raydium-io/raydium-sdk-v2");
    const BN = (await import("bn.js")).default;
    const splTok = await import("@solana/spl-token");

    // Park TOBE in a real ATA so the SDK's owner-token-account discovery finds it
    // deterministically (minterTobe is a bare account, not an ATA).
    const ata = await splTok.getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as any).payer,
      tobeMint.publicKey,
      authority.publicKey
    );
    const seedTobe = 200_000 * TOBE_DECIMALS;
    await splTok.transfer(
      provider.connection,
      (authority as any).payer,
      minterTobe,
      ata.address,
      authority.publicKey,
      seedTobe
    );

    const raydium = await Raydium.load({
      connection: provider.connection,
      owner: (authority as any).payer,
      cluster: "mainnet",
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });

    // Fee configs come from Raydium's API (mainnet shapes), but the on-chain
    // account is the cloned AMM config PDA — override id exactly as the mainnet
    // script does so the instruction points at the account we actually cloned.
    const feeConfigs = await raydium.api.getCpmmConfigs();
    feeConfigs.forEach((c: any) => {
      c.id = getCpmmPdaAmmConfigId(CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58();
    });

    // Raydium requires token_0 < token_1 lexicographically.
    const NATIVE = splTok.NATIVE_MINT;
    const tobeFirst = tobeMint.publicKey.toBuffer().compare(NATIVE.toBuffer()) < 0;
    const mintA = tobeFirst ? tobeMint.publicKey : NATIVE;
    const mintB = tobeFirst ? NATIVE : tobeMint.publicKey;
    const solSide = 2 * anchor.web3.LAMPORTS_PER_SOL;

    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId: CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
      mintA: { address: mintA.toBase58(), decimals: 9, programId: splTok.TOKEN_PROGRAM_ID.toBase58() },
      mintB: { address: mintB.toBase58(), decimals: 9, programId: splTok.TOKEN_PROGRAM_ID.toBase58() },
      mintAAmount: new BN(tobeFirst ? seedTobe : solSide),
      mintBAmount: new BN(tobeFirst ? solSide : seedTobe),
      startTime: new BN(0),
      feeConfig: feeConfigs[0],
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
    });
    await execute({ sendAndConfirm: true });

    poolInfo = {
      poolId: extInfo.address.poolId,
      poolAuthority: extInfo.address.authority,
      lpMint: extInfo.address.lpMint,
      vaultA: extInfo.address.vaultA,
      vaultB: extInfo.address.vaultB,
      tobeIsToken0: tobeFirst,
    };

    const acc = await provider.connection.getAccountInfo(poolInfo.poolId);
    assert.ok(acc, "pool state account not created");
    assert.equal(
      acc.owner.toBase58(),
      CREATE_CPMM_POOL_PROGRAM.toBase58(),
      "pool not owned by the cloned mainnet CPMM program"
    );
    console.log("  ✓ pool:", poolInfo.poolId.toBase58(), "| tobe_is_token_0:", tobeFirst);
  });

  it("set_pool_config records the pool (launch Step 9)", async () => {
    assert.ok(poolInfo, "pool creation must succeed first");

    await program.methods
      .setPoolConfig(poolInfo!.tobeIsToken0)
      .accounts({
        authority: newAuthKeypair.publicKey, // authority moved earlier in this suite
        mintState: mintStatePda,
        raydiumPoolState: poolInfo!.poolId,
        raydiumPoolAuthority: poolInfo!.poolAuthority,
        raydiumLpMint: poolInfo!.lpMint,
        raydiumToken0Vault: poolInfo!.vaultA,
        raydiumToken1Vault: poolInfo!.vaultB,
      })
      .signers([newAuthKeypair])
      .rpc();

    const state = await program.account.mintState.fetch(mintStatePda);
    assert.equal(state.raydiumPoolState.toBase58(), poolInfo!.poolId.toBase58());
    assert.equal(state.raydiumToken0Vault.toBase58(), poolInfo!.vaultA.toBase58());
    assert.equal(state.raydiumToken1Vault.toBase58(), poolInfo!.vaultB.toBase58());
    assert.equal(state.tobeIsToken0, poolInfo!.tobeIsToken0);
    // The 30%-floor baseline is captured here — the value yesterday's audit
    // showed decays into irrelevance, which is why buy_from_vault now anchors to
    // total_minted/2 instead.
    // .gtn(), not .toNumber() — vaultTobeAtConfig is a u64 in raw 9-decimal
    // units, so by ~20 mint rounds it is ~1.04e16 and exceeds JS's 2^53 safe
    // integer limit. toNumber() throws "Number can only safely store up to 53
    // bits" on a value that is perfectly valid on-chain.
    assert.ok(state.vaultTobeAtConfig.gtn(0), "floor baseline should be captured");
    console.log("  ✓ set_pool_config verified against the real pool");
  });

  it("rejects set_pool_config from a non-authority", async () => {
    assert.ok(poolInfo, "pool creation must succeed first");
    const intruder = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(intruder.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .setPoolConfig(poolInfo!.tobeIsToken0)
        .accounts({
          authority: intruder.publicKey,
          mintState: mintStatePda,
          raydiumPoolState: poolInfo!.poolId,
          raydiumPoolAuthority: poolInfo!.poolAuthority,
          raydiumLpMint: poolInfo!.lpMint,
          raydiumToken0Vault: poolInfo!.vaultA,
          raydiumToken1Vault: poolInfo!.vaultB,
        })
        .signers([intruder])
        .rpc();
      assert.fail("Should have rejected — set_pool_config is authority-only");
    } catch (err) {
      assert.ok(
        err.toString().includes("Unauthorized") ||
          err.toString().includes("ConstraintRaw") ||
          err.toString().includes("PoolAlreadyConfigured"),
        `Expected Unauthorized/PoolAlreadyConfigured, got: ${err.toString().slice(0, 200)}`
      );
    }
  });

  // ── 28. Pyth-gated instructions (localnet, cloned Pyth receiver + Wormhole) ──
  //
  // buy_from_vault and arm_floor were the LAST instructions with no end-to-end
  // coverage anywhere — and buy_from_vault is exactly the code changed three
  // times on 2026-07-18 (F1 vault floor, F2 price gate, monotonic anchor) plus
  // two added accounts. Only the pure helpers had unit tests.
  //
  // They need a FRESH Pyth price (staleness window is 15s), which needs the Pyth
  // receiver, Wormhole, and the CURRENT guardian set cloned into the validator.
  // Guardian set index is read from the Wormhole bridge config — it is 7 as of
  // 2026-07-19, NOT the 4/5 an older guide would suggest. If Wormhole rotates the
  // set, these tests break and the fix is to clone the new index (see ci.yml).
  //
  // A real Hermes update is posted here; its guardian signatures verify the same
  // on localnet as anywhere, because they sign the price data, not the chain.

  const SOL_USD_FEED_ID =
    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

  async function withFreshPythPrice(makeIx: (priceUpdate: anchor.web3.PublicKey) => Promise<{
    instruction: anchor.web3.TransactionInstruction;
    signers: anchor.web3.Signer[];
  }>) {
    const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64`
    );
    const hermes: any = await res.json();

    const receiver = new PythSolanaReceiver({
      connection: provider.connection,
      wallet: authority as any,
    });
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addPostPriceUpdates([hermes.binary.data[0]]);
    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: any) => {
      const pu = getPriceUpdateAccount(SOL_USD_FEED_ID);
      return [await makeIx(pu)];
    });
    const txs = await builder.buildVersionedTransactions({
      computeUnitPriceMicroLamports: 50000,
    });
    return receiver.provider.sendAll(txs, { skipPreflight: false });
  }

  it("buy_from_vault rejects below peg — the F2 price gate (Pyth posted on localnet)", async () => {
    assert.ok(poolInfo, "needs the configured pool");
    // The seeded pool is ~200k TOBE against 2 SOL, so TOBE is worth a tiny
    // fraction of $1. Before the F2 fix the vault would have sold at $1 anyway,
    // handing over an asset worth far less than it booked — and profitably so for
    // the founder, who gets 50% of the proceeds back. It must now revert.
    const buyerTobe = (
      await (await import("@solana/spl-token")).getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        tobeMint.publicKey,
        authority.publicKey
      )
    ).address;

    let threw = false;
    let msg = "";
    try {
      await withFreshPythPrice(async (priceUpdate) => ({
        instruction: await program.methods
          .buyFromVault(new anchor.BN(100_000_000)) // 0.1 SOL
          .accounts({
            buyer: authority.publicKey,
            mintState: mintStatePda,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount: vaultTokenPda,
            treasury: treasury.publicKey,
            founder: authority.publicKey,
            raydiumToken0Vault: poolInfo!.vaultA,
            raydiumToken1Vault: poolInfo!.vaultB,
            buyerTobe,
            pythPriceUpdate: priceUpdate,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
        signers: [],
      }));
    } catch (err: any) {
      threw = true;
      msg = err.toString() + (err.logs ? "\n" + err.logs.join("\n") : "");
    }

    assert.ok(threw, "buy_from_vault must reject while TOBE trades below $1");
    assert.ok(
      /PriceBelowPeg|6\d{3}/.test(msg),
      `expected PriceBelowPeg, got: ${msg.slice(0, 400)}`
    );
    console.log("  ✓ F2 gate held — vault refused to sell below peg");
  });

  it("arm_floor rejects a non-authority — the H1 gate (Pyth posted on localnet)", async () => {
    assert.ok(poolInfo, "needs the configured pool");
    // H1: arm_floor used to be permissionless, so anyone could flash-skew the
    // pool across $1, latch floor_active permanently, and unlock a
    // vault_sol_reserve drain. This is the check that was previously provable
    // only by a manual devnet run.
    const intruder = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(intruder.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const before = await program.account.mintState.fetch(mintStatePda);

    let threw = false;
    let msg = "";
    try {
      await withFreshPythPrice(async (priceUpdate) => ({
        instruction: await program.methods
          .armFloor()
          .accounts({
            authority: intruder.publicKey, // NOT mint_state.authority
            mintState: mintStatePda,
            raydiumToken0Vault: poolInfo!.vaultA,
            raydiumToken1Vault: poolInfo!.vaultB,
            pythPriceUpdate: priceUpdate,
          })
          .instruction(),
        signers: [intruder],
      }));
    } catch (err: any) {
      threw = true;
      msg = err.toString() + (err.logs ? "\n" + err.logs.join("\n") : "");
    }

    assert.ok(threw, "arm_floor must reject a non-authority signer");
    assert.ok(
      /Unauthorized|ConstraintRaw|6002/.test(msg),
      `expected Unauthorized, got: ${msg.slice(0, 400)}`
    );

    // The hard invariant, independent of which error fired.
    const after = await program.account.mintState.fetch(mintStatePda);
    assert.equal(after.floorActive, before.floorActive, "non-authority must not arm the floor");
    console.log("  ✓ H1 gate held — floor stayed disarmed");
  });
});
