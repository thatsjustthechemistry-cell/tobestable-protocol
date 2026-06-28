// scripts/arm-floor.js
//
// Permissionless: arm the $1 floor (enables sell_to_vault) once TOBE has first
// reached $1. Calls the program's `arm_floor` instruction, which checks
// TOBE/USD (Raydium pool reserves × Pyth SOL/USD) >= $1 and latches
// floor_active = true permanently.
//
// Mainnet only — needs the Pyth SOL/USD pull oracle (same pattern as
// scripts/devnet-buy-from-vault.js): fetch the latest update from Hermes, post
// it via the Pyth Solana Receiver, and consume it in the arm_floor call.
//
// Usage:
//   node scripts/arm-floor.js [--dry-run] [--keypair <PATH>]
//
//   --dry-run : read state + compute current TOBE/USD from the pool and report
//               whether arm_floor would succeed; send nothing.
//
// Preconditions: pool must be configured (set_pool_config done) and the floor
// must not already be armed. arm_floor reverts with PriceBelowPeg if TOBE < $1.

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const splToken = require("@solana/spl-token");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

const PROGRAM_ID = new PublicKey(
  process.env.TOBE_MAINNET_PROGRAM_ID || "Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX",
);
const SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";
const RPC = "https://api.mainnet-beta.solana.com";

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {
    dryRun: false,
    keypair: path.join(process.env.USERPROFILE || process.env.HOME, ".config", "solana", "id.json"),
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--dry-run") out.dryRun = true;
    else if (a[i] === "--keypair") out.keypair = a[++i];
  }
  return out;
}

async function main() {
  const { dryRun, keypair } = parseArgs();

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypair, "utf8"))),
  );
  const connection = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"),
  );
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const state = await program.account.mintState.fetch(mintStatePda);

  console.log("=== arm_floor pre-flight ===");
  console.log("  Caller:           ", payer.publicKey.toBase58());
  console.log("  Program:          ", PROGRAM_ID.toBase58());
  console.log("  floor_active:     ", state.floorActive);
  console.log("  pool configured:  ", !state.raydiumPoolState.equals(PublicKey.default));
  console.log("  tobe_is_token_0:  ", state.tobeIsToken0);

  if (state.floorActive) {
    console.log("\nℹ️  Floor already armed. Nothing to do.");
    return;
  }
  if (state.raydiumPoolState.equals(PublicKey.default)) {
    console.error("\n❌ Pool not configured yet (set_pool_config must run first). Cannot arm.");
    process.exit(1);
  }

  // Read pool reserves and compute current TOBE/USD against Hermes SOL/USD.
  const tok0 = await splToken.getAccount(connection, state.raydiumToken0Vault, "confirmed", splToken.TOKEN_PROGRAM_ID);
  const tok1 = await splToken.getAccount(connection, state.raydiumToken1Vault, "confirmed", splToken.TOKEN_PROGRAM_ID);
  const poolTobe = state.tobeIsToken0 ? BigInt(tok0.amount) : BigInt(tok1.amount);
  const poolSol = state.tobeIsToken0 ? BigInt(tok1.amount) : BigInt(tok0.amount);
  if (poolTobe === 0n || poolSol === 0n) {
    console.error("\n❌ Pool reserves are empty; cannot compute price.");
    process.exit(1);
  }

  console.log("\nFetching SOL/USD from Hermes...");
  const hermesRes = await fetch(
    `${HERMES_URL}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64`,
  );
  const hermesData = await hermesRes.json();
  const priceUpdateBase64 = hermesData.binary.data[0];
  const parsed = hermesData.parsed[0].price;
  const solUsd = Number(parsed.price) * Math.pow(10, parsed.expo);
  // Both pool legs are 9-decimal, so the raw ratio is SOL-per-TOBE directly.
  const tobePerSol = Number(poolSol) / Number(poolTobe); // SOL per TOBE
  const tobeUsd = tobePerSol * solUsd;
  console.log(`  SOL/USD:          $${solUsd.toFixed(4)}`);
  console.log(`  Pool TOBE/SOL:    ${(Number(poolTobe) / Number(poolSol)).toFixed(2)} TOBE per SOL`);
  console.log(`  Implied TOBE/USD: $${tobeUsd.toFixed(6)}`);
  console.log(`  >= $1?            ${tobeUsd >= 1 ? "YES — arm_floor should succeed" : "NO — would revert PriceBelowPeg"}`);

  if (dryRun) {
    console.log("\n--dry-run set; not sending.");
    return;
  }
  if (tobeUsd < 1) {
    console.error("\n❌ TOBE is below $1 right now; arm_floor would revert. Aborting.");
    process.exit(1);
  }

  // Post the Pyth update and consume it in arm_floor (same builder pattern as
  // devnet-buy-from-vault.js).
  const pythReceiver = new PythSolanaReceiver({ connection, wallet });
  const builder = pythReceiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([priceUpdateBase64]);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const priceUpdateAccount = getPriceUpdateAccount(SOL_USD_FEED_ID);
    return [
      {
        instruction: await program.methods
          .armFloor()
          .accounts({
            caller: payer.publicKey,
            mintState: mintStatePda,
            raydiumToken0Vault: state.raydiumToken0Vault,
            raydiumToken1Vault: state.raydiumToken1Vault,
            pythPriceUpdate: priceUpdateAccount,
          })
          .instruction(),
        signers: [],
      },
    ];
  });

  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50000 });
  console.log(`\nSending ${txs.length} tx(s)...`);
  const sigs = await pythReceiver.provider.sendAll(txs, { skipPreflight: false });
  for (const s of sigs) console.log("  tx:", s);

  const after = await program.account.mintState.fetch(mintStatePda);
  console.log("\n=== Result ===");
  console.log("  floor_active:", after.floorActive, after.floorActive ? "✅ floor is now ARMED" : "❌ still not armed");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
