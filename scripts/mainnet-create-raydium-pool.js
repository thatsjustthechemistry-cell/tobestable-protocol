// Mainnet: create Raydium CPMM TOBE/wSOL pool with seed liquidity.
//
// Whoever runs this needs the TOBE mint pubkey (from mainnet-initialize.js
// output) AND some TOBE in their wallet AND some SOL for pool seeding.
//
// PLAN OF RECORD: the team creates this pool. Eis6 free-mints (disclosed team
// allocation) and seeds the pool with part of that TOBE. `--keypair` exists
// because Eis6 is NOT the default solana CLI wallet — see below.
//
// Usage:
//   TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-create-raydium-pool.js \
//     [--keypair <path>] [--seed-tobe 1000] [--seed-sol 0.0191] [--yes]
//
// --keypair  Signer keypair file. Defaults to ~/.config/solana/id.json (the
//            DEPLOY wallet). If seeding from Eis6 or any other wallet, pass its
//            keypair explicitly — the default will otherwise silently create the
//            pool from the wrong account.
// --yes      Skip the confirmation pause. Omit it the first time.
//
// SEED RATIO — keep it honest. The default (1000 TOBE + 0.0191 SOL) is exactly
// what a round-1 minter pays: 10 SOL / 524,288 TOBE. Seeding BIGGER is good
// (deeper pool) but hold the ratio, or you move the opening price. Seeding above
// it prices team-allocated tokens higher than minters paid — visible on-chain
// forever. This script warns if the implied price deviates.
//
//   0.5 SOL ->  26,214 TOBE      5 SOL -> 262,144 TOBE
//     1 SOL ->  52,429 TOBE     10 SOL -> 524,288 TOBE (all of round 1)
//
// 🔥 AFTER THIS RUNS: burn the seed LP. flush_lp_to_raydium burns only the
// PROTOCOL's LP, never the pool creator's. Left alone you hold a withdrawable
// liquidity position while the launch thread claims none exists. This script
// prints the exact `spl-token burn` command when it finishes.
//
// RPC: defaults to the public api.mainnet-beta.solana.com, which can be
// rate-limit-prone. Override with a dedicated endpoint if needed:
//   MAINNET_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<KEY>" \
//     TOBE_MINT=<...> node scripts/mainnet-create-raydium-pool.js
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

// Round-1 implied price: a minter pays 10 SOL for 524,288 TOBE.
// Seeding at this ratio means the pool opens at exactly what minters paid.
const ROUND1_SOL_PER_TOBE = 10 / 524_288;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    seedTobe: 1000,
    seedSolLamports: 19_100_000,
    keypair: null,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed-tobe') out.seedTobe = parseInt(args[++i], 10);
    else if (args[i] === '--seed-sol') {
      const sol = parseFloat(args[++i]);
      out.seedSolLamports = Math.floor(sol * 1e9);
    }
    else if (args[i] === '--keypair') out.keypair = args[++i];
    else if (args[i] === '--yes' || args[i] === '-y') out.yes = true;
  }
  return out;
}

function loadKeypair(explicitPath) {
  // Explicit --keypair wins. Otherwise fall back to the solana CLI default,
  // which is the DEPLOY wallet — correct for some runs, wrong for others, so
  // the resolved path is always printed below.
  const resolved = explicitPath
    ? path.resolve(explicitPath.trim())   // config output can carry a trailing space
    : path.join(os.homedir(), ".config/solana/id.json");

  if (!fs.existsSync(resolved)) {
    console.error(`❌ Keypair not found: ${resolved}`);
    if (!explicitPath) {
      console.error('   The default is the DEPLOY wallet. To seed from another');
      console.error('   wallet (e.g. Eis6), pass --keypair <path> explicitly.');
      console.error('   Note: a wallet that exists only as a browser seed phrase');
      console.error('   has no keypair file — export it, or use the Raydium web UI.');
    }
    process.exit(1);
  }
  return {
    keypair: Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8")))
    ),
    path: resolved,
    wasExplicit: Boolean(explicitPath),
  };
}

async function tokenBalance(connection, owner, mint) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let raw = 0n;
  let account = null;
  for (const { pubkey, account: acc } of res.value) {
    const amt = BigInt(acc.data.parsed.info.tokenAmount.amount);
    if (amt > raw) { raw = amt; account = pubkey; }
  }
  return { raw, account };
}

async function main() {
  if (!process.env.TOBE_MINT) {
    console.error('❌ Missing TOBE_MINT env var.');
    console.error('   Usage: TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-create-raydium-pool.js');
    process.exit(1);
  }
  const TOBE_MINT = new PublicKey(process.env.TOBE_MINT);

  const { seedTobe, seedSolLamports, keypair: keypairArg, yes } = parseArgs();
  const SEED_TOBE_RAW = new BN(seedTobe).mul(new BN("1000000000")); // 9 decimals
  const SEED_SOL_LAMPORTS = new BN(seedSolLamports);

  const { keypair: wallet, path: keypairPath, wasExplicit } = loadKeypair(keypairArg);

  // The public RPC is rate-limit-prone under real load (hit repeatedly during
  // devnet governance testing). Override with a dedicated mainnet endpoint,
  // e.g. MAINNET_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<KEY>".
  const rpcUrl = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log("RPC:", rpcUrl.includes("api-key=") ? rpcUrl.replace(/api-key=[^&]+/, "api-key=***") : rpcUrl);
  const connection = new Connection(rpcUrl, "confirmed");

  // Sort token mints lexicographically — Raydium requires token_0 < token_1
  const tobeFirst = TOBE_MINT.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0;
  const mintA = tobeFirst ? TOBE_MINT : NATIVE_MINT;
  const mintB = tobeFirst ? NATIVE_MINT : TOBE_MINT;
  const amountA = tobeFirst ? SEED_TOBE_RAW : SEED_SOL_LAMPORTS;
  const amountB = tobeFirst ? SEED_SOL_LAMPORTS : SEED_TOBE_RAW;

  const seedSol = seedSolLamports / 1e9;

  console.log("=== Mainnet Raydium pool creation ===");
  console.log("Signer keypair:          ", keypairPath, wasExplicit ? "(--keypair)" : "(DEFAULT — deploy wallet)");
  console.log("Caller wallet:           ", wallet.publicKey.toBase58());
  console.log("TOBE mint:               ", TOBE_MINT.toBase58());
  console.log("wSOL mint:               ", NATIVE_MINT.toBase58());
  console.log("TOBE is token_0 (mintA): ", tobeFirst);
  console.log(`Seed:                    ${seedTobe} TOBE + ${seedSol.toFixed(6)} SOL`);

  // ── Opening-price check ────────────────────────────────────────────────────
  // The seed ratio IS the opening price. Above round-1-implied means team
  // tokens are being priced higher than minters paid — the one version of this
  // that reads badly, and it is on-chain forever.
  const impliedSolPerTobe = seedSol / seedTobe;
  const deviationPct = ((impliedSolPerTobe / ROUND1_SOL_PER_TOBE) - 1) * 100;
  console.log(`Implied price:           ${impliedSolPerTobe.toExponential(6)} SOL/TOBE`);
  console.log(`Round-1 minter price:    ${ROUND1_SOL_PER_TOBE.toExponential(6)} SOL/TOBE`);
  if (Math.abs(deviationPct) < 1) {
    console.log("                         ✅ matches what round-1 minters paid");
  } else if (deviationPct > 0) {
    console.log(`                         🔴 ${deviationPct.toFixed(1)}% ABOVE what minters paid`);
    console.log("                         This prices your tokens higher than the public.");
    console.log(`                         For ${seedSol} SOL, pair ${Math.round(seedSol / ROUND1_SOL_PER_TOBE).toLocaleString('en-US')} TOBE instead.`);
  } else {
    console.log(`                         ⚠️  ${Math.abs(deviationPct).toFixed(1)}% BELOW what minters paid`);
    console.log("                         Not dishonest, but you are giving away value.");
    console.log(`                         For ${seedSol} SOL, pair ${Math.round(seedSol / ROUND1_SOL_PER_TOBE).toLocaleString('en-US')} TOBE for parity.`);
  }
  console.log();

  // ── Pre-flight balances ────────────────────────────────────────────────────
  // Fail here with a readable message rather than deep inside the Raydium SDK.
  const solBal = await connection.getBalance(wallet.publicKey);
  const { raw: tobeRaw } = await tokenBalance(connection, wallet.publicKey, TOBE_MINT);
  const needTobe = BigInt(SEED_TOBE_RAW.toString());
  // Raydium's CPMM pool-creation fee + account rent + tx fees, over the seed.
  const HEADROOM_LAMPORTS = 250_000_000; // 0.25 SOL
  const needSol = BigInt(seedSolLamports) + BigInt(HEADROOM_LAMPORTS);

  console.log("Balances:");
  console.log(`  SOL:  ${(solBal / 1e9).toFixed(6)}  (need ~${(Number(needSol) / 1e9).toFixed(3)} incl. pool fee + rent)`);
  console.log(`  TOBE: ${(Number(tobeRaw) / 1e9).toLocaleString('en-US')}  (need ${seedTobe.toLocaleString('en-US')})`);

  let fatal = false;
  if (tobeRaw < needTobe) {
    console.error(`\n❌ Not enough TOBE. Have ${(Number(tobeRaw) / 1e9).toLocaleString('en-US')}, need ${seedTobe.toLocaleString('en-US')}.`);
    console.error('   Is this the right wallet? The team seed comes from the free-mint');
    console.error('   wallet (Eis6) — pass it with --keypair.');
    fatal = true;
  }
  if (BigInt(solBal) < needSol) {
    console.error(`\n❌ Not enough SOL. Have ${(solBal / 1e9).toFixed(6)}, need ~${(Number(needSol) / 1e9).toFixed(3)}.`);
    console.error('   That covers the seed itself plus the Raydium pool-creation fee,');
    console.error('   vault/LP account rent, and tx fees.');
    fatal = true;
  }
  if (fatal) process.exit(1);

  if (!yes) {
    console.log("\n⏸️  This creates a REAL mainnet pool and spends REAL SOL.");
    console.log("   The pool you create here is the one set_pool_config records —");
    console.log("   and that write is ONE-WAY (docs/LAUNCH_PHASES.md Phase 4).");
    console.log("   Re-run with --yes to proceed.");
    process.exit(0);
  }

  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: "mainnet",
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
  });

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

  const lpMint = new PublicKey(extInfo.address.lpMint.toBase58());
  const out = {
    network: "mainnet",
    poolState: extInfo.address.poolId.toBase58(),
    poolAuthority: extInfo.address.authority.toBase58(),
    lpMint: lpMint.toBase58(),
    token0Vault: extInfo.address.vaultA.toBase58(),
    token1Vault: extInfo.address.vaultB.toBase58(),
    tobeIsToken0: tobeFirst,
    createdBy: wallet.publicKey.toBase58(),
    seedTobe,
    seedSol,
    createdAt: new Date().toISOString(),
    txId,
  };

  // ── Seed LP: locate it and print the burn command ──────────────────────────
  // flush_lp_to_raydium burns the PROTOCOL's LP only. The seed LP is the
  // creator's, and holding it means holding a withdrawable liquidity position.
  console.log("\n🔥 === BURN THE SEED LP — do not skip ===");
  try {
    // The pool tx may take a moment to index before the LP account is visible.
    let lp = { raw: 0n, account: null };
    for (let i = 0; i < 5 && lp.raw === 0n; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      lp = await tokenBalance(connection, wallet.publicKey, lpMint);
    }
    if (lp.account) {
      out.lpTokenAccount = lp.account.toBase58();
      out.lpAmountRaw = lp.raw.toString();
      console.log("  Your LP account:", lp.account.toBase58());
      console.log("  LP balance:      ", (Number(lp.raw) / 1e9).toFixed(9));
      console.log("\n  Run this now, then keep the signature:");
      console.log(`    spl-token burn ${lp.account.toBase58()} ${(Number(lp.raw) / 1e9)} \\`);
      console.log(`      --owner ${keypairPath}`);
    } else {
      console.log("  ⚠️  Could not locate the LP account automatically (indexing lag).");
      console.log(`  Find it with:  spl-token accounts --owner ${wallet.publicKey.toBase58()}`);
      console.log(`  LP mint:       ${lpMint.toBase58()}`);
      console.log("  Then: spl-token burn <LP_ACCOUNT> <AMOUNT>");
    }
  } catch (e) {
    console.log("  ⚠️  LP lookup failed:", e.message);
    console.log(`  Find it manually — LP mint: ${lpMint.toBase58()}`);
  }
  console.log("\n  Why: flush_lp_to_raydium burns only the PROTOCOL's LP, never yours.");
  console.log("  Unburned, you hold a withdrawable position while the launch thread");
  console.log("  says no LP exists in anyone's wallet. See");
  console.log("  tobe-mint/docs/launch-thread-postable.md.");

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
