// Mainnet: team wallet adds liquidity to the TOBE/wSOL Raydium pool from its
// own (disclosed, hard-capped) free-mint tokens, and locks the resulting LP
// for 2 years.
//
// IMPORTANT — how this actually works (corrected after an earlier wrong
// assumption): flush_lp_to_raydium BURNS its LP permanently in the same
// instruction (see MAINNET_LAUNCH.md Step 10) — it does NOT feed lock_lp.
// There is no "official" lock_lp call anywhere in the normal launch flow.
// lock_lp is a standalone, authority-gated, ONE-SHOT instruction
// (`require!(!mint_state.lp_locked)`) that nobody else calls. This script
// IS what creates and locks that vault, deliberately, using the team's own
// LP — it is not piggybacking on a protocol step that happens anyway.
//
// Two modes, auto-detected from on-chain state:
//
//   FIRST RUN (mint_state.lp_locked == false): this is the one-shot lock_lp
//   call. Needs BOTH the team wallet (source of the LP) and the CURRENT
//   `mint_state.authority` signer (lock_lp requires `authority_lp_account`
//   to be OWNED BY the authority pubkey — the team wallet cannot call
//   lock_lp with tokens sitting in its own account). Do this BEFORE Step 4
//   (authority handoff to the DAO) in MAINNET_LAUNCH.md — after handoff,
//   `authority` is a DAO governance PDA and this becomes a Realms proposal
//   instead of a script.
//
//   TOP-UP RUN (mint_state.lp_locked == true, i.e. this script already ran
//   once): no authority needed at all. Depositing into a program-owned
//   token account is an ordinary SPL transfer — only the source account's
//   owner signs. unlock_lp sweeps whatever the vault's balance is AT CALL
//   TIME (`let vault_balance = lp_lock_vault.amount`), not a remembered
//   figure, so anything sent here later joins the same lock automatically.
//   Proven in isolation on devnet before this script was written: two
//   unrelated keypairs, neither controlling the vault's authority,
//   deposited 1,000 and 5,000,000 tokens of a throwaway mint into a shared
//   vault; final balance was the exact sum (5,001,000).
//
// Consequence worth knowing either way: tokens are locked only until
// whatever remains of the 2-year clock (started at the FIRST lock_lp call),
// not a fresh 2 years from whenever you add more.
//
// Usage (dry run by default — computes amounts, sends nothing):
//   TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-team-lp-and-lock.js \
//     --tobe <amount> [--slippage 0.5] \
//     [--team-keypair <path>] [--authority-keypair <path>] [--execute]
//
// No fixed minimum --tobe — the dry run always shows the exact paired SOL
// cost (which moves with SOL's price) before you commit anything.
//
// --team-keypair defaults to ~/.config/solana/id.json (override if the team
// wallet's key lives elsewhere). --authority-keypair is only required on the
// FIRST run, and only if it differs from --team-keypair.

const {
  Raydium,
  TxVersion,
  Percent,
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
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const BN = require("bn.js");

const PROGRAM_ID = new PublicKey("Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX");
const TEAM_WALLET = "Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    tobe: null,
    slippagePct: 0.5,
    teamKeypairPath: path.join(os.homedir(), ".config", "solana", "id.json"),
    authorityKeypairPath: null,
    execute: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tobe") out.tobe = parseFloat(args[++i]);
    else if (args[i] === "--slippage") out.slippagePct = parseFloat(args[++i]);
    else if (args[i] === "--team-keypair") out.teamKeypairPath = args[++i];
    else if (args[i] === "--authority-keypair") out.authorityKeypairPath = args[++i];
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

function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const { tobe, slippagePct, teamKeypairPath, authorityKeypairPath, execute } = parseArgs();

  if (!process.env.TOBE_MINT) {
    console.error("❌ Missing TOBE_MINT env var.");
    console.error("   Usage: TOBE_MINT=<MAINNET_MINT_PUBKEY> node scripts/mainnet-team-lp-and-lock.js");
    process.exit(1);
  }
  const TOBE_MINT = new PublicKey(process.env.TOBE_MINT);

  if (!tobe || tobe <= 0) {
    console.error("❌ Missing --tobe <amount>. No default — pick a token amount that fits your actual SOL budget");
    console.error("   (the dry run below will show the exact paired SOL cost at the current pool price before");
    console.error("   you commit to anything — re-run with a smaller --tobe if it's more than you want to spend).");
    process.exit(1);
  }

  const teamWallet = loadKeypair(teamKeypairPath);
  if (teamWallet.publicKey.toBase58() !== TEAM_WALLET) {
    console.warn(`⚠️  --team-keypair (${teamWallet.publicKey.toBase58()}) does not match the disclosed`);
    console.warn(`   team wallet ${TEAM_WALLET}. Continuing anyway — this isn't restricted, but check you meant this key.`);
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

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(teamWallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const [lpLockAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("lp_lock_authority")], PROGRAM_ID);
  const [lpLockVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("lp_lock_vault")], PROGRAM_ID);

  const state = await program.account.mintState.fetch(mintStatePda);
  const isFirstRun = !state.lpLocked;

  console.log("\n=== Pre-flight ===");
  console.log("Mode:                    ", isFirstRun ? "FIRST RUN (one-shot lock_lp)" : "TOP-UP (vault already exists)");
  console.log("mint_state.authority:    ", state.authority.toBase58());
  console.log("mint_state.lpLocked:     ", state.lpLocked);
  if (state.lpLocked) {
    console.log("mint_state.lpMint:       ", state.lpMint.toBase58());
    console.log("mint_state.lpLockUntil: ", new Date(state.lpLockUntil.toNumber() * 1000).toISOString());
    if (state.lpMint.toBase58() !== pool.lpMint) {
      console.error("\n❌ mint_state.lpMint doesn't match .mainnet-pool.json's LP mint. Refusing — wrong pool.");
      process.exit(1);
    }
  }

  let authorityWallet = null;
  if (isFirstRun) {
    const authPath = authorityKeypairPath || teamKeypairPath;
    authorityWallet = loadKeypair(authPath);
    if (authorityWallet.publicKey.toBase58() !== state.authority.toBase58()) {
      console.error(`\n❌ First run requires the CURRENT mint_state.authority (${state.authority.toBase58()})`);
      console.error(`   as a signer — lock_lp's authority_lp_account must be owned by authority.`);
      console.error(`   Got ${authorityWallet.publicKey.toBase58()} instead. Pass --authority-keypair <path>.`);
      console.error(`   NOTE: if authority has already been handed to the DAO (Step 4/5 done), this`);
      console.error(`   single-signer path no longer applies — it becomes a Realms governance proposal.`);
      process.exit(1);
    }
  }

  // ── Raydium: compute the paired SOL amount for the requested TOBE amount ──
  const raydium = await Raydium.load({
    connection,
    owner: teamWallet,
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

  const TOBE_RAW = new BN(Math.round(tobe)).mul(new BN("1000000000"));
  const slippage = new Percent(Math.round(slippagePct * 100), 10_000);

  const rpcPoolData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id);
  const { anotherAmount, maxAnotherAmount, liquidity } = raydium.cpmm.computePairAmount({
    poolInfo: { ...poolInfo, lpAmount: rpcPoolData.lpAmount.toString() / 10 ** poolInfo.lpMint.decimals },
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
  console.log("Team wallet:             ", teamWallet.publicKey.toBase58());
  console.log("TOBE in:                 ", tobe.toLocaleString());
  console.log("Paired SOL (est.):       ", (Number(solAmount.toString()) / 1e9).toFixed(6));
  console.log("Paired SOL (max w/slip): ", (Number(solAmountMax.toString()) / 1e9).toFixed(6));
  console.log("LP tokens (est.):        ", liquidity.toString());

  const teamSolBalance = await connection.getBalance(teamWallet.publicKey);
  console.log("Team wallet SOL balance: ", (teamSolBalance / 1e9).toFixed(6));
  if (teamSolBalance < Number(solAmountMax.toString()) + 0.02 * 1e9) {
    console.error("\n❌ Insufficient SOL in team wallet for the paired deposit + fees.");
    process.exit(1);
  }

  const lpMintPk = new PublicKey(pool.lpMint);
  const teamLpAta = getAssociatedTokenAddressSync(lpMintPk, teamWallet.publicKey);
  let lpBalanceBefore = new BN(0);
  try { lpBalanceBefore = new BN((await getAccount(connection, teamLpAta)).amount.toString()); } catch { /* 0 */ }
  console.log("Team LP balance before:  ", lpBalanceBefore.toString());

  if (!execute) {
    console.log(`\n(dry run — pass --execute to actually run the ${isFirstRun ? "add-liquidity + lock_lp" : "add-liquidity + vault deposit"} transactions)`);
    return;
  }

  console.log("\n=== EXECUTING ON MAINNET — REAL FUNDS ===");
  const ok = await confirm(
    `Send ${tobe.toLocaleString()} TOBE + ~${(Number(solAmount.toString()) / 1e9).toFixed(6)} SOL as liquidity, then ` +
    `${isFirstRun ? "call the one-shot lock_lp (2-year lock starts now)" : "deposit the resulting LP into the existing 2-year lock vault"}. Proceed?`
  );
  if (!ok) { console.log("Aborted."); return; }

  console.log("\nAdding liquidity...");
  const { execute: executeAdd } = await raydium.cpmm.addLiquidity({
    poolInfo, poolKeys, inputAmount: TOBE_RAW, baseIn, slippage, txVersion: TxVersion.V0,
  });
  const { txId: addTxId } = await executeAdd({ sendAndConfirm: true });
  console.log("✅ Liquidity added. tx:", addTxId);

  const lpBalanceAfter = new BN((await getAccount(connection, teamLpAta)).amount.toString());
  const newLpAmount = lpBalanceAfter.sub(lpBalanceBefore);
  console.log("New LP tokens received:  ", newLpAmount.toString());
  if (newLpAmount.lten(0)) {
    console.error("❌ No new LP tokens detected — stopping before touching the lock.");
    process.exit(1);
  }

  if (isFirstRun) {
    console.log("\nTransferring new LP to the authority's LP account...");
    const authorityLpAccount = await getOrCreateAssociatedTokenAccount(
      connection, authorityWallet, lpMintPk, authorityWallet.publicKey
    );
    if (authorityWallet.publicKey.toBase58() !== teamWallet.publicKey.toBase58()) {
      const xferIx = createTransferInstruction(
        teamLpAta, authorityLpAccount.address, teamWallet.publicKey,
        BigInt(newLpAmount.toString()), [], TOKEN_PROGRAM_ID
      );
      const xferTx = new Transaction().add(xferIx);
      const xferSig = await sendAndConfirmTransaction(connection, xferTx, [teamWallet]);
      console.log("✅ Transferred to authority. tx:", xferSig);
    } else {
      console.log("   (team wallet IS the authority — LP already in the right account)");
    }

    console.log("\nCalling lock_lp (one-shot, creates the vault, starts the 2-year clock)...");
    const lockTx = await program.methods
      .lockLp(new anchor.BN(newLpAmount.toString()))
      .accounts({
        authority: authorityWallet.publicKey,
        mintState: mintStatePda,
        lpMint: lpMintPk,
        lpLockAuthority: lpLockAuthorityPda,
        lpLockVault: lpLockVaultPda,
        authorityLpAccount: authorityLpAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers(authorityWallet.publicKey.equals(teamWallet.publicKey) ? [] : [authorityWallet])
      .rpc();
    console.log("✅ Locked. tx:", lockTx);
  } else {
    console.log("\nDepositing new LP directly into the existing lock vault (no authority needed)...");
    const depositIx = createTransferInstruction(
      teamLpAta, lpLockVaultPda, teamWallet.publicKey,
      BigInt(newLpAmount.toString()), [], TOKEN_PROGRAM_ID
    );
    const depositTx = new Transaction().add(depositIx);
    const depositSig = await sendAndConfirmTransaction(connection, depositTx, [teamWallet]);
    console.log("✅ Deposited into vault. tx:", depositSig);
  }

  const finalVault = await getAccount(connection, lpLockVaultPda);
  const finalState = await program.account.mintState.fetch(mintStatePda);
  console.log("\n=== Done ===");
  console.log("lp_lock_vault total balance now:", finalVault.amount.toString());
  console.log("Unlocks at:                      ", new Date(finalState.lpLockUntil.toNumber() * 1000).toISOString());
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
