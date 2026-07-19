// Foundation probe for testing the vault instructions on localnet.
//
// WHY THIS EXISTS
// ---------------
// The 26 passing integration tests never touch buy_from_vault, sell_to_vault,
// arm_floor, flush_lp_to_raydium or set_pool_config. All of them require a real
// Raydium CPMM pool, and set_pool_config validates pool ownership against the
// MAINNET Raydium program (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` — the
// crate is built with default-features = false, so the devnet id is NOT compiled
// in). Devnet's Raydium is a different program, so those instructions are
// untestable there by construction.
//
// The way through is to clone mainnet Raydium into the local validator, exactly
// as we already clone Metaplex. This file proves that foundation works BEFORE
// pool creation and the vault tests are built on top of it — each CI cycle is
// ~15 minutes, so failing fast and cheaply matters more than doing it in one go.
//
// Deliberately a SEPARATE file with no dependency on the main suite: it needs no
// authority and mutates nothing, so it cannot perturb the 26 green tests (which
// end with authority transferred to a fresh keypair — anything appended there
// would have to sign as that key).

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

// Mainnet addresses, cloned into the validator by the CI workflow.
const CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM_CONFIG_0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const POOL_FEE_ACC = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

describe("raydium localnet foundation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;

  it("Raydium CPMM program is cloned and executable", async () => {
    const acc = await conn.getAccountInfo(CPMM_PROGRAM);
    assert.ok(acc, "CPMM program not present — check --clone-upgradeable-program in CI");
    assert.isTrue(acc.executable, "CPMM cloned but not executable");
    // Upgradeable programs are a small stub owned by the BPF loader whose data
    // points at a separate ProgramData account. If ProgramData did not come
    // across, the program is present but uninvokable — the exact failure that
    // produced "Unsupported program id" when Metaplex was cloned with plain
    // --clone instead of --clone-upgradeable-program.
    assert.equal(
      acc.owner.toBase58(),
      "BPFLoaderUpgradeab1e11111111111111111111111",
      "unexpected owner for the CPMM program",
    );
  });

  it("Raydium ProgramData came across too (program is actually invokable)", async () => {
    const [programData] = PublicKey.findProgramAddressSync(
      [CPMM_PROGRAM.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    );
    const acc = await conn.getAccountInfo(programData);
    assert.ok(acc, "ProgramData missing — the program stub cloned but the code did not");
    assert.isAbove(acc.data.length, 1000, "ProgramData suspiciously small; clone likely truncated");
  });

  it("AMM config #0 is present and owned by the CPMM program", async () => {
    const acc = await conn.getAccountInfo(AMM_CONFIG_0);
    assert.ok(acc, "AMM config not cloned — pool creation would fail");
    assert.equal(acc.owner.toBase58(), CPMM_PROGRAM.toBase58());
  });

  it("pool fee account and wSOL mint are present", async () => {
    const fee = await conn.getAccountInfo(POOL_FEE_ACC);
    assert.ok(fee, "CREATE_CPMM_POOL_FEE_ACC not cloned");

    const wsol = await conn.getAccountInfo(WSOL_MINT);
    assert.ok(wsol, "native wSOL mint not present — pool must be TOBE/wSOL");
    assert.equal(wsol.data.length, 82, "wSOL account is not an SPL mint");
  });
});
