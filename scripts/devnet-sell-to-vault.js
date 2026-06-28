// Devnet integration test: sell_to_vault with real Pyth SOL/USD price.
//
// Covers audit fix #1 — the SOL payout now uses a PDA-signed
// system_program::transfer (the old direct lamport debit on the System-owned
// vault_sol_reserve was rejected by the runtime, bricking the floor entirely).
//
// Run: node scripts/devnet-sell-to-vault.js [TOBE_AMOUNT] [--tobe-account <PUBKEY>]
//   default TOBE_AMOUNT: 1 (whole TOBE)
//
// PRECONDITIONS (devnet):
//   1. Program deployed with the current code; initialized.
//   2. The $1 floor is ARMED — run scripts/arm-floor.js once TOBE ≥ $1, or the
//      call reverts with FloorNotActive.
//   3. vault_sol_reserve holds enough SOL (accrues 5 SOL per mint round).
//   4. The seller holds TOBE in their associated token account (or pass
//      --tobe-account).
//
// Flow (Pyth pull-oracle pattern, same as devnet-buy-from-vault.js):
//   fetch SOL/USD from Hermes → post via Pyth Solana Receiver → call sell_to_vault.

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const splToken = require("@solana/spl-token");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

const PROGRAM_ID = new PublicKey("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");
const SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOBE_DECIMALS = 1_000_000_000;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { tobe: 1, tobeAccount: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--tobe-account") out.tobeAccount = new PublicKey(a[++i]);
    else if (!a[i].startsWith("--")) out.tobe = parseFloat(a[i]);
  }
  return out;
}

async function main() {
  const { tobe, tobeAccount } = parseArgs();
  const tobeRaw = Math.floor(tobe * TOBE_DECIMALS);

  const keypairPath = path.join(
    process.env.USERPROFILE || process.env.HOME, ".config", "solana", "id.json",
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

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const [vaultTokenPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_token")], PROGRAM_ID);
  const [vaultSolReservePda] = PublicKey.findProgramAddressSync([Buffer.from("vault_sol_reserve")], PROGRAM_ID);

  const state = await program.account.mintState.fetch(mintStatePda);
  const sellerTobe = tobeAccount ||
    splToken.getAssociatedTokenAddressSync(state.tobeMint, payer.publicKey, false, TOKEN_PROGRAM_ID);

  console.log("Seller:           ", payer.publicKey.toBase58());
  console.log("TOBE mint:        ", state.tobeMint.toBase58());
  console.log("Seller TOBE acct: ", sellerTobe.toBase58());
  console.log("floor_active:     ", state.floorActive);
  console.log("vault_sol_reserve:", (await connection.getBalance(vaultSolReservePda)) / 1e9, "SOL");
  console.log("Selling:          ", tobe, "TOBE =", tobeRaw, "raw");

  if (!state.floorActive) {
    console.error("\n❌ Floor is not armed (floor_active=false). Run scripts/arm-floor.js first, or this reverts FloorNotActive.");
    process.exit(1);
  }

  const sellerSolBefore = await connection.getBalance(payer.publicKey);
  const vaultSolBefore = await connection.getBalance(vaultSolReservePda);

  console.log("\nFetching SOL/USD from Hermes...");
  const hermesRes = await fetch(`${HERMES_URL}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64`);
  const hermesData = await hermesRes.json();
  const priceUpdateBase64 = hermesData.binary.data[0];
  const parsed = hermesData.parsed[0].price;
  const solUsd = Number(parsed.price) * Math.pow(10, parsed.expo);
  const expectedSolOut = (tobeRaw / TOBE_DECIMALS) / solUsd; // $1/TOBE → SOL
  console.log(`  SOL/USD: $${solUsd.toFixed(4)} → expected SOL out ≈ ${expectedSolOut.toFixed(6)} SOL`);

  const pythReceiver = new PythSolanaReceiver({ connection, wallet });
  const builder = pythReceiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([priceUpdateBase64]);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const priceUpdateAccount = getPriceUpdateAccount(SOL_USD_FEED_ID);
    return [
      {
        instruction: await program.methods
          .sellToVault(new anchor.BN(tobeRaw))
          .accounts({
            seller: payer.publicKey,
            mintState: mintStatePda,
            vaultTokenAccount: vaultTokenPda,
            vaultSolReserve: vaultSolReservePda,
            sellerTobe,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
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

  const stateAfter = await program.account.mintState.fetch(mintStatePda);
  const sellerSolAfter = await connection.getBalance(payer.publicKey);
  const vaultSolAfter = await connection.getBalance(vaultSolReservePda);

  console.log("\n=== Verification (audit fix #1 — floor payout works) ===");
  console.log("  vault_sol_reserve drained:", (vaultSolBefore - vaultSolAfter) / 1e9, "SOL");
  console.log("  seller SOL delta (net of fees):", (sellerSolAfter - sellerSolBefore) / 1e9, "SOL");
  console.log("  vault_balance before/after:", state.vaultBalance.toString(), "/", stateAfter.vaultBalance.toString(),
    "(should rise by", tobeRaw, "— bought-back TOBE replenishes the vault)");
  console.log("\n✅ sell_to_vault executed — the floor pays out (was bricked before the fix).");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
