import * as anchor from "@project-serum/anchor";
import { TOKEN_PROGRAM_ID, Token, MintLayout } from "@solana/spl-token";

type AnchorProvider = anchor.AnchorProvider;

export async function mintToAccount(
  provider: AnchorProvider,
  mint: anchor.web3.PublicKey,
  destination: anchor.web3.PublicKey,
  amount: number
) {
  const tx = new anchor.web3.Transaction();
  tx.add(
    Token.createMintToInstruction(
      TOKEN_PROGRAM_ID,
      mint,
      destination,
      provider.wallet.publicKey,
      [],
      amount
    )
  );
  await provider.sendAndConfirm(tx);
}

export async function sendLamports(
  provider: AnchorProvider,
  destination: anchor.web3.PublicKey,
  amount: number
) {
  const tx = new anchor.web3.Transaction();
  tx.add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: amount,
      toPubkey: destination,
    })
  );
  await provider.sendAndConfirm(tx);
}

export async function createMint(
  mintAccount: anchor.web3.Keypair,
  provider: AnchorProvider,
  mintAuthority: anchor.web3.PublicKey,
  freezeAuthority: anchor.web3.PublicKey,
  decimals: number,
  programId: anchor.web3.PublicKey
) {
  const payer: anchor.web3.Keypair = (provider.wallet as any).payer;

  const token = new Token(
    provider.connection,
    mintAccount.publicKey,
    programId,
    payer
  );

  const balanceNeeded = await Token.getMinBalanceRentForExemptMint(
    provider.connection
  );

  const transaction = new anchor.web3.Transaction();
  transaction.add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintAccount.publicKey,
      lamports: balanceNeeded,
      space: MintLayout.span,
      programId,
    })
  );

  transaction.add(
    Token.createInitMintInstruction(
      programId,
      mintAccount.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority
    )
  );

  await provider.sendAndConfirm(transaction, [mintAccount]);
  return token;
}
