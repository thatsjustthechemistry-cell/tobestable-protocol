/**
 * TOBE Keeper Bot — Vault Release Automation
 *
 * Monitors TOBE market price. When TOBE > $1 (peg target), releases
 * vault tokens at $1 to push price back down.
 *
 * Requires:
 *   - Authority keypair (keeper signer for vault_release)
 *   - RPC URL (mainnet or devnet)
 *   - TOBE must be listed on Jupiter/Raydium with a SOL pair
 *
 * Usage:
 *   npx ts-node scripts/keeper.ts
 *
 * Env vars:
 *   KEEPER_KEYPAIR  — path to authority keypair JSON (default: ~/.config/solana/id.json)
 *   RPC_URL         — Solana RPC endpoint (default: mainnet)
 *   NETWORK         — 'mainnet' | 'devnet' (default: mainnet)
 *   DRY_RUN         — '1' to log without sending tx (default: 0)
 *   POLL_INTERVAL   — seconds between price checks (default: 30)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NecoToken } from "../target/types/neco_token";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ─── Config ───

const PEG_TARGET = 1.0;          // $1.00 — vault sells at this price
const RELEASE_FRACTION = 0.05;   // release 5% of vault per trigger (gradual)
const MIN_RELEASE_TOKENS = 100;  // don't release fewer than 100 TOBE
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30") * 1000;
const DRY_RUN = process.env.DRY_RUN === "1";

const PROGRAM_ID = "DnMvWs2dDim57TLBcJp7FKkDUFw2KnLmJybzpbTZuc65";
const TOBE_MINT = "h611YQ3wKJesFUC6NDmpzXNSAG5jYn7BJS6FrepcqbN";

// ─── Setup ───

function loadKeypair(): anchor.web3.Keypair {
  const keypairPath = process.env.KEEPER_KEYPAIR
    || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".config", "solana", "id.json");
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(raw));
}

function getRpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const network = process.env.NETWORK || "mainnet";
  return network === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}

// ─── Price Feed ───

async function fetchTobePrice(): Promise<{ price: number; solPrice: number } | null> {
  try {
    // Jupiter Price API v2 — free, no key
    const tobeRes = await fetch(
      `https://api.jup.ag/price/v2?ids=${TOBE_MINT}&vsToken=So11111111111111111111111111111111111111112`
    );
    const tobeData = await tobeRes.json();
    const tobePriceInSol = parseFloat(tobeData?.data?.[TOBE_MINT]?.price || "0");

    // Get SOL/USD from CoinGecko
    const solRes = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const solData = await solRes.json();
    const solUsd = solData?.solana?.usd || 0;

    if (tobePriceInSol <= 0 || solUsd <= 0) return null;

    return {
      price: tobePriceInSol * solUsd,  // TOBE price in USD
      solPrice: solUsd,
    };
  } catch (err) {
    console.error("[Keeper] Price fetch error:", err);
    return null;
  }
}

// ─── Vault Release ───

async function executeVaultRelease(
  program: Program<NecoToken>,
  keeper: anchor.web3.Keypair,
  connection: anchor.web3.Connection,
  tokenAmount: number,
  solLamports: number,
  mintState: any,
) {
  const mintStatePda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_state")], program.programId
  )[0];
  const vaultAuthorityPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")], program.programId
  )[0];
  const vaultTokenPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token")], program.programId
  )[0];
  const treasuryPk = mintState.treasury;

  // Buyer = keeper in this simple version (keeper buys from vault, resells on market)
  // In production, this could accept external buyer transactions
  const tobeMintPk = new anchor.web3.PublicKey(TOBE_MINT);

  // Find or create buyer's TOBE ATA
  const [buyerTobe] = anchor.web3.PublicKey.findProgramAddressSync(
    [keeper.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tobeMintPk.toBuffer()],
    new anchor.web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );

  console.log(`[Keeper] Releasing ${tokenAmount / 1e9} TOBE for ${solLamports / 1e9} SOL`);

  if (DRY_RUN) {
    console.log("[Keeper] DRY RUN — skipping transaction");
    return;
  }

  const tx = await program.methods
    .vaultRelease(new anchor.BN(tokenAmount), new anchor.BN(solLamports))
    .accounts({
      buyer: keeper.publicKey,
      keeper: keeper.publicKey,
      mintState: mintStatePda,
      vaultAuthority: vaultAuthorityPda,
      vaultTokenAccount: vaultTokenPda,
      treasury: treasuryPk,
      buyerTobe: buyerTobe,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([keeper])
    .rpc();

  console.log(`[Keeper] Vault release tx: ${tx}`);
}

// ─── Main Loop ───

async function main() {
  const keeper = loadKeypair();
  const rpcUrl = getRpcUrl();
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keeper);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);
  const program = anchor.workspace.necoToken as Program<NecoToken>;

  const mintStatePda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_state")], program.programId
  )[0];

  console.log("[Keeper] Starting TOBE Keeper Bot");
  console.log(`[Keeper] Authority: ${keeper.publicKey.toBase58()}`);
  console.log(`[Keeper] RPC: ${rpcUrl}`);
  console.log(`[Keeper] Peg target: $${PEG_TARGET}`);
  console.log(`[Keeper] Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`[Keeper] Dry run: ${DRY_RUN}`);
  console.log("─".repeat(50));

  while (true) {
    try {
      // 1. Fetch on-chain state
      const state = await program.account.mintState.fetch(mintStatePda);
      const vaultBalance = state.vaultBalance.toNumber();

      if (vaultBalance === 0) {
        console.log("[Keeper] Vault empty — nothing to release");
        await sleep(POLL_INTERVAL);
        continue;
      }

      // 2. Fetch market price
      const priceData = await fetchTobePrice();
      if (!priceData) {
        console.log("[Keeper] Could not fetch price — skipping");
        await sleep(POLL_INTERVAL);
        continue;
      }

      console.log(
        `[Keeper] TOBE: $${priceData.price.toFixed(4)} | SOL: $${priceData.solPrice.toFixed(2)} | Vault: ${(vaultBalance / 1e9).toFixed(0)} TOBE`
      );

      // 3. Check if price is above peg
      if (priceData.price <= PEG_TARGET) {
        console.log(`[Keeper] Price at or below peg ($${PEG_TARGET}) — no action`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      // 4. Calculate release amount
      const releaseTokens = Math.max(
        Math.floor(vaultBalance * RELEASE_FRACTION),
        MIN_RELEASE_TOKENS * 1e9
      );
      const actualRelease = Math.min(releaseTokens, vaultBalance);

      // Price at $1/TOBE → SOL cost = tokens * $1 / solPrice
      const solCost = Math.floor((actualRelease / 1e9) * (1 / priceData.solPrice) * 1e9);

      console.log(`[Keeper] ⚡ Price above peg! Releasing ${(actualRelease / 1e9).toFixed(0)} TOBE`);

      await executeVaultRelease(program, keeper, connection, actualRelease, solCost, state);
    } catch (err) {
      console.error("[Keeper] Error:", err);
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
