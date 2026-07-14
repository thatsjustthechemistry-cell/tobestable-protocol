// Mainnet: add liquidity to the TOBE/wSOL Raydium pool from the team wallet's
// own (disclosed, hard-capped) free-mint tokens, then lock the resulting LP
// tokens by depositing them into the SAME lp_lock_vault the protocol's
// auto-flushed LP is locked in.
//
// Why this needs no new program instruction: unlock_lp sweeps out whatever
// the vault's CURRENT balance is at call time (`let vault_balance =
// lp_lock_vault.amount`), not a remembered fixed figure. Depositing into a
// program-owned token account is an ordinary SPL transfer — only the SOURCE
// account's owner signs; the destination's authority has no say. So any LP
// tokens sent here get locked until the exact same mint_state.lp_lock_until
// as everything else, with zero new instructions. Proven in isolation (two
// unrelated signers depositing into a shared vault; final balance = exact
// sum) via a standalone devnet SPL test before this script was written.
//
// HARD PREREQUISITE: lp_lock_vault does not exist until the protocol's own
// lock_lp call creates it (Step 12 in docs/MAINNET_LAUNCH.md, run once by
// the DAO authority after flush_lp_to_raydium). This script checks for that
// and refuses to proceed if the vault isn't there yet — there's no way to
// pre-create it.
//
// Consequence worth knowing: deposited tokens are locked only until whatever
// remains of the ALREADY-RUNNING 2-year clock at deposit time, not a fresh
// 2 years from this script's run.
//
// Usage (dry run by default — shows computed amounts, sends nothing):
//   TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-add-team-lp-and-lock.js \
//     [--tobe 5000000] [--slippage 0.5] [--keypair <path>] [--execute]
//
// --keypair defaults to ~/.config/solana/id.json. Pass the TEAM wallet's
// keypair path explicitly if it differs from your default Solana CLI wallet
// (the deployer wallet and the team wallet are NOT the same key).

const {
  Raydium,
  TxVersion,
} = require("@raydium-io/raydium-sdk-v2");
const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const BN = require("bn.js");
const { Percent } = require("@raydium-io/raydium-sdk-v2");

const PROGRAM_ID = new PublicKey("Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX");
const TEAM_WALLET = "Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    tobe: 5_000_000,
    slippagePct: 0.5,
    keypairPath: path.join(os.homedir(), ".config", "solana", "id.json"),
    execute: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tobe") out.tobe = parseFloat(args[++i]);
    else if (args[i] === "--slippage") out.slippagePct = parseFloat(args[++i]);
    else if (args[i] === "--keypair") out.keypairPath = args[++i];
    else if (args[i] === "--execute") out.execute = true;
  }
  return out;
}

async function confirm(prompt) {
  return new Promise((r) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt + " (yes/no): ", (a) => { rl.close(); r(a.trim().toLowerCase() === "yes"); });
  });
}

async function main() {
  const { tobe, slippagePct, keypairPath, execute } = parseArgs();

  if (!process.env.TOBE_MINT) {
    console.error("❌ Missing TOBE_MINT env var.");
    console.error("   Usage: TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-add-team-lp-and-lock.js");
    process.exit(1);
  }
  const TOBE_MINT = new PublicKey(process.env.TOBE_MINT);

  if (tobe < 5_000_000) {
    console.error(`❌ --tobe ${tobe} is below the intended minimum of 5,000,000.`);
    console.error("   Pass --tobe explicitly if you really mean less.");
    process.exit(1);
  }

  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  if (wallet.publicKey.toBase58() !== TEAM_WALLET) {
    console.warn(`⚠️  Signing wallet ${wallet.publicKey.toBase58()} does NOT match the disclosed`);
    console.warn(`   team wallet ${TEAM_WALLET}. This script isn't restricted to the team wallet —`);
    console.warn(`   anyone can add locked liquidity — but if you meant to use the team wallet,`);
    console.warn(`   pass --keypair <path-to-team-wallet-keypair>.`);
    if (!execute) console.warn("   (dry run — continuing to show computed amounts)");
  }

  const poolPath = path.join(__dirname, ".mainnet-pool.json");
  if (!fs.existsSync(poolPath)) {
    console.error("❌ scripts/.mainnet-pool.json not found — run mainnet-create-raydium-pool.js first.");
    process.exit(1);
  }
  const pool = JSON.parse(fs.readFileSync(poolPath, "utf8"));

  const rpcUrl = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log("RPC:", rpcUrl.includes("api-key=") ? rpcUrl.replace(/api-key=[^&]+/, "api-key=***") : rpcUrl);
  const connection = new Connection(rpcUrl, "confirmed");

  // ── Prerequisite check: lp_lock_vault must already exist (Step 12 already ran) ──
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const [lpLockAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("lp_lock_authority")], PROGRAM_ID);
  const [lpLockVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("lp_lock_vault")], PROGRAM_ID);

  const state = await program.account.mintState.fetch(mintStatePda);
  console.log("\n=== Pre-flight ===");
  console.log("mint_state.lpLocked:     ", state.lpLocked);
  console.log("mint_state.lpMint:       ", state.lpMint.toBase58());
  console.log("mint_state.lpLockUntil:  ", state.lpLocked ? new Date(state.lpLockUntil.toNumber() * 1000).toISOString() : "n/a");
  console.log("Raydium pool lpMint:     ", pool.lpMint);

  if (!state.lpLocked) {
    console.error("\n❌ lp_lock_vault does not exist yet — the DAO authority has not run lock_lp");
    console.error("   (docs/MAINNET_LAUNCH.md Step 12). This must happen first; there is no way");
    console.error("   to pre-create the vault. Nothing has been sent. Try again after Step 12.");
    process.exit(1);
  }
  if (state.lpMint.toBase58() !== pool.lpMint) {
    console.error("\n❌ mint_state.lpMint does not match the pool's LP mint in .mainnet-pool.json.");
    console.error("   Refusing to proceed — this would send tokens of the wrong mint.");
    process.exit(1);
  }

  let vaultAcctExists = true;
  try { await getAccount(connection, lpLockVaultPda); } catch { vaultAcctExists = false; }
  if (!vaultAcctExists) {
    console.error("\n❌ lp_lock_vault PDA has no token account despite lpLocked=true — inconsistent");
    console.error("   on-chain state. Stop and investigate before proceeding.");
    process.exit(1);
  }

  // ── Raydium: compute the paired SOL amount for the requested TOBE amount ──
  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: "mainnet",
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
  });

  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(pool.poolState);
  const baseIn = poolInfo.mintA.address === TOBE_MINT.toBase58();
  if (!baseIn && poolInfo.mintB.address !== TOBE_MINT.toBase58()) {
    console.error("❌ Neither pool side matches TOBE_MINT — wrong pool or wrong mint.");
    process.exit(1);
  }

  const TOBE_RAW = new BN(Math.round(tobe)).mul(new BN("1000000000")); // 9 decimals
  const slippage = new Percent(Math.round(slippagePct * 100), 10_000); // e.g. 0.5% -> 50/10000

  const rpcPoolData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id);
  const { anotherAmount, maxAnotherAmount, liquidity } = raydium.cpmm.computePairAmount({
    poolInfo: {
      ...poolInfo,
      lpAmount: rpcPoolData.lpAmount.toString() / 10 ** poolInfo.lpMint.decimals,
    },
    baseReserve: rpcPoolData.baseReserve,
    quoteReserve: rpcPoolData.quoteReserve,
    slippage,
    baseIn,
    epochInfo: await raydium.fetchEpochInfo(),
    amount: tobe.toString(),
  });

  const solAmount = anotherAmount.amount;
  const solAmountMax = maxAnotherAmount.amount;

  console.log("\n=== Add-liquidity plan ===");
  console.log("Wallet:                  ", wallet.publicKey.toBase58());
  console.log("TOBE in:                 ", tobe.toLocaleString());
  console.log("Paired SOL (est.):       ", (Number(solAmount.toString()) / 1e9).toFixed(6));
  console.log("Paired SOL (max w/slip): ", (Number(solAmountMax.toString()) / 1e9).toFixed(6));
  console.log("Slippage:                ", slippagePct + "%");
  console.log("LP tokens (est.):        ", liquidity.toString());

  const walletSolBalance = await connection.getBalance(wallet.publicKey);
  console.log("Wallet SOL balance:      ", (walletSolBalance / 1e9).toFixed(6));
  if (walletSolBalance < Number(solAmountMax.toString()) + 0.01 * 1e9) {
    console.error("\n❌ Insufficient SOL for the paired deposit + fees.");
    process.exit(1);
  }

  const lpMintPk = new PublicKey(pool.lpMint);
  const walletLpAta = getAssociatedTokenAddressSync(lpMintPk, wallet.publicKey);
  let lpBalanceBefore = new BN(0);
  try {
    const acct = await getAccount(connection, walletLpAta);
    lpBalanceBefore = new BN(acct.amount.toString());
  } catch { /* ATA doesn't exist yet — starts at 0, fine */ }
  console.log("Wallet LP balance before:", lpBalanceBefore.toString());

  if (!execute) {
    console.log("\n(dry run — pass --execute to actually send the add-liquidity + lock transactions)");
    return;
  }

  console.log("\n=== EXECUTING ON MAINNET — REAL FUNDS ===");
  const ok = await confirm(
    `Send ${tobe.toLocaleString()} TOBE + ~${(Number(solAmount.toString()) / 1e9).toFixed(6)} SOL as liquidity,\n` +
    `then transfer the resulting LP tokens into the 2-year lock vault. Proceed?`
  );
  if (!ok) { console.log("Aborted."); return; }

  console.log("\nAdding liquidity...");
  const { execute: executeAdd } = await raydium.cpmm.addLiquidity({
    poolInfo,
    poolKeys,
    inputAmount: TOBE_RAW,
    baseIn,
    slippage,
    txVersion: TxVersion.V0,
  });
  const { txId: addTxId } = await executeAdd({ sendAndConfirm: true });
  console.log("✅ Liquidity added. tx:", addTxId);

  const acctAfter = await getAccount(connection, walletLpAta);
  const lpBalanceAfter = new BN(acctAfter.amount.toString());
  const newLpAmount = lpBalanceAfter.sub(lpBalanceBefore);
  console.log("New LP tokens received:  ", newLpAmount.toString());

  if (newLpAmount.lten(0)) {
    console.error("❌ No new LP tokens detected — something's wrong. NOT sending a lock transfer.");
    process.exit(1);
  }

  console.log("\nLocking the new LP tokens (transfer into lp_lock_vault)...");
  const transferIx = createTransferInstruction(
    walletLpAta,
    lpLockVaultPda,
    wallet.publicKey,
    BigInt(newLpAmount.toString()),
    [],
    TOKEN_PROGRAM_ID
  );
  const tx = new Transaction().add(transferIx);
  const lockTxId = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("✅ Locked. tx:", lockTxId);

  const finalVault = await getAccount(connection, lpLockVaultPda);
  console.log("\n=== Done ===");
  console.log("lp_lock_vault total balance now:", finalVault.amount.toString());
  console.log("Unlocks at:                      ", new Date(state.lpLockUntil.toNumber() * 1000).toISOString());
  console.log("(same unlock date as the protocol's auto-flushed LP — this deposit did not");
  console.log(" start its own fresh 2-year clock, it joined the one already running)");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
