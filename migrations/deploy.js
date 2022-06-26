// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

const anchor = require("@project-serum/anchor");
const {
  findProgramAddressSync,
} = require("@project-serum/anchor/dist/cjs/utils/pubkey");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const STAKING_PDA_SEED = Buffer.from(anchor.utils.bytes.utf8.encode("staking"));

module.exports = async function (provider) {
  const { TOKEN_MINT_ADDRESS, LOCK_END_DATE } = process.env;
  if (!TOKEN_MINT_ADDRESS)
    throw new Error("missing ENV variable TOKEN_MINT_ADDRESS");

  // Configure client to use the provider.
  anchor.setProvider(provider);
  const program = anchor.workspace.MonkeyStaking;
  const findPDA = (seeds) => findProgramAddressSync(seeds, program.programId);

  const mintPubkey = new anchor.web3.PublicKey(TOKEN_MINT_ADDRESS);
  const [vaultPubkey, vaultBump] = findPDA([mintPubkey.toBuffer()]);

  const [stakingPubkey, stakingBump] = findPDA([STAKING_PDA_SEED]);
  const lockEndDate = new anchor.BN(LOCK_END_DATE);
  const humanLockEndDate = new Date(lockEndDate.toNumber() * 1000);

  const initializer = provider.wallet.publicKey;

  console.log("Initializing staking contract with:");
  console.log("ProgramID:", program.programId.toBase58());
  console.log("Initializer:", initializer.toBase58());
  console.log("Token:", mintPubkey.toBase58());
  console.log("StakingPubkey:", stakingPubkey.toBase58());
  console.log("Lock end date:", lockEndDate.toString(), humanLockEndDate);

  // Uncomment to call updateLockEndDate
  // await program.rpc.updateLockEndDate(stakingBump, lockEndDate, {
  //   accounts: {
  //     initializer: provider.wallet.publicKey,
  //     stakingAccount: stakingPubkey,
  //   },
  // });
  await program.rpc.initialize(stakingBump, lockEndDate, mintPubkey, {
    accounts: {
      tokenMint: mintPubkey,
      tokenVault: vaultPubkey,
      stakingAccount: stakingPubkey,
      initializer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    },
  });
};
