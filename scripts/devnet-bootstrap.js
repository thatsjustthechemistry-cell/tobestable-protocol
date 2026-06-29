// Devnet bootstrap: initialize the freshly-deployed program + mint round 1.
//
// Run: node scripts/devnet-bootstrap.js
//
// Produces:
//   - mint_state, vault_token, vault_sol_reserve, pool_sol_reserve PDAs
//   - A fresh TOBE mint (saved to scripts/.devnet-mint.json)
//   - Round 1 minted: 524,288 TOBE to caller, 524,288 to vault, 5+5 SOL split

const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");
const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

async function main() {
  const keypairPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".config",
    "solana",
    "id.json",
  );
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer / Authority / Treasury:", payer.publicKey.toBase58());

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "neco_token.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  // Derive PDAs
  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], PROGRAM_ID);
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const [vaultTokenPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_token")], PROGRAM_ID);
  const [lpLockAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("lp_lock_authority")], PROGRAM_ID);
  const [poolSolReservePda] = PublicKey.findProgramAddressSync([Buffer.from("pool_sol_reserve")], PROGRAM_ID);
  const [vaultSolReservePda] = PublicKey.findProgramAddressSync([Buffer.from("vault_sol_reserve")], PROGRAM_ID);

  // Check whether state already exists
  const stateAccount = await connection.getAccountInfo(mintStatePda);
  let tobeMintPubkey;

  if (stateAccount) {
    console.log("\nMintState already exists at", mintStatePda.toBase58());
    const state = await program.account.mintState.fetch(mintStatePda);
    tobeMintPubkey = state.tobeMint;
    console.log("  Existing TOBE mint:", tobeMintPubkey.toBase58());
    console.log("  current_round:    ", state.currentRound.toString());
  } else {
    // Generate fresh TOBE mint keypair
    const tobeMint = Keypair.generate();
    tobeMintPubkey = tobeMint.publicKey;
    fs.writeFileSync(
      path.join(__dirname, ".devnet-mint.json"),
      JSON.stringify(Array.from(tobeMint.secretKey)),
    );

    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), tobeMint.publicKey.toBuffer()],
      MPL_TOKEN_METADATA_ID,
    );

    console.log("\nInitializing fresh state...");
    console.log("  TOBE mint:        ", tobeMint.publicKey.toBase58());
    console.log("  mint_state PDA:   ", mintStatePda.toBase58());
    console.log("  vault_token PDA:  ", vaultTokenPda.toBase58());
    console.log("  vault_sol PDA:    ", vaultSolReservePda.toBase58());
    console.log("  pool_sol PDA:     ", poolSolReservePda.toBase58());

    const initTx = await program.methods
      .initialize(payer.publicKey, payer.publicKey)
      .accounts({
        authority: payer.publicKey,
        mintState: mintStatePda,
        tobeMint: tobeMint.publicKey,
        mintAuthority: mintAuthorityPda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultTokenPda,
        lpLockAuthority: lpLockAuthorityPda,
        metadata: metadataPda,
        tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
        program: PROGRAM_ID,
        programData: PublicKey.findProgramAddressSync(
          [PROGRAM_ID.toBuffer()],
          new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
        )[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([tobeMint])
      .rpc();
    console.log("  ✅ Initialize tx:", initTx);
  }

  // Need a TOBE token account for the minter
  const minterTobeAccount = Keypair.generate();
  const ACCOUNT_SIZE = 165;
  const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  const {
    Transaction,
    sendAndConfirmTransaction,
  } = require("@solana/web3.js");
  const splToken = require("@solana/spl-token");

  const createAtaTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: minterTobeAccount.publicKey,
      space: ACCOUNT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    splToken.createInitializeAccountInstruction(
      minterTobeAccount.publicKey,
      tobeMintPubkey,
      payer.publicKey,
      TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createAtaTx, [payer, minterTobeAccount]);
  console.log("\nMinter TOBE account:", minterTobeAccount.publicKey.toBase58());

  // Mint round 1
  console.log("\nMinting round 1...");
  const balanceBefore = await connection.getBalance(payer.publicKey);

  const mintTx = await program.methods
    .mintTobe()
    .accounts({
      minter: payer.publicKey,
      mintState: mintStatePda,
      tobeMint: tobeMintPubkey,
      mintAuthority: mintAuthorityPda,
      vaultTokenAccount: vaultTokenPda,
      poolSolReserve: poolSolReservePda,
      vaultSolReserve: vaultSolReservePda,
      minterTobe: minterTobeAccount.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  ✅ Mint tx:", mintTx);

  // Verify
  const balanceAfter = await connection.getBalance(payer.publicKey);
  const state = await program.account.mintState.fetch(mintStatePda);
  const minterAccount = await splToken.getAccount(connection, minterTobeAccount.publicKey, "confirmed", TOKEN_PROGRAM_ID);
  const vaultAccount = await splToken.getAccount(connection, vaultTokenPda, "confirmed", TOKEN_PROGRAM_ID);
  const poolSolBalance = await connection.getBalance(poolSolReservePda);
  const vaultSolBalance = await connection.getBalance(vaultSolReservePda);

  console.log("\n=== Verification ===");
  console.log("  Spent:", (balanceBefore - balanceAfter) / 1e9, "SOL (expected ~10 + fees)");
  console.log("  current_round:        ", state.currentRound.toString(), "(expected 1)");
  console.log("  total_minted:         ", state.totalMinted.toString());
  console.log("  vault_balance:        ", state.vaultBalance.toString());
  console.log("  pool_sol_balance:     ", state.poolSolBalance.toString(), "(state)");
  console.log("  pool_sol PDA actual:  ", poolSolBalance, "lamports (expected ≥ 5e9)");
  console.log("  vault_sol PDA actual: ", vaultSolBalance, "lamports (expected ≥ 5e9)");
  console.log("  Minter TOBE balance:  ", minterAccount.amount.toString());
  console.log("  Vault TOBE balance:   ", vaultAccount.amount.toString());

  const expectedHalf = (1024n * 1024n * 1_000_000_000n) / 2n;
  const ok =
    state.currentRound.toString() === "1" &&
    minterAccount.amount === expectedHalf &&
    vaultAccount.amount === expectedHalf;
  console.log(ok ? "\n✅ Bootstrap successful — Phase 1 mint flow verified on devnet" : "\n❌ Mismatch — see above");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
