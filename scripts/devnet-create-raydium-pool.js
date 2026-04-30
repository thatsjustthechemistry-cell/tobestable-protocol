// Devnet: create Raydium CPMM TOBE/wSOL pool with seed liquidity from authority's wallet.
// After this completes, call set_pool_config with the printed addresses.
//
// Run: node scripts/devnet-create-raydium-pool.js

const {
  Raydium,
  TxVersion,
  DEVNET_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  getCpmmPdaAmmConfigId,
} = require("@raydium-io/raydium-sdk-v2");
const {
  Connection,
  Keypair,
  PublicKey,
} = require("@solana/web3.js");
const { NATIVE_MINT } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const BN = require("bn.js");

const TOBE_MINT = new PublicKey("4fFD96LWnsgCiWMtLJym12k7xLofH6FdSDtr5MgyYmHV");

// Seed amounts — set initial pool price ≈ round 1 implied price (1.9e-5 SOL/TOBE)
// 1000 TOBE (with 9 decimals) + 19_100_000 lamports (0.0191 SOL)
const SEED_TOBE_RAW = new BN(1000).mul(new BN("1000000000")); // 1000 * 10^9
const SEED_SOL_LAMPORTS = new BN(19_100_000);                 // 0.0191 SOL

async function main() {
  const keypairPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".config",
    "solana",
    "id.json",
  );
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
  );

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: "devnet",
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
  });

  const cpmmProgramId = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
  const cpmmFeeAccount = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC;

  // Sort token mints lexicographically — Raydium requires token_0 < token_1
  const tobeFirst = TOBE_MINT.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0;
  const mintA = tobeFirst ? TOBE_MINT : NATIVE_MINT;
  const mintB = tobeFirst ? NATIVE_MINT : TOBE_MINT;
  const amountA = tobeFirst ? SEED_TOBE_RAW : SEED_SOL_LAMPORTS;
  const amountB = tobeFirst ? SEED_SOL_LAMPORTS : SEED_TOBE_RAW;

  console.log("Authority:", wallet.publicKey.toBase58());
  console.log("TOBE mint:", TOBE_MINT.toBase58());
  console.log("wSOL mint:", NATIVE_MINT.toBase58());
  console.log("TOBE is token_0 (mintA):", tobeFirst);
  console.log(
    `Seed: ${SEED_TOBE_RAW.div(new BN("1000000000")).toString()} TOBE + ${SEED_SOL_LAMPORTS.toString()} lamports`,
  );

  // Use AMM config 0 (default fee tier on devnet)
  const feeConfigs = await raydium.api.getCpmmConfigs();
  // On devnet, swap with derived config IDs
  feeConfigs.forEach((c) => {
    c.id = getCpmmPdaAmmConfigId(cpmmProgramId, c.index).publicKey.toBase58();
  });
  console.log("Using AMM config:", feeConfigs[0].id);

  console.log("\nCreating pool...");
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: cpmmProgramId,
    poolFeeAccount: cpmmFeeAccount,
    mintA: { address: mintA.toBase58(), decimals: 9, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    mintB: { address: mintB.toBase58(), decimals: 9, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    mintAAmount: amountA,
    mintBAmount: amountB,
    startTime: new BN(0),
    feeConfig: feeConfigs[0],
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log("✅ Pool created");
  console.log("Tx:", txId);
  console.log("\n=== Save these for set_pool_config ===");
  console.log("  raydium_pool_state:    ", extInfo.address.poolId.toBase58());
  console.log("  raydium_pool_authority:", extInfo.address.authority.toBase58());
  console.log("  raydium_lp_mint:       ", extInfo.address.lpMint.toBase58());
  console.log("  raydium_token_0_vault: ", extInfo.address.vaultA.toBase58());
  console.log("  raydium_token_1_vault: ", extInfo.address.vaultB.toBase58());
  console.log("  tobe_is_token_0:       ", tobeFirst);

  // Save to a JSON file for the next script
  const out = {
    poolState: extInfo.address.poolId.toBase58(),
    poolAuthority: extInfo.address.authority.toBase58(),
    lpMint: extInfo.address.lpMint.toBase58(),
    token0Vault: extInfo.address.vaultA.toBase58(),
    token1Vault: extInfo.address.vaultB.toBase58(),
    tobeIsToken0: tobeFirst,
    createdAt: new Date().toISOString(),
    txId,
  };
  fs.writeFileSync(path.join(__dirname, ".devnet-pool.json"), JSON.stringify(out, null, 2));
  console.log("\nSaved to scripts/.devnet-pool.json");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
