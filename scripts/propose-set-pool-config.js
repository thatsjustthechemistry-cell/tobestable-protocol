// scripts/propose-set-pool-config.js
//
// Step 9 of the mainnet launch (see docs/MAINNET_LAUNCH.md). Authority is the
// Realms council by this point, so set_pool_config must go through governance
// — this script builds that proposal programmatically instead of hand-typing
// the raw hex instruction + 7 accounts into Realms' custom-instruction UI
// (error-prone: one wrong signer/writable flag or a transposed hex digit and
// the proposal either fails or does something unintended).
//
// Creates a Realms proposal that calls `set_pool_config` on the TOBE program
// with the realm's native treasury PDA (Cb7TsQF...) as the authority signer.
// Once 2-of-3 council members vote yes, anyone can execute the proposal.
//
// Must be run by ONE of the 3 council members (a wallet that has deposited a
// council token into the realm). That wallet becomes the proposer; if --vote
// is passed the same wallet also casts a yes vote in the same script run, so
// you only need ONE more council member to vote yes to reach 2-of-3.
//
// Usage:
//   node scripts/propose-set-pool-config.js \
//     [--pool-json <PATH>]             defaults to scripts/.mainnet-pool.json
//     [--council-keypair <PATH>]       defaults to ~/.config/solana/id.json
//     [--description-link <URL>]       optional on-chain bookmark (gist, blog, tweet, commit)
//     [--vote]                         also cast a yes vote (recommended for self-multisig)
//     [--dry-run]                      print what would happen, don't send
//     [--yes]                          skip the confirmation prompt
//
// Prereqs (in order):
//   1. npm install @solana/spl-governance       (one-time setup)
//   2. Authority already migrated to the treasury PDA (propose/accept-authority.js done)
//   3. mainnet-create-raydium-pool.js completed — scripts/.mainnet-pool.json exists
//   4. This script's runner has deposited a council token via the Realms UI

const anchor = require('@coral-xyz/anchor');
const {
  Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

let gov;
try {
  gov = require('@solana/spl-governance');
} catch (e) {
  console.error('❌ Missing dependency. Install it first:');
  console.error('   npm install @solana/spl-governance');
  process.exit(2);
}
const {
  getGovernanceProgramVersion, getTokenOwnerRecordAddress, withCreateProposal,
  withInsertTransaction, withSignOffProposal, withCastVote,
  InstructionData, AccountMetaData, VoteType, Vote, YesNoVote,
} = gov;

// ---- TOBESTABLE-specific constants (mainnet) ------------------------------
const PROGRAM_ID = new PublicKey(
  process.env.TOBE_MAINNET_PROGRAM_ID || 'Eekx6ftd6WZfSpubr9otS1G6wbKdSCWuXt7n1cbQjmdX'
);
const GOVERNANCE_PROGRAM_ID = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');
const REALM             = new PublicKey('9VUbq5QHSPezGPseqY1kgrwSVLGtndk3XT1y3dfMB5o');
const GOVERNANCE        = new PublicKey('XTrVLXYc9jFKVJj5S8oDBSmaaT6rgsFTPwJuMtmxFu7');
const TREASURY_PDA      = new PublicKey('Cb7TsQFqMbbshjFEXmxEhCBj1Ab5K3T94M4NLiusqVAC');
const COUNCIL_MINT      = new PublicKey('2ZdbLGkKi1Zvk5dKLqcY5UBcDdJVss8u2tGmMnN3gRHN');

const RPC = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROPOSAL_NAME = 'Configure Raydium pool for TOBE (set_pool_config)';
const DEFAULT_DESCRIPTION_LINK = '';

// ---- CLI ------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    poolJson: path.join(__dirname, '.mainnet-pool.json'),
    councilKeypair: path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'solana', 'id.json'),
    descriptionLink: DEFAULT_DESCRIPTION_LINK,
    vote: false, dryRun: false, yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pool-json')             out.poolJson = args[++i];
    else if (args[i] === '--council-keypair')      out.councilKeypair = args[++i];
    else if (args[i] === '--description-link') out.descriptionLink = args[++i];
    else if (args[i] === '--vote')             out.vote = true;
    else if (args[i] === '--dry-run')          out.dryRun = true;
    else if (args[i] === '--yes' || args[i] === '-y') out.yes = true;
  }
  if (out.descriptionLink && !/^https?:\/\//i.test(out.descriptionLink)) {
    console.error('❌ --description-link must start with http:// or https:// (got:', out.descriptionLink + ')');
    process.exit(2);
  }
  return out;
}

async function confirm(promptText) {
  return new Promise(r => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText + ' (yes/no): ', a => { rl.close(); r(a.trim().toLowerCase() === 'yes'); });
  });
}

// ---- Main -----------------------------------------------------------------
async function main() {
  const { poolJson, councilKeypair, descriptionLink, vote, dryRun, yes } = parseArgs();

  if (!fs.existsSync(poolJson)) {
    console.error('❌ Pool info file not found:', poolJson);
    console.error('   Run mainnet-create-raydium-pool.js first (Step 8).');
    process.exit(1);
  }
  const pool = JSON.parse(fs.readFileSync(poolJson, 'utf8'));
  for (const field of ['poolState', 'poolAuthority', 'lpMint', 'token0Vault', 'token1Vault']) {
    if (!pool[field]) {
      console.error(`❌ ${poolJson} is missing "${field}" — was it written by mainnet-create-raydium-pool.js?`);
      process.exit(1);
    }
  }
  if (typeof pool.tobeIsToken0 !== 'boolean') {
    console.error(`❌ ${poolJson} is missing boolean "tobeIsToken0".`);
    process.exit(1);
  }

  const secret = JSON.parse(fs.readFileSync(councilKeypair, 'utf8'));
  const proposer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(RPC, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(proposer), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'neco_token.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);
  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], PROGRAM_ID);

  console.log('=== Pre-flight ===');
  console.log('  Network:               mainnet');
  console.log('  Program ID:            ', PROGRAM_ID.toBase58());
  console.log('  Realm:                 ', REALM.toBase58());
  console.log('  Governance:            ', GOVERNANCE.toBase58());
  console.log('  Treasury (= authority):', TREASURY_PDA.toBase58());
  console.log('  Council mint:          ', COUNCIL_MINT.toBase58());
  console.log('  Proposer (you):        ', proposer.publicKey.toBase58());
  console.log('  Pool JSON:             ', poolJson);
  console.log('  Description link:      ', descriptionLink || '(none — name field only)');
  console.log('  Auto-vote yes:         ', vote);
  console.log('  Dry run:               ', dryRun);
  console.log('\n  Raydium pool state:    ', pool.poolState);
  console.log('  Raydium pool authority:', pool.poolAuthority);
  console.log('  Raydium LP mint:       ', pool.lpMint);
  console.log('  Raydium token_0 vault: ', pool.token0Vault);
  console.log('  Raydium token_1 vault: ', pool.token1Vault);
  console.log('  TOBE is token_0:       ', pool.tobeIsToken0);

  // 1. Confirm program state is ready for set_pool_config
  const state = await program.account.mintState.fetch(mintStatePda);
  console.log('\n  Current authority:     ', state.authority.toBase58());
  console.log('  Existing pool config:  ', state.raydiumPoolState.toBase58());
  if (state.authority.toBase58() !== TREASURY_PDA.toBase58()) {
    console.error('\n❌ Authority is NOT the treasury PDA yet.');
    console.error('   Run the accept_authority migration (propose-accept-authority.js) first.');
    process.exit(1);
  }
  const UNCONFIGURED = '11111111111111111111111111111111';
  if (state.raydiumPoolState.toBase58() !== UNCONFIGURED) {
    console.log('\nℹ️  Pool config is already set on-chain. Migration already done. No-op.');
    console.log('   raydium_pool_state:', state.raydiumPoolState.toBase58());
    return;
  }

  // 2. Confirm proposer has a deposited council token (i.e. is a council member)
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    GOVERNANCE_PROGRAM_ID, REALM, COUNCIL_MINT, proposer.publicKey,
  );
  const torInfo = await connection.getAccountInfo(tokenOwnerRecord);
  if (!torInfo) {
    console.error('\n❌ Proposer wallet has no TokenOwnerRecord in this realm — not a council member.');
    console.error('   TokenOwnerRecord PDA expected at:', tokenOwnerRecord.toBase58());
    console.error('   To become a council member, deposit a council token via the Realms UI.');
    process.exit(1);
  }
  console.log('\n  TokenOwnerRecord:      ', tokenOwnerRecord.toBase58(), '(✓ proposer is a council member)');

  // 3. Detect governance program version (Realms supports v1/v2/v3 simultaneously)
  const programVersion = await getGovernanceProgramVersion(connection, GOVERNANCE_PROGRAM_ID);
  console.log('  Realms program version:', programVersion);

  // --- Build the set_pool_config instruction ---
  // The signer (TREASURY_PDA) is a Realms-owned PDA, so the SPL Governance
  // program will sign for it via invoke_signed when the proposal executes.
  const setPoolConfigIx = await program.methods
    .setPoolConfig(pool.tobeIsToken0)
    .accounts({
      authority:            TREASURY_PDA,
      mintState:            mintStatePda,
      raydiumPoolState:     new PublicKey(pool.poolState),
      raydiumPoolAuthority: new PublicKey(pool.poolAuthority),
      raydiumLpMint:        new PublicKey(pool.lpMint),
      raydiumToken0Vault:   new PublicKey(pool.token0Vault),
      raydiumToken1Vault:   new PublicKey(pool.token1Vault),
    })
    .instruction();

  console.log('\n=== Instruction to be wrapped in proposal ===');
  console.log('  program:', setPoolConfigIx.programId.toBase58());
  console.log('  accounts:');
  setPoolConfigIx.keys.forEach(k => console.log(
    `    ${k.pubkey.toBase58()}  signer=${k.isSigner} writable=${k.isWritable}`
  ));
  console.log('  data (hex):', setPoolConfigIx.data.toString('hex'));

  if (dryRun) {
    console.log('\n--dry-run set; not sending. Run again without --dry-run to actually create the proposal.');
    return;
  }

  if (!yes) {
    console.log('\n⚠️  This will create a Realms proposal on mainnet. Costs ~0.005 SOL in rent.');
    console.log('    After this, 2 of 3 council members must vote yes for it to pass.');
    if (vote) console.log('    --vote set: this script will cast 1 yes vote (yours) automatically.');
    const ok = await confirm('Proceed?');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  // --- Assemble proposal-creation transaction ---
  const txInstructions = [];

  const governanceAccountInfo = await connection.getAccountInfo(GOVERNANCE);
  const proposalIndex = governanceAccountInfo.data.readUInt32LE(65);
  console.log('\n  Next proposal index:', proposalIndex);

  const proposalAddress = await withCreateProposal(
    txInstructions,
    GOVERNANCE_PROGRAM_ID,
    programVersion,
    REALM,
    GOVERNANCE,
    tokenOwnerRecord,
    PROPOSAL_NAME,
    descriptionLink,
    COUNCIL_MINT,
    proposer.publicKey,
    proposalIndex,
    VoteType.SINGLE_CHOICE,
    ['Approve'],
    true,
    proposer.publicKey,
  );

  const instructionData = new InstructionData({
    programId: setPoolConfigIx.programId,
    accounts: setPoolConfigIx.keys.map(k => new AccountMetaData({
      pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable,
    })),
    data: setPoolConfigIx.data,
  });
  await withInsertTransaction(
    txInstructions,
    GOVERNANCE_PROGRAM_ID,
    programVersion,
    GOVERNANCE,
    proposalAddress,
    tokenOwnerRecord,
    proposer.publicKey,
    0,
    0,
    0,
    [instructionData],
    proposer.publicKey,
  );

  await withSignOffProposal(
    txInstructions,
    GOVERNANCE_PROGRAM_ID,
    programVersion,
    REALM,
    GOVERNANCE,
    proposalAddress,
    proposer.publicKey,
    undefined,
    tokenOwnerRecord,
  );

  if (vote) {
    await withCastVote(
      txInstructions,
      GOVERNANCE_PROGRAM_ID,
      programVersion,
      REALM,
      GOVERNANCE,
      proposalAddress,
      tokenOwnerRecord,
      tokenOwnerRecord,
      proposer.publicKey,
      COUNCIL_MINT,
      Vote.fromYesNoVote(YesNoVote.Yes),
      proposer.publicKey,
    );
  }

  const tx = new Transaction().add(...txInstructions);
  console.log('\nSending', txInstructions.length, 'instructions in one transaction...');
  const sig = await sendAndConfirmTransaction(connection, tx, [proposer], {
    commitment: 'confirmed', preflightCommitment: 'confirmed',
  });

  console.log('\n  ✅ tx:', sig);
  console.log('\n=== Result ===');
  console.log('  Proposal address: ', proposalAddress.toBase58());
  console.log('  Realms UI:        https://v2.realms.today/dao/' + REALM.toBase58() + '/proposal/' + proposalAddress.toBase58());
  console.log('  Solscan:          https://solscan.io/account/' + proposalAddress.toBase58());

  console.log('\n=== Next steps ===');
  if (vote) {
    console.log('  ✓ You have already voted yes (1 of 2 needed for 2-of-3 threshold).');
    console.log('  → ONE more council member must vote yes to pass.');
  } else {
    console.log('  → TWO council members must vote yes to reach 2-of-3 threshold.');
  }
  console.log('  Other council members can vote by:');
  console.log('    1. Opening the Realms UI link above with their council wallet');
  console.log('    2. Clicking "Approve" → confirm tx');
  console.log('\n  Once threshold passes, anyone can execute the proposal by clicking');
  console.log('  "Execute" in the UI — that triggers set_pool_config on the TOBE program.');
  console.log('  After execution, flush_lp_to_raydium (Step 10) becomes callable.');
}

main().catch(e => {
  console.error('\n❌ Failed:', e.message || e);
  if (e.logs) console.error('  Logs:', e.logs);
  process.exit(1);
});
