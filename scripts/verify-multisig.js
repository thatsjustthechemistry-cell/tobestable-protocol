// scripts/verify-multisig.js
//
// Read-only verification: does the on-chain `mint_state.authority` equal the
// expected multisig vault pubkey? Useful as a post-migration sanity check
// AND as ongoing monitoring (run from CI or a cron — exits non-zero if drift).
//
// Usage:
//   node scripts/verify-multisig.js --network <devnet|mainnet> --expected <PUBKEY>
//
// Exit codes:
//   0  authority matches expected
//   1  authority does NOT match (drift!)
//   2  invalid args / RPC failure
//
// See docs/MULTISIG_MIGRATION.md.

const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const PROGRAM_ID_BY_NETWORK = {
  devnet:  'CfdXZeKuFRGMxiedAHBemm35rANWPvcriwPEyh9KVnBQ',
  mainnet: process.env.TOBE_MAINNET_PROGRAM_ID || 'TBD_AFTER_MAINNET_DEPLOY',
};
const RPC_BY_NETWORK = {
  devnet:  'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { network: null, expected: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network')       out.network = args[++i];
    else if (args[i] === '--expected') out.expected = args[++i];
  }
  if (!out.network || !RPC_BY_NETWORK[out.network] || !out.expected) {
    console.error('Usage: node scripts/verify-multisig.js --network <devnet|mainnet> --expected <PUBKEY>');
    process.exit(2);
  }
  return out;
}

async function main() {
  const { network, expected } = parseArgs();
  const programIdStr = PROGRAM_ID_BY_NETWORK[network];
  if (programIdStr === 'TBD_AFTER_MAINNET_DEPLOY') {
    console.error('Mainnet program ID not yet known. Set TOBE_MAINNET_PROGRAM_ID env var.');
    process.exit(2);
  }
  const programId = new PublicKey(programIdStr);
  const expectedPk = new PublicKey(expected);

  const connection = new Connection(RPC_BY_NETWORK[network], 'confirmed');
  // Read-only — no signer needed; use a dummy provider
  const dummyKeypair = require('@solana/web3.js').Keypair.generate();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(dummyKeypair), { commitment: 'confirmed' });

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'neco_token.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);

  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], programId);
  const state = await program.account.mintState.fetch(mintStatePda);

  const onChain = state.authority.toBase58();
  const want = expectedPk.toBase58();
  const pending = state.pendingAuthority.toBase58();

  console.log('=== Authority verification ===');
  console.log('  Network:           ', network);
  console.log('  Program ID:        ', programId.toBase58());
  console.log('  mint_state PDA:    ', mintStatePda.toBase58());
  console.log('  On-chain authority:', onChain);
  console.log('  Expected:          ', want);
  console.log('  Pending authority: ', pending);
  console.log('');

  if (onChain === want) {
    console.log('✅ on-chain authority matches expected multisig vault');
    if (pending !== '11111111111111111111111111111111') {
      console.log(`⚠️  pending_authority is non-default (${pending}) — a future transfer is queued`);
    }
    process.exit(0);
  } else {
    console.log('❌ DRIFT: on-chain authority does NOT match expected');
    console.log('   This may be because:');
    console.log('   1. Migration not yet completed (accept_authority still pending)');
    console.log('   2. Authority was rotated to a different multisig');
    console.log('   3. The expected pubkey is wrong');
    process.exit(1);
  }
}

main().catch(e => { console.error('\n❌ RPC error:', e.message || e); process.exit(2); });
