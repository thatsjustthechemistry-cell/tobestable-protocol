// scripts/propose-accept-authority.js
//
// Step 5 of mainnet authority migration (see docs/MULTISIG_MIGRATION.md and
// scripts/mainnet-initialize.js "Next steps").
//
// Creates a Realms proposal that calls `accept_authority` on the TOBE program
// with the realm's native treasury PDA (Cb7TsQF...) as the signer. Once 2-of-3
// council members vote yes, the proposal executes and program authority
// permanently moves from the founder wallet to the council multisig.
//
// Must be run by ONE of the 3 council members (a wallet that has deposited a
// council token into the realm). That wallet becomes the proposer; if --vote
// is passed the same wallet also casts a yes vote in the same script run, so
// you only need ONE more council member to vote yes to reach 2-of-3.
//
// Usage:
//   node scripts/propose-accept-authority.js \
//     [--council-keypair <PATH>]      defaults to ~/.config/solana/id.json
//     [--description-link <URL>]      optional on-chain bookmark (gist, blog, tweet, commit)
//     [--vote]                         also cast a yes vote (recommended for self-multisig)
//     [--dry-run]                      print what would happen, don't send
//     [--yes]                          skip the confirmation prompt
//
// Prereqs (in order):
//   1. npm install @solana/spl-governance       (one-time setup)
//   2. TOBE program deployed to mainnet, mainnet-initialize.js completed
//   3. propose-authority.js --network mainnet --new-authority Cb7TsQF... completed
//   4. This script's runner has deposited a council token via the Realms UI

const anchor = require('@coral-xyz/anchor');
const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const BN = require('bn.js');
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
  withInsertTransaction, withSignOffProposal, withCastVote, getInstructionDataFromBase64,
  serializeInstructionToBase64, InstructionData, AccountMetaData, VoteType, Vote, YesNoVote,
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

const RPC = 'https://api.mainnet-beta.solana.com';
const PROPOSAL_NAME = 'Accept program authority for TOBE';
// Default description link is empty. Override at runtime with --description-link <URL>.
// Anything passed here is stored on-chain as-is and shown in the Realms UI; pick a
// URL that will remain reachable (a GitHub commit, a gist, a tweet's permalink).
const DEFAULT_DESCRIPTION_LINK = '';

// ---- CLI ------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    councilKeypair: path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'solana', 'id.json'),
    descriptionLink: DEFAULT_DESCRIPTION_LINK,
    vote: false, dryRun: false, yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--council-keypair')      out.councilKeypair = args[++i];
    else if (args[i] === '--description-link') out.descriptionLink = args[++i];
    else if (args[i] === '--vote')             out.vote = true;
    else if (args[i] === '--dry-run')          out.dryRun = true;
    else if (args[i] === '--yes' || args[i] === '-y') out.yes = true;
  }
  // Lightweight URL sanity check — Realms stores whatever you give it; if you
  // typo "htps://" the link will be permanently broken on-chain. Fail loud.
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
  const { councilKeypair, descriptionLink, vote, dryRun, yes } = parseArgs();

  const secret = JSON.parse(fs.readFileSync(councilKeypair, 'utf8'));
  const proposer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(RPC, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(proposer), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  // --- Load IDL + program ---
  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'neco_token.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);
  const [mintStatePda] = PublicKey.findProgramAddressSync([Buffer.from('mint_state')], PROGRAM_ID);

  // --- Pre-flight verification ---
  console.log('=== Pre-flight ===');
  console.log('  Network:               mainnet');
  console.log('  Program ID:            ', PROGRAM_ID.toBase58());
  console.log('  Realm:                 ', REALM.toBase58());
  console.log('  Governance:            ', GOVERNANCE.toBase58());
  console.log('  Treasury (= new auth): ', TREASURY_PDA.toBase58());
  console.log('  Council mint:          ', COUNCIL_MINT.toBase58());
  console.log('  Proposer (you):        ', proposer.publicKey.toBase58());
  console.log('  Description link:      ', descriptionLink || '(none — name field only)');
  console.log('  Auto-vote yes:         ', vote);
  console.log('  Dry run:               ', dryRun);

  // 1. Confirm program state is ready for accept_authority
  const state = await program.account.mintState.fetch(mintStatePda);
  console.log('\n  Current authority:     ', state.authority.toBase58());
  console.log('  Pending authority:     ', state.pendingAuthority.toBase58());
  if (state.pendingAuthority.toBase58() !== TREASURY_PDA.toBase58()) {
    console.error('\n❌ pending_authority on-chain is NOT the treasury PDA.');
    console.error('   Run propose-authority.js --new-authority', TREASURY_PDA.toBase58(), 'first.');
    process.exit(1);
  }
  if (state.authority.toBase58() === TREASURY_PDA.toBase58()) {
    console.log('\nℹ️  Authority is already the treasury PDA. Migration already done. No-op.');
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

  // --- Build the accept_authority instruction ---
  // This is what the Realms proposal will execute when it passes 2-of-3. The
  // signer (TREASURY_PDA) is a Realms-owned PDA, so the SPL Governance program
  // will sign for it via invoke_signed when the proposal executes.
  const acceptIx = await program.methods
    .acceptAuthority()
    .accounts({
      newAuthority: TREASURY_PDA,
      mintState:    mintStatePda,
    })
    .instruction();

  console.log('\n=== Instruction to be wrapped in proposal ===');
  console.log('  program:', acceptIx.programId.toBase58());
  console.log('  accounts:');
  acceptIx.keys.forEach(k => console.log(
    `    ${k.pubkey.toBase58()}  signer=${k.isSigner} writable=${k.isWritable}`
  ));
  console.log('  data (hex):', acceptIx.data.toString('hex'));

  if (dryRun) {
    console.log('\n--dry-run set; not sending. Run again without --dry-run to actually create the proposal.');
    return;
  }

  if (!yes) {
    console.log('\n⚠️  This will create a Realms proposal on mainnet. Costs ~0.005 SOL in rent.');
    console.log('    After this, 2 of 3 council members must vote yes for the migration to complete.');
    if (vote) console.log('    --vote set: this script will cast 1 yes vote (yours) automatically.');
    const ok = await confirm('Proceed?');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  // --- Assemble proposal-creation transaction ---
  // Realms SDK appends instructions to an array; we send them as one tx.
  const txInstructions = [];

  // a) Create proposal: a new on-chain Proposal account inside this governance.
  //    proposalIndex = current proposal count on the governance (read from chain)
  const governanceAccountInfo = await connection.getAccountInfo(GOVERNANCE);
  // GovernanceV2 layout: proposals_count is a u32 at offset 65 (1 + 32 realm + 32 governed)
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
    COUNCIL_MINT,           // governing token mint = council (this is a council-vote proposal)
    proposer.publicKey,     // governance authority = proposer
    proposalIndex,
    VoteType.SINGLE_CHOICE,
    ['Approve'],            // single-choice yes/no options
    true,                   // useDenyOption = true (gives voters a "no" option)
    proposer.publicKey,     // payer
  );

  // b) Insert the accept_authority instruction at index 0, option 0 ("Approve")
  const instructionData = new InstructionData({
    programId: acceptIx.programId,
    accounts: acceptIx.keys.map(k => new AccountMetaData({
      pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable,
    })),
    data: acceptIx.data,
  });
  await withInsertTransaction(
    txInstructions,
    GOVERNANCE_PROGRAM_ID,
    programVersion,
    GOVERNANCE,
    proposalAddress,
    tokenOwnerRecord,
    proposer.publicKey,     // governance authority (proposer)
    0,                      // instruction index within the option
    0,                      // option index (0 = "Approve")
    0,                      // holdUpTime — instructions execute immediately after passing
    [instructionData],
    proposer.publicKey,     // payer
  );

  // c) Sign off: moves proposal from Draft → Voting state, opens it to council
  await withSignOffProposal(
    txInstructions,
    GOVERNANCE_PROGRAM_ID,
    programVersion,
    REALM,
    GOVERNANCE,
    proposalAddress,
    proposer.publicKey,     // signatory
    undefined,              // signatoryRecord (not used in default flow)
    tokenOwnerRecord,
  );

  // d) Optionally cast a yes vote (proposer is also a council member)
  if (vote) {
    await withCastVote(
      txInstructions,
      GOVERNANCE_PROGRAM_ID,
      programVersion,
      REALM,
      GOVERNANCE,
      proposalAddress,
      tokenOwnerRecord,    // proposalOwnerRecord (proposer is also the owner)
      tokenOwnerRecord,    // voterTokenOwnerRecord
      proposer.publicKey,  // governance authority
      COUNCIL_MINT,
      Vote.fromYesNoVote(YesNoVote.Yes),
      proposer.publicKey,  // payer
    );
  }

  // --- Send the assembled transaction ---
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
  console.log('  Or via CLI by running a similar script with their keypair.');
  console.log('\n  Once threshold passes, anyone can execute the proposal by clicking');
  console.log('  "Execute" in the UI — that triggers accept_authority on the TOBE program');
  console.log('  and migrates authority to the treasury PDA.');
  console.log('\n  Verify migration after execution:');
  console.log('    node scripts/verify-multisig.js --network mainnet --expected ' + TREASURY_PDA.toBase58());
}

main().catch(e => {
  console.error('\n❌ Failed:', e.message || e);
  if (e.logs) console.error('  Logs:', e.logs);
  process.exit(1);
});
