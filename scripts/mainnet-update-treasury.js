// scripts/mainnet-update-treasury.js
//
// Mainnet: redirect `buy_from_vault` arbitrage proceeds to a new treasury
// address. Most common use: point treasury at the Realms multisig vault
// BEFORE migrating authority — so when the multisig later takes over,
// proceeds already flow to it.
//
// Defaults to Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC (the Realms
// council vault discussed in docs/MULTISIG_MIGRATION.md). Override via flag.
//
// Usage:
//   node scripts/mainnet-update-treasury.js [--new-treasury <PUBKEY>] [--yes]
//
// Must be run from the CURRENT authority wallet (~/.config/solana/id.json).
// Safe-by-default: confirms before sending.

const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROGRAM_ID = new PublicKey('Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX');
const DEFAULT_NEW_TREASURY = 'Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC'; // Realms council vault

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { newTreasury: DEFAULT_NEW_TREASURY, yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--new-treasury') out.newTreasury = args[++i];
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
  const { newTreasury, yes } = parseArgs();
  const newTreasuryPk = new PublicKey(newTreasury);

  const keypairPath = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'solana', 'id.json');
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'target', 'idl', 'neco_token.json'), 'utf8'));
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], PROGRAM_ID);
  const state = await program.account.mintState.fetch(mintStatePda);

  console.log('=== Mainnet Update Treasury ===');
  console.log('  Program ID:        ', PROGRAM_ID.toBase58());
  console.log('  Signer:            ', payer.publicKey.toBase58());
  console.log('  Current authority: ', state.authority.toBase58());
  console.log('  Current treasury:  ', state.treasury.toBase58());
  console.log('  NEW treasury:      ', newTreasuryPk.toBase58(), newTreasuryPk.toBase58() === DEFAULT_NEW_TREASURY ? '(Realms council vault, default)' : '(custom)');

  if (state.authority.toBase58() !== payer.publicKey.toBase58()) {
    console.error('❌ Your wallet is NOT the current authority.');
    console.error('   Current authority:', state.authority.toBase58());
    console.error('   Your wallet:      ', payer.publicKey.toBase58());
    process.exit(1);
  }

  if (state.treasury.toBase58() === newTreasuryPk.toBase58()) {
    console.log('ℹ️  Treasury already at target value. No-op.');
    return;
  }

  if (!yes) {
    console.log('\n⚠️  After this, ALL buy_from_vault arbitrage proceeds flow to the new treasury.');
    console.log('    Existing accumulated SOL in vault_sol_reserve and pool_sol_reserve is NOT moved (they are different PDAs).');
    const ok = await confirm('Proceed?');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  console.log('\nSending update_treasury...');
  const tx = await program.methods
    .updateTreasury(newTreasuryPk)
    .accounts({ authority: payer.publicKey, mintState: mintStatePda })
    .rpc();
  console.log('  ✅ tx:', tx);

  const after = await program.account.mintState.fetch(mintStatePda);
  console.log('\n=== After ===');
  console.log('  treasury:', after.treasury.toBase58());
}

main().catch(e => { console.error('\n❌ Failed:', e.message || e); process.exit(1); });
