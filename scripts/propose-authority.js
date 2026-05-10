// scripts/propose-authority.js
//
// Step 1 of the 2-step authority transfer. Called by the CURRENT authority.
// Sets `mint_state.pending_authority = <new_authority>`.
// The new authority (e.g., a Squads multisig vault) must then call
// `accept_authority` separately to complete the transfer.
//
// Usage:
//   node scripts/propose-authority.js --network <devnet|mainnet> --new-authority <PUBKEY>
//
// Reads ~/.config/solana/id.json as the signer (must be the current authority).
// Reads target/idl/neco_token.json for the program IDL.
//
// Safe-by-default: prints a confirmation prompt before sending.
// Use --yes to skip the prompt (e.g., in scripts).
//
// See docs/MULTISIG_MIGRATION.md for the full migration runbook.

const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROGRAM_ID_BY_NETWORK = {
  devnet:  'CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ',
  // mainnet ID is set after mainnet deploy:
  mainnet: process.env.TOBE_MAINNET_PROGRAM_ID || 'TBD_AFTER_MAINNET_DEPLOY',
};
const RPC_BY_NETWORK = {
  devnet:  'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { network: null, newAuthority: null, yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network')        out.network = args[++i];
    else if (args[i] === '--new-authority') out.newAuthority = args[++i];
    else if (args[i] === '--yes' || args[i] === '-y') out.yes = true;
  }
  if (!out.network || !RPC_BY_NETWORK[out.network]) {
    console.error('Usage: node scripts/propose-authority.js --network <devnet|mainnet> --new-authority <PUBKEY> [--yes]');
    process.exit(2);
  }
  if (!out.newAuthority) {
    console.error('Missing --new-authority <PUBKEY> (the Squads multisig vault address)');
    process.exit(2);
  }
  return out;
}

async function confirm(promptText) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText + ' (yes/no): ', ans => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const { network, newAuthority, yes } = parseArgs();
  const programIdStr = PROGRAM_ID_BY_NETWORK[network];
  if (programIdStr === 'TBD_AFTER_MAINNET_DEPLOY') {
    console.error('Mainnet program ID not yet known. Set TOBE_MAINNET_PROGRAM_ID env var or update the script after mainnet deploy.');
    process.exit(1);
  }
  const programId = new PublicKey(programIdStr);
  const newAuthorityPk = new PublicKey(newAuthority);

  // Load current authority signer
  const keypairPath = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'solana', 'id.json');
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(RPC_BY_NETWORK[network], 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'neco_token.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], programId);

  // Read state to confirm current authority
  const state = await program.account.mintState.fetch(mintStatePda);
  console.log('=== Pre-flight ===');
  console.log('  Network:               ', network);
  console.log('  Program ID:            ', programId.toBase58());
  console.log('  mint_state PDA:        ', mintStatePda.toBase58());
  console.log('  Current authority:     ', state.authority.toBase58());
  console.log('  Pending authority:     ', state.pendingAuthority.toBase58());
  console.log('  Signer (you):          ', payer.publicKey.toBase58());
  console.log('  PROPOSED new authority:', newAuthorityPk.toBase58());
  console.log('');

  if (state.authority.toBase58() !== payer.publicKey.toBase58()) {
    console.error('❌ Your wallet is NOT the current authority. Cannot propose.');
    console.error('   Current authority:', state.authority.toBase58());
    console.error('   Your wallet:      ', payer.publicKey.toBase58());
    process.exit(1);
  }

  if (state.pendingAuthority.toBase58() === newAuthorityPk.toBase58()) {
    console.log('ℹ️  Pending authority already equals proposed value. No-op.');
    return;
  }

  if (!yes) {
    console.log('⚠️  This will set the pending authority. The new authority must then call');
    console.log('    `accept_authority` to complete the transfer. Until then, you remain in control.');
    const ok = await confirm('Continue?');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  console.log('\nSending propose_authority...');
  const tx = await program.methods
    .proposeAuthority(newAuthorityPk)
    .accounts({
      authority: payer.publicKey,
      mintState: mintStatePda,
    })
    .rpc();
  console.log('  ✅ tx:', tx);

  // Re-fetch and confirm
  const stateAfter = await program.account.mintState.fetch(mintStatePda);
  console.log('\n=== After ===');
  console.log('  authority:        ', stateAfter.authority.toBase58(), '(unchanged — that\'s correct)');
  console.log('  pending_authority:', stateAfter.pendingAuthority.toBase58());
  console.log('');
  console.log('Next: have the new authority sign + send `accept_authority`.');
  console.log('See docs/MULTISIG_MIGRATION.md Step 3.');
}

main().catch(e => { console.error('\n❌ Failed:', e.message || e); process.exit(1); });
