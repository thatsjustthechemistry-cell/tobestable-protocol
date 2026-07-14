const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

async function main() {
  // Config
  const PROGRAM_ID = new PublicKey("DnMvWs2dDim57TLBcJp7FKkDUFw2KnLmJybzpbTZuc65");
  const AUTHORITY  = new PublicKey("Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf");
  const TREASURY   = new PublicKey("Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf");
  const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

  // Load deploy wallet (payer/signer)
  const keypairPath = path.join(process.env.USERPROFILE || process.env.HOME, ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Payer:", payer.publicKey.toBase58());

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "neco_token.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  // Generate a new TOBE mint keypair
  const tobeMint = Keypair.generate();
  console.log("TOBE Mint:", tobeMint.publicKey.toBase58());

  // Derive PDAs
  const [mintState]      = PublicKey.findProgramAddressSync([Buffer.from("mint_state")],      PROGRAM_ID);
  const [mintAuthority]  = PublicKey.findProgramAddressSync([Buffer.from("mint_authority")],  PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const [vaultToken]     = PublicKey.findProgramAddressSync([Buffer.from("vault_token")],     PROGRAM_ID);
  const [lpLockAuthority]= PublicKey.findProgramAddressSync([Buffer.from("lp_lock_authority")],PROGRAM_ID);

  // Metaplex metadata PDA
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), tobeMint.publicKey.toBuffer()],
    MPL_TOKEN_METADATA_ID
  );

  console.log("MintState PDA:     ", mintState.toBase58());
  console.log("MintAuthority PDA: ", mintAuthority.toBase58());
  console.log("VaultToken PDA:    ", vaultToken.toBase58());

  console.log("\nSending initialize transaction...");
  const tx = await program.methods
    .initialize(TREASURY, AUTHORITY, AUTHORITY, new PublicKey('Eis6SPak12JXqunZqLqgHneomygF1ouuoRk5PFXB5Bvf'))
    .accounts({
      authority:            payer.publicKey,
      mintState:            mintState,
      tobeMint:             tobeMint.publicKey,
      mintAuthority:        mintAuthority,
      vaultAuthority:       vaultAuthority,
      vaultTokenAccount:    vaultToken,
      lpLockAuthority:      lpLockAuthority,
      metadata:             metadata,
      tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
      program:              PROGRAM_ID,
      programData:          PublicKey.findProgramAddressSync(
        [PROGRAM_ID.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
      )[0],
      tokenProgram:         new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      systemProgram:        anchor.web3.SystemProgram.programId,
      rent:                 anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([tobeMint])
    .rpc();

  console.log("\n✅ Initialized!");
  console.log("Tx:", tx);
  console.log("TOBE Mint address (save this!):", tobeMint.publicKey.toBase58());
}

main().catch(console.error);
