// Devnet: one-time call to migrate_state_v2 — reallocates the existing
// mint_state PDA to fit Phase 2's new fields (raydium pool config, etc).
//
// Run: node scripts/devnet-migrate-v2.js

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");

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

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"),
  );
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_state")],
    PROGRAM_ID,
  );

  // Show current size
  const before = await connection.getAccountInfo(mintStatePda);
  console.log("Before migration:");
  console.log("  mint_state size:", before.data.length, "bytes");
  console.log("  lamports:       ", before.lamports);

  console.log("\nCalling migrate_state_v2...");
  const tx = await program.methods
    .migrateStateV2()
    .accounts({
      authority: payer.publicKey,
      mintState: mintStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  ✅ tx:", tx);

  const after = await connection.getAccountInfo(mintStatePda);
  console.log("\nAfter migration:");
  console.log("  mint_state size:", after.data.length, "bytes (was", before.data.length + ")");
  console.log("  lamports:       ", after.lamports);

  // Now we can fetch with the new layout
  const state = await program.account.mintState.fetch(mintStatePda);
  console.log("\n=== New fields ===");
  console.log("  raydium_pool_state:    ", state.raydiumPoolState.toBase58());
  console.log("  raydium_lp_mint:       ", state.raydiumLpMint.toBase58());
  console.log("  tobe_is_token_0:       ", state.tobeIsToken0);
  console.log("  vault_tobe_at_config:  ", state.vaultTobeAtConfig.toString());
  console.log(
    "\n✅ Migration complete — set_pool_config / flush_lp_to_raydium are now callable",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
