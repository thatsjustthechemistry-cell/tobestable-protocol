// scripts/prove-arm-floor-authority.js
//
// Proves the Round-4 (Fable 5) **H1 fix**: `arm_floor` is authority-only.
//
// H1: arm_floor used to be permissionless and latched the $1 floor off the
// live (manipulable) Raydium spot ratio. Anyone could flash-skew the pool
// across $1, latch floor_active = true permanently, and unlock a
// vault_sol_reserve drain via cheap-mint -> sell_to_vault. The fix added
//
//     constraint = authority.key() == mint_state.authority @ Unauthorized
//
// to ArmFloor.authority. That constraint has unit-tested arming MATH
// (pyth_math_tests::arm_gate_*) but the AUTHORIZATION rejection cannot be
// exercised under `anchor test` — ArmFloor also takes the real Raydium pool
// vaults and a Pyth PriceUpdateV2 account, which localnet does not have. So it
// is proven here, once, on devnet.
//
// SAFE BY CONSTRUCTION: the only key this script ever signs with is a throwaway
// generated fresh in-process. It is definitionally not the authority, so this
// script can never actually arm the floor. It also asserts floor_active is
// unchanged afterwards.
//
// ⚠️ TARGET MUST CONTAIN THE H1 FIX. The legacy devnet program
// (CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ) predates it and is NOT
// redeployed (see Anchor.toml). Deploy current `main` to a throwaway devnet
// program and pass it with --program, or this proves nothing.
//
// Preconditions on the target program:
//   - initialized, pool configured (set_pool_config has run)
//   - floor not already armed
//
// Usage:
//   node scripts/prove-arm-floor-authority.js --program <PUBKEY>
//   node scripts/prove-arm-floor-authority.js --program <PUBKEY> --rpc <URL>
//
// Exit code 0 = the gate held (rejected with Unauthorized, floor untouched).
// Exit code 1 = the gate did NOT hold, or the run was inconclusive.

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const splToken = require("@solana/spl-token");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

const SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { rpc: "https://api.devnet.solana.com", program: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--rpc") out.rpc = a[++i];
    else if (a[i] === "--program") out.program = a[++i];
  }
  return out;
}

// Did this failure come from the authority gate, rather than something else?
function isAuthorizationRejection(err) {
  const blob = [
    err && err.message,
    err && err.toString && err.toString(),
    err && Array.isArray(err.logs) ? err.logs.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
  const code = err && err.error && err.error.errorCode;
  return {
    matched:
      /Unauthorized/i.test(blob) ||
      /ConstraintRaw/i.test(blob) ||
      /\b6002\b/.test(blob) ||
      (code && (code.code === "Unauthorized" || code.number === 6002)),
    blob,
  };
}

async function main() {
  const { rpc, program: programArg } = parseArgs();
  if (!programArg) {
    console.error(
      "❌ --program <PUBKEY> is required.\n" +
        "   Deploy current main to a throwaway devnet program first — the legacy\n" +
        "   devnet program predates the H1 fix and would prove nothing.",
    );
    process.exit(1);
  }
  const PROGRAM_ID = new PublicKey(programArg);

  const connection = new Connection(rpc, "confirmed");

  // The throwaway signer. Never the authority; cannot arm the floor.
  const intruder = Keypair.generate();
  const wallet = new anchor.Wallet(intruder);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "neco_token.json"), "utf8"),
  );
  const program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from("mint_state")], PROGRAM_ID);
  const before = await program.account.mintState.fetch(mintStatePda);

  console.log("=== arm_floor authority-gate proof (H1) ===");
  console.log("  RPC:              ", rpc);
  console.log("  Program:          ", PROGRAM_ID.toBase58());
  console.log("  Authority:        ", before.authority.toBase58());
  console.log("  Intruder (signer):", intruder.publicKey.toBase58(), "(throwaway)");
  console.log("  floor_active now: ", before.floorActive);

  if (intruder.publicKey.equals(before.authority)) {
    console.error("❌ Impossible: throwaway equals authority. Aborting.");
    process.exit(1);
  }
  if (before.floorActive) {
    console.error(
      "❌ Floor is ALREADY armed on this program — the rejection would be masked by\n" +
        "   FloorAlreadyActive. Use a fresh deployment where floor_active == false.",
    );
    process.exit(1);
  }
  if (before.raydiumPoolState.equals(PublicKey.default)) {
    console.error(
      "❌ Pool not configured on this program (set_pool_config has not run).\n" +
        "   arm_floor would revert with PoolNotConfigured, which does NOT prove the\n" +
        "   authority gate. Configure the pool first.",
    );
    process.exit(1);
  }

  // Fees for the intruder's attempt.
  console.log("\nAirdropping 1 SOL to the throwaway signer...");
  try {
    const sig = await connection.requestAirdrop(intruder.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  } catch (e) {
    console.error("❌ Airdrop failed (devnet rate limit?):", e.message || e);
    process.exit(1);
  }

  // Same Pyth wiring as arm-floor.js, so the attempt is a genuine, well-formed
  // arm_floor call whose ONLY defect is the signer.
  console.log("Fetching SOL/USD from Hermes...");
  const hermesRes = await fetch(
    `${HERMES_URL}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64`,
  );
  const hermesData = await hermesRes.json();
  const priceUpdateBase64 = hermesData.binary.data[0];

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
            authority: intruder.publicKey, // ← the whole point: NOT mint_state.authority
            mintState: mintStatePda,
            raydiumToken0Vault: before.raydiumToken0Vault,
            raydiumToken1Vault: before.raydiumToken1Vault,
            pythPriceUpdate: priceUpdateAccount,
          })
          .instruction(),
        signers: [],
      },
    ];
  });

  console.log("\nAttempting arm_floor as a NON-authority (this must fail)...");
  let rejected = false;
  let rejection = null;
  try {
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50000 });
    await pythReceiver.provider.sendAll(txs, { skipPreflight: false });
  } catch (e) {
    rejected = true;
    rejection = e;
  }

  const after = await program.account.mintState.fetch(mintStatePda);

  console.log("\n=== Result ===");
  if (!rejected) {
    console.error("❌ FAIL — arm_floor was ACCEPTED from a non-authority signer.");
    console.error("   The H1 gate is not effective on this deployment.");
    console.error("   floor_active is now:", after.floorActive);
    process.exit(1);
  }

  const { matched, blob } = isAuthorizationRejection(rejection);
  console.log("  Rejected:        yes");
  console.log("  floor_active:    ", after.floorActive, after.floorActive === false ? "(unchanged ✅)" : "(CHANGED ❌)");

  if (after.floorActive !== false) {
    console.error("\n❌ FAIL — floor_active changed despite the rejection. Investigate immediately.");
    process.exit(1);
  }
  if (!matched) {
    console.error(
      "\n⚠️  INCONCLUSIVE — the call was rejected, but not visibly by the authority\n" +
        "   constraint. The floor was not armed (the security invariant holds), but this\n" +
        "   run does not prove WHY. Check the error below and re-run once the unrelated\n" +
        "   precondition is satisfied.\n",
    );
    console.error(blob.slice(0, 1200));
    process.exit(1);
  }

  console.log("  Reason:          Unauthorized / ConstraintRaw ✅");
  console.log(
    "\n✅ PASS — arm_floor rejected a non-authority signer with Unauthorized and the\n" +
      "   floor stayed disarmed. The H1 authority gate is proven on-chain.",
  );
}

main().catch((e) => {
  console.error("\n❌ Script error (not a gate result):", e.message || e);
  if (e.logs) console.error(e.logs);
  process.exit(1);
});
