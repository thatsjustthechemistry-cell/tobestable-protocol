// scripts/mainnet-initialize.js
//
// Mainnet: initialize the TOBE program. Generates a fresh TOBE mint keypair,
// creates state PDA + vault PDAs + Metaplex metadata, and stores the Pyth
// SOL/USD feed pubkey for peg arbitrage.
//
// Defaults match the brainstormed launch plan:
//   - treasury = current signer (you), to be moved to Realms via update_treasury
//   - Pyth feed identity is hardcoded in the program (validated at call-time
//     inside read_sol_usd_price), so no init-time pubkey is required.
//
// Usage:
//   node scripts/mainnet-initialize.js [--treasury <PUBKEY>] [--yes]
//
// Safe-by-default: confirms before sending. Saves mint keypair to
// scripts/.mainnet-mint.json — BACK THIS FILE UP, it controls the TOBE mint
// post-launch (though mint authority is a PDA, the keypair is the rent
// reclaim path if you ever close the mint account).

const anchor = require('@coral-xyz/anchor');
const {
  Connection, PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROGRAM_ID = new PublicKey('Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX');
const MPL_TOKEN_METADATA_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { treasury: null, founder: null, yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--treasury') out.treasury = args[++i];
    else if (args[i] === '--founder') out.founder = args[++i];
    else if (args[i] === '--yes' || args[i] === '-y') out.yes = true;
  }
  return out;
}

async function confirm(prompt) {
  return new Promise(r => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt + ' (yes/no): ', a => { rl.close(); r(a.trim().toLowerCase() === 'yes'); });
  });
}

async function main() {
  const { treasury, founder, yes } = parseArgs();

  // Load deployer/authority keypair
  const keypairPath = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'solana', 'id.json');
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const treasuryPk = new PublicKey(treasury || payer.publicKey.toBase58());
  // Founder revenue wallet: receives 50% of buy_from_vault (ceiling-arbitrage)
  // proceeds. Defaults to the signer; pass --founder <PUBKEY> for a dedicated
  // wallet. This is a DISCLOSED founder fee (see FAQ / SECURITY.md).
  const founderPk = new PublicKey(founder || payer.publicKey.toBase58());
  // Disclosed team allocation wallet: its first 8 mints are payment-free
  // (hard-capped in the program, no setter). Disclosed in FAQ + live feed.
  const TEAM_WALLET = new PublicKey('Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'target', 'idl', 'neco_token.json'), 'utf8'));
  const program = new anchor.Program(idl, provider);

  // Pre-flight: balance check
  const balance = await connection.getBalance(payer.publicKey);
  console.log('=== Mainnet Initialize ===');
  console.log('  Program ID:    ', PROGRAM_ID.toBase58());
  console.log('  Signer/Payer:  ', payer.publicKey.toBase58(), `(${(balance / 1e9).toFixed(4)} SOL)`);
  console.log('  Treasury:      ', treasuryPk.toBase58(), treasuryPk.equals(payer.publicKey) ? '(= signer, default)' : '(custom)');
  console.log('  Founder (50%): ', founderPk.toBase58(), founderPk.equals(payer.publicKey) ? '(= signer, default)' : '(custom)');
  console.log('  Team wallet:   ', TEAM_WALLET.toBase58(), '(8 free mints, disclosed)');

  if (balance < 0.1 * 1e9) {
    console.error('❌ Balance too low. Need ≥0.1 SOL for init rent + fees.');
    process.exit(1);
  }

  // Check whether state already exists (prevents double-init)
  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], PROGRAM_ID);
  const existing = await connection.getAccountInfo(mintStatePda);
  if (existing) {
    console.error('❌ State PDA already exists at', mintStatePda.toBase58(), '— program already initialized.');
    process.exit(1);
  }

  // Generate fresh TOBE mint keypair
  const tobeMint = Keypair.generate();
  const mintKeypairFile = path.join(__dirname, '.mainnet-mint.json');
  fs.writeFileSync(mintKeypairFile, JSON.stringify(Array.from(tobeMint.secretKey)));
  console.log('  TOBE mint:     ', tobeMint.publicKey.toBase58(), '(keypair saved to scripts/.mainnet-mint.json)');

  // Derive PDAs
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from('mint_authority')], PROGRAM_ID);
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority')], PROGRAM_ID);
  const [vaultTokenPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_token')], PROGRAM_ID);
  const [lpLockAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from('lp_lock_authority')], PROGRAM_ID);
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA_ID.toBuffer(), tobeMint.publicKey.toBuffer()],
    MPL_TOKEN_METADATA_ID,
  );
  // Program-data PDA (BPF Upgradeable Loader) — initialize is bound to the
  // program's upgrade authority, so the signer must be the deployer.
  const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const [programDataPda] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE_LOADER);

  console.log('\nDerived PDAs:');
  console.log('  mint_state:        ', mintStatePda.toBase58());
  console.log('  mint_authority:    ', mintAuthorityPda.toBase58());
  console.log('  vault_authority:   ', vaultAuthorityPda.toBase58());
  console.log('  vault_token:       ', vaultTokenPda.toBase58());
  console.log('  lp_lock_authority: ', lpLockAuthorityPda.toBase58());
  console.log('  metaplex metadata: ', metadataPda.toBase58());

  if (!yes) {
    console.log('\n⚠️  This is a MAINNET initialize. Costs ~0.05 SOL and creates the live TOBE mint.');
    console.log('    The mint keypair has been saved to scripts/.mainnet-mint.json — BACK IT UP NOW.');
    const ok = await confirm('Proceed with initialize?');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  console.log('\nSending initialize...');
  const tx = await program.methods
    .initialize(treasuryPk, payer.publicKey, founderPk, TEAM_WALLET)
    .accounts({
      authority: payer.publicKey,
      mintState: mintStatePda,
      tobeMint: tobeMint.publicKey,
      mintAuthority: mintAuthorityPda,
      vaultAuthority: vaultAuthorityPda,
      vaultTokenAccount: vaultTokenPda,
      lpLockAuthority: lpLockAuthorityPda,
      metadata: metadataPda,
      tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
      program: PROGRAM_ID,
      programData: programDataPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([tobeMint])
    .rpc();

  console.log('  ✅ tx:', tx);

  const state = await program.account.mintState.fetch(mintStatePda);
  console.log('\n=== State after init ===');
  console.log('  authority:       ', state.authority.toBase58());
  console.log('  treasury:        ', state.treasury.toBase58());
  console.log('  tobe_mint:       ', state.tobeMint.toBase58());
  console.log('  current_round:   ', state.currentRound.toString(), '(0 = pre-first-mint)');
  console.log('  paused:          ', state.paused);

  console.log('\n=== Next steps ===');
  console.log('  1. Back up scripts/.mainnet-mint.json (TOBE mint keypair)');
  console.log('  2. Update tobe-mint frontend with new program ID + TOBE mint pubkey');
  console.log('  3. Run scripts/mainnet-update-treasury.js to point treasury at Realms vault');
  console.log('  4. Run scripts/propose-authority.js --network mainnet --new-authority <REALMS_VAULT>');
  console.log('  5. Realms accept_authority proposal → vote → execute');
  console.log('  6. Wait for community mints; once a pool exists, Realms proposal for set_pool_config');
}

main().catch(e => { console.error('\n❌ Failed:', e.message || e); process.exit(1); });
