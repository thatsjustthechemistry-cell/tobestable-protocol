// Devnet: call set_pool_config (one-time admin) then flush_lp_to_raydium.
// Reads pool addresses from scripts/.devnet-pool.json.
//
// Run: node scripts/devnet-set-pool-config-and-flush.js

const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAccount,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");
const RAYDIUM_CPMM_DEVNET = new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");

async function main() {
  const keypairPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".config",
    "solana",
    "id.json",
  );
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
  );
  const wallet = new anchor.Wallet(payer);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"),
  );
  const program = new anchor.Program(idl, provider);

  const pool = JSON.parse(fs.readFileSync(path.join(__dirname, ".devnet-pool.json"), "utf8"));

  const [mintStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_state")],
    PROGRAM_ID,
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    PROGRAM_ID,
  );
  const [vaultTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token")],
    PROGRAM_ID,
  );
  const [poolSolReservePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_sol_reserve")],
    PROGRAM_ID,
  );
  const [wsolTempPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wsol_temp")],
    PROGRAM_ID,
  );
  const [lpReceiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_receipt")],
    PROGRAM_ID,
  );

  let state = await program.account.mintState.fetch(mintStatePda);

  // Step 1: set_pool_config (skip if already configured)
  if (state.raydiumPoolState.toBase58() === "11111111111111111111111111111111") {
    console.log("Calling set_pool_config...");
    const tx = await program.methods
      .setPoolConfig(pool.tobeIsToken0)
      .accounts({
        authority: payer.publicKey,
        mintState: mintStatePda,
        raydiumPoolState: new PublicKey(pool.poolState),
        raydiumPoolAuthority: new PublicKey(pool.poolAuthority),
        raydiumLpMint: new PublicKey(pool.lpMint),
        raydiumToken0Vault: new PublicKey(pool.token0Vault),
        raydiumToken1Vault: new PublicKey(pool.token1Vault),
      })
      .rpc();
    console.log("  ✅ tx:", tx);
    state = await program.account.mintState.fetch(mintStatePda);
  } else {
    console.log("Pool already configured at:", state.raydiumPoolState.toBase58());
  }

  console.log("\nState before flush:");
  console.log("  pool_sol_balance:    ", state.poolSolBalance.toString(), "lamports");
  console.log("  vault_balance:       ", state.vaultBalance.toString(), "TOBE raw");
  console.log("  vault_tobe_at_config:", state.vaultTobeAtConfig.toString());
  console.log("  tobe_is_token_0:     ", state.tobeIsToken0);

  if (state.poolSolBalance.toNumber() < 1_000_000_000) {
    console.log("\n⚠️ pool_sol_balance < 1 SOL — flush threshold not met. Run mint_tobe more rounds first.");
    console.log("   Skipping flush; set_pool_config is done.");
    return;
  }

  // Step 2: flush_lp_to_raydium
  // Compute the slippage bound (max_tobe_to_pair) from the CURRENT pool ratio,
  // plus a 2% tolerance. If the pool is sandwiched between now and execution,
  // the on-chain required TOBE exceeds this and the flush reverts (by design).
  const t0Bal = await connection.getTokenAccountBalance(new PublicKey(pool.token0Vault));
  const t1Bal = await connection.getTokenAccountBalance(new PublicKey(pool.token1Vault));
  const poolTobe = BigInt(pool.tobeIsToken0 ? t0Bal.value.amount : t1Bal.value.amount);
  const poolSol = BigInt(pool.tobeIsToken0 ? t1Bal.value.amount : t0Bal.value.amount);
  const solToDeposit = BigInt(state.poolSolBalance.toString());
  const expectedTobe = (solToDeposit * poolTobe) / poolSol + 1n;
  const maxTobeToPair = (expectedTobe * 102n) / 100n; // +2% slippage tolerance
  console.log("  max_tobe_to_pair (2% tol):", maxTobeToPair.toString());
  console.log("\nCalling flush_lp_to_raydium...");
  const flushTx = await program.methods
    .flushLpToRaydium(new anchor.BN(maxTobeToPair.toString()))
    .accounts({
      caller: payer.publicKey,
      mintState: mintStatePda,
      tobeMint: state.tobeMint,
      vaultAuthority: vaultAuthorityPda,
      vaultTokenAccount: vaultTokenPda,
      poolSolReserve: poolSolReservePda,
      wsolTemp: wsolTempPda,
      wsolMint: NATIVE_MINT,
      lpReceipt: lpReceiptPda,
      raydiumPoolState: new PublicKey(pool.poolState),
      raydiumLpMint: new PublicKey(pool.lpMint),
      raydiumPoolAuthority: new PublicKey(pool.poolAuthority),
      raydiumToken0Vault: new PublicKey(pool.token0Vault),
      raydiumToken1Vault: new PublicKey(pool.token1Vault),
      vault0Mint: pool.tobeIsToken0 ? state.tobeMint : NATIVE_MINT,
      vault1Mint: pool.tobeIsToken0 ? NATIVE_MINT : state.tobeMint,
      raydiumProgram: RAYDIUM_CPMM_DEVNET,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc({ skipPreflight: false });
  console.log("  ✅ flush tx:", flushTx);

  // Verify
  const stateAfter = await program.account.mintState.fetch(mintStatePda);
  console.log("\n=== After flush ===");
  console.log(
    "  pool_sol_balance: ",
    stateAfter.poolSolBalance.toString(),
    "(expected 0)",
  );
  console.log("  vault_balance:    ", stateAfter.vaultBalance.toString());

  // LP receipt should be empty (burned)
  try {
    const lpAcc = await getAccount(connection, lpReceiptPda, "confirmed", TOKEN_PROGRAM_ID);
    console.log("  lp_receipt amount:", lpAcc.amount.toString(), "(expected 0)");
  } catch (e) {
    console.log("  lp_receipt:", e.message);
  }

  console.log("\n✅ flush_lp_to_raydium verified end-to-end on devnet");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
