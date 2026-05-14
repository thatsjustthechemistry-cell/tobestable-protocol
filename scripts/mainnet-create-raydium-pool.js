// Mainnet: create Raydium CPMM TOBE/wSOL pool with seed liquidity.
//
// Whoever runs this needs the TOBE mint pubkey (from mainnet-initialize.js
// output) AND some TOBE in their wallet AND some SOL for pool seeding.
//
// For the "pure fair launch" (Decision 2A): the first community minter
// will receive 524,288 TOBE from round 1. They can run this script to
// create the pool with their tokens. Or the founder can coordinate with
// them OTC.
//
// Usage:
//   TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-create-raydium-pool.js \
//     [--seed-tobe 1000] [--seed-sol 0.0191]
//
// Defaults: 1000 TOBE + 0.0191 SOL = round-1-implied price (~$0.0019/TOBE
// at SOL=$190). Tiny seed; real depth comes from flush_lp_to_raydium later.
//
// After this completes, the addresses printed must be recorded on-chain via
// set_pool_config (which requires authority signature — see docs/MAINNET_LAUNCH.md).

const {
  Raydium,
  TxVersion,
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
const os = require("os");
const BN = require("bn.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { seedTobe: 1000, seedSolLamports: 19_100_000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed-tobe') out.seedTobe = parseInt(args[++i], 10);
    else if (args[i] === '--seed-sol') {
      const sol = parseFloat(args[++i]);
      out.seedSolLamports = Math.floor(sol * 1e9);
    }
  }
  return out;
}

async function main() {
  if (!process.env.TOBE_MINT) {
    console.error('❌ Missing TOBE_MINT env var.');
    console.error('   Usage: TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-create-raydium-pool.js');
    process.exit(1);
  }
  const TOBE_MINT = new PublicKey(process.env.TOBE_MINT);

  const { seedTobe, seedSolLamports } = parseArgs();
  const SEED_TOBE_RAW = new BN(seedTobe).mul(new BN("1000000000")); // 9 decimals
  const SEED_SOL_LAMPORTS = new BN(seedSolLamports);

  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
  );

  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: "mainnet",
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
  });

  // Sort token mints lexicographically — Raydium requires token_0 < token_1
  const tobeFirst = TOBE_MINT.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0;
  const mintA = tobeFirst ? TOBE_MINT : NATIVE_MINT;
  const mintB = tobeFirst ? NATIVE_MINT : TOBE_MINT;
  const amountA = tobeFirst ? SEED_TOBE_RAW : SEED_SOL_LAMPORTS;
  const amountB = tobeFirst ? SEED_SOL_LAMPORTS : SEED_TOBE_RAW;

  console.log("=== Mainnet Raydium pool creation ===");
  console.log("Caller wallet:           ", wallet.publicKey.toBase58());
  console.log("TOBE mint:               ", TOBE_MINT.toBase58());
  console.log("wSOL mint:               ", NATIVE_MINT.toBase58());
  console.log("TOBE is token_0 (mintA): ", tobeFirst);
  console.log(`Seed:                    ${seedTobe} TOBE + ${(seedSolLamports / 1e9).toFixed(6)} SOL`);
  console.log();

  const feeConfigs = await raydium.api.getCpmmConfigs();
  feeConfigs.forEach((c) => {
    c.id = getCpmmPdaAmmConfigId(CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58();
  });
  console.log("Using AMM config:", feeConfigs[0].id);

  console.log("\nCreating pool...");
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
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
  console.log("tx:", txId);
  console.log("\n=== Save these for set_pool_config ===");
  console.log("  raydium_pool_state:    ", extInfo.address.poolId.toBase58());
  console.log("  raydium_pool_authority:", extInfo.address.authority.toBase58());
  console.log("  raydium_lp_mint:       ", extInfo.address.lpMint.toBase58());
  console.log("  raydium_token_0_vault: ", extInfo.address.vaultA.toBase58());
  console.log("  raydium_token_1_vault: ", extInfo.address.vaultB.toBase58());
  console.log("  tobe_is_token_0:       ", tobeFirst);

  const out = {
    network: "mainnet",
    poolState: extInfo.address.poolId.toBase58(),
    poolAuthority: extInfo.address.authority.toBase58(),
    lpMint: extInfo.address.lpMint.toBase58(),
    token0Vault: extInfo.address.vaultA.toBase58(),
    token1Vault: extInfo.address.vaultB.toBase58(),
    tobeIsToken0: tobeFirst,
    createdAt: new Date().toISOString(),
    txId,
  };
  fs.writeFileSync(path.join(__dirname, ".mainnet-pool.json"), JSON.stringify(out, null, 2));
  console.log("\nSaved to scripts/.mainnet-pool.json");
  console.log("\nNext: authority (or Realms multisig if already migrated) must call");
  console.log("set_pool_config with these addresses. See docs/MAINNET_LAUNCH.md Step 9.");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
