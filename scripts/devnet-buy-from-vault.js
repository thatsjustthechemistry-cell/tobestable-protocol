// Devnet test: buy_from_vault with real Pyth SOL/USD price.
//
// Run: node scripts/devnet-buy-from-vault.js [SOL_AMOUNT]
//   default: 0.01 SOL → ~0.83 TOBE at $83/SOL
//
// Flow (per Pyth pull-oracle pattern):
//   1. Fetch latest SOL/USD price update from Hermes
//   2. Build a versioned tx that:
//      a. Posts the price update via the Pyth Solana Receiver program
//      b. Calls buy_from_vault with the freshly-posted PriceUpdateV2 account
//      c. Closes the price update account (refunds rent to caller)
//   3. Send and confirm

const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const splToken = require("@solana/spl-token");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

const PROGRAM_ID = new PublicKey("CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ");
const SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

async function main() {
  const solAmount = parseFloat(process.argv[2] || "0.01");
  const lamports = Math.floor(solAmount * 1e9);

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
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"),
  );
  const program = new anchor.Program(idl, provider);

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

  const state = await program.account.mintState.fetch(mintStatePda);
  console.log("Buyer:        ", payer.publicKey.toBase58());
  console.log("TOBE mint:    ", state.tobeMint.toBase58());
  console.log("Treasury:     ", state.treasury.toBase58());
  console.log("Vault TOBE:   ", state.vaultBalance.toString());
  console.log("Sending:      ", solAmount, "SOL =", lamports, "lamports");

  // Need a TOBE account for the buyer (can be same wallet)
  const buyerTobeKp = Keypair.generate();
  const ACCOUNT_SIZE = 165;
  const accountRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const splIxs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: buyerTobeKp.publicKey,
      space: ACCOUNT_SIZE,
      lamports: accountRent,
      programId: TOKEN_PROGRAM_ID,
    }),
    splToken.createInitializeAccountInstruction(
      buyerTobeKp.publicKey,
      state.tobeMint,
      payer.publicKey,
      TOKEN_PROGRAM_ID,
    ),
  ];
  const { Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...splIxs),
    [payer, buyerTobeKp],
  );
  console.log("Buyer TOBE acct:", buyerTobeKp.publicKey.toBase58());

  // Fetch fresh price update from Hermes
  console.log("\nFetching SOL/USD from Hermes...");
  const hermesRes = await fetch(
    `${HERMES_URL}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64`,
  );
  const hermesData = await hermesRes.json();
  const priceUpdateBase64 = hermesData.binary.data[0];
  const parsed = hermesData.parsed[0].price;
  const livePrice = (Number(parsed.price) * Math.pow(10, parsed.expo)).toFixed(4);
  console.log(`  Live SOL/USD: $${livePrice} (raw=${parsed.price}, expo=${parsed.expo})`);
  const expectedTobe = (lamports * Number(parsed.price)) / Math.pow(10, -parsed.expo);
  console.log(`  Expected TOBE out: ~${(expectedTobe / 1e9).toFixed(6)} TOBE`);

  // Build the Pyth-posted-update + buy_from_vault tx
  const pythReceiver = new PythSolanaReceiver({ connection, wallet });
  const builder = pythReceiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });
  await builder.addPostPriceUpdates([priceUpdateBase64]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const priceUpdateAccount = getPriceUpdateAccount(SOL_USD_FEED_ID);
    return [
      {
        instruction: await program.methods
          .buyFromVault(new anchor.BN(lamports))
          .accounts({
            buyer: payer.publicKey,
            mintState: mintStatePda,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount: vaultTokenPda,
            treasury: state.treasury,
            founder: state.founder, // 50% founder split
            // F2 price gate: buy_from_vault now requires TOBE >= $1, derived from
            // these pool reserves x Pyth (same inputs arm_floor uses).
            raydiumToken0Vault: state.raydiumToken0Vault,
            raydiumToken1Vault: state.raydiumToken1Vault,
            buyerTobe: buyerTobeKp.publicKey,
            pythPriceUpdate: priceUpdateAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        signers: [],
      },
    ];
  });

  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50000,
  });
  console.log(`\nSending ${txs.length} tx(s)...`);
  const sigs = await pythReceiver.provider.sendAll(txs, { skipPreflight: false });
  for (const s of sigs) console.log("  tx:", s);

  // Verify
  const stateAfter = await program.account.mintState.fetch(mintStatePda);
  const buyerAcct = await splToken.getAccount(
    connection,
    buyerTobeKp.publicKey,
    "confirmed",
    TOKEN_PROGRAM_ID,
  );
  const treasuryBalance = await connection.getBalance(state.treasury);

  console.log("\n=== Verification ===");
  console.log("  Vault TOBE before:", state.vaultBalance.toString());
  console.log("  Vault TOBE after: ", stateAfter.vaultBalance.toString());
  console.log("  Vault TOBE delta: -", BigInt(state.vaultBalance.toString()) - BigInt(stateAfter.vaultBalance.toString()));
  console.log("  Buyer received:    ", buyerAcct.amount.toString(), "TOBE raw");
  console.log("  Treasury balance:  ", treasuryBalance, "lamports");
  console.log("\n✅ buy_from_vault verified on devnet with real Pyth SOL/USD");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
