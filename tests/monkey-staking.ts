import * as anchor from "@project-serum/anchor";
import { IdlAccounts, Program } from "@project-serum/anchor";

import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as utils from "./utils";
import * as assert from "assert";
import * as fs from "fs";

import {
  MonkeyStaking,
  IDL as MonkeyStakingIDL,
} from "../target/types/monkey_staking";
import { before } from "mocha";
import { readKeypairFromFile } from "./helpers";
type MonkeyStakingIdlAccounts = IdlAccounts<MonkeyStaking>;

const TOKEN_DECIMALS = 9;
const TOKEN_FACTOR = Math.pow(10, TOKEN_DECIMALS);

describe("monkey-staking", () => {
  //Read the provider from the configured environmnet.
  //represents an outside actor
  //owns mints out of any other actors control, provides initial $$ to others
  const envProvider = anchor.AnchorProvider.env();
  // Configure the client to use the envProvider
  anchor.setProvider(envProvider);
  const program = anchor.workspace.MonkeyStaking as Program<MonkeyStaking>;

  async function getTokenBalance(pubkey: anchor.web3.PublicKey) {
    return parseInt(
      (await envProvider.connection.getTokenAccountBalance(pubkey)).value.amount
    );
  }

  async function fundWallet(address: anchor.web3.PublicKey) {
    return utils.sendLamports(envProvider, address, 10 * LAMPORTS_PER_SOL);
  }

  function programPaidBy(
    payer: anchor.web3.Keypair
  ): anchor.Program<MonkeyStaking> {
    const newProvider = new anchor.AnchorProvider(
      envProvider.connection,
      new anchor.Wallet(payer),
      {}
    );
    return new anchor.Program(MonkeyStakingIDL, program.programId, newProvider);
  }

  //hardcoded in program, read from test keys directory for testing
  let mintKey = readKeypairFromFile("tests/keys/token.json");
  let mintObject: Token;
  let mintPubkey;

  //the program's vault for stored collateral against xToken minting
  let vaultPubkey;
  let vaultBump;

  //the program's account for stored initializer key and lock end date
  let stakingPubkey;
  let stakingBump;

  let walletTokenAccount: anchor.web3.PublicKey;

  let programListeners = [];
  after(async () => {
    programListeners.forEach((listener) => {
      program.removeEventListener(listener);
    });

    // console.log("Waiting for logs...");
    // await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  before(async () => {
    //setup logging event listeners
    programListeners.push(
      program.addEventListener("PriceChange", (e, s) => {
        const oldInt = parseInt(e.oldTokenPerPoolShareE9);
        const oldFloat = parseFloat(e.oldTokenPerPoolShare);
        const newInt = parseInt(e.newTokenPerPoolShareE9);
        const newFloat = parseFloat(e.newTokenPerPoolShare);
        // console.log(
        //   JSON.stringify({
        //     event: "PriceChange",
        //     slot: s.toString(),
        //     old: `(${oldInt}, ${oldFloat})`,
        //     new: `(${newInt}, ${newFloat})`,
        //   })
        // );
      })
    );

    mintObject = await utils.createMint(
      mintKey,
      envProvider,
      envProvider.wallet.publicKey,
      null,
      TOKEN_DECIMALS,
      TOKEN_PROGRAM_ID
    );
    mintPubkey = mintObject.publicKey;

    [vaultPubkey, vaultBump] = await anchor.web3.PublicKey.findProgramAddress(
      [mintPubkey.toBuffer()],
      program.programId
    );

    [stakingPubkey, stakingBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from(anchor.utils.bytes.utf8.encode("staking"))],
        program.programId
      );

    let lockEndDate = new anchor.BN(Date.now() / 1000 + 1000);
    await program.rpc.initialize(stakingBump, lockEndDate, mintPubkey, {
      accounts: {
        tokenMint: mintPubkey,
        tokenVault: vaultPubkey,
        stakingAccount: stakingPubkey,
        initializer: envProvider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
    });

    walletTokenAccount = await mintObject.createAssociatedTokenAccount(
      envProvider.wallet.publicKey
    );
    await utils.mintToAccount(
      envProvider,
      mintPubkey,
      walletTokenAccount,
      100_000_000_000
    );
  });

  async function createTokenAccount(publicKey: anchor.web3.PublicKey) {
    return mintObject.createAssociatedTokenAccount(publicKey);
  }

  async function mintTokenToWallet(
    publicKey: anchor.web3.PublicKey,
    amount: number
  ) {
    return utils.mintToAccount(envProvider, mintPubkey, publicKey, amount);
  }

  async function createUser() {
    const keypair = new anchor.web3.Keypair();
    const program = programPaidBy(keypair);
    const [userStakingPubkey, userStakingBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [keypair.publicKey.toBuffer()],
        program.programId
      );
    const { associatedProgramId, programId, publicKey: mint } = mintObject;
    const tokenAccount = await Token.getAssociatedTokenAddress(
      associatedProgramId,
      programId,
      mint,
      keypair.publicKey
    );
    return {
      keypair,
      program,
      userStakingPubkey,
      userStakingBump,
      tokenAccount,
    };
  }

  specify("allows initializer to update lock_end_date", async () => {
    let newLockEndDate = new anchor.BN(Date.now() / 1000);
    await program.methods
      .updateLockEndDate(stakingBump, newLockEndDate)
      .accounts({
        stakingAccount: stakingPubkey,
      })
      .rpc();
    let stakingAccount = await program.account.stakingAccount.fetch(
      stakingPubkey
    );
    assert.strictEqual(
      stakingAccount.lockEndDate.toNumber(),
      newLockEndDate.toNumber()
    );
  });

  specify("allows initialize to freeze/unfreeze the program", async () => {
    assert.strictEqual((await stakingAccount()).freezeProgram, false);

    await program.methods
      .toggleFreezeProgram(stakingBump, true)
      .accounts({ stakingAccount: stakingPubkey })
      .rpc();
    assert.strictEqual((await stakingAccount()).freezeProgram, true);

    await program.methods
      .toggleFreezeProgram(stakingBump, false)
      .accounts({ stakingAccount: stakingPubkey })
      .rpc();
    assert.strictEqual((await stakingAccount()).freezeProgram, false);
  });

  specify("allows admin to change admin key", async () => {
    const newAdmin = anchor.web3.Keypair.generate();
    await fundWallet(newAdmin.publicKey);
    try {
      await program.methods
        .updateAdmin(stakingBump, newAdmin.publicKey)
        .accounts({ stakingAccount: stakingPubkey })
        .rpc();
      assert.strictEqual(
        (await stakingAccount()).initializerKey,
        newAdmin.publicKey
      );
    } catch (_err) {
      const programWithNewAdmin = programPaidBy(newAdmin);
      await programWithNewAdmin.methods
        .updateAdmin(stakingBump, envProvider.wallet.publicKey)
        .accounts({ stakingAccount: stakingPubkey })
        .rpc();
    }
  });

  context("given a user", () => {
    let user: Awaited<ReturnType<typeof createUser>>;

    before(async () => {
      user = await createUser();
      fundWallet(user.keypair.publicKey);

      await createTokenAccount(user.keypair.publicKey);
      await mintTokenToWallet(user.tokenAccount, 1_500 * TOKEN_FACTOR);
    });

    specify("user can stake tokens", async () => {
      const amount = new anchor.BN(500 * TOKEN_FACTOR);
      await stake(user, amount);

      let userStakingAccount = await getUserStakingAccount(
        user.userStakingPubkey
      );

      assert.strictEqual(
        userStakingAccount.amount.toNumber(),
        amount.toNumber()
      );
      assert.strictEqual(
        await getTokenBalance(user.tokenAccount),
        1_000 * TOKEN_FACTOR
      );
      assert.strictEqual(
        userStakingAccount.poolSharesAmount.toNumber(),
        amount.toNumber()
      );
      assert.strictEqual(
        await getTokenBalance(vaultPubkey),
        500 * TOKEN_FACTOR
      );
    });

    specify("user can unstake tokens", async () => {
      //ensure we are not before lock date
      assert.ok((await currentLockEndDate()) < Date.now() / 1000);

      const initialVaultBalance = await getTokenBalance(vaultPubkey);
      const initialShares = await getUserStakingPoolShareAmount(user);
      const initialUserAmount = await getUserStakingAmount(user);
      const initialUserTokenBalance = await getTokenBalance(user.tokenAccount);

      const amount = new anchor.BN(500 * TOKEN_FACTOR);
      await stake(user, amount);

      const shares = (await getUserStakingPoolShareAmount(user)).sub(
        initialShares
      );
      await unstake(user, shares);

      assert.ok(
        initialUserAmount.eq(await getUserStakingAmount(user)),
        "user's tokens in pool should return to same value"
      );

      assert.ok(
        (await getTokenBalance(user.tokenAccount)) === initialUserTokenBalance,
        "user's tokens in wallet should return to same value"
      );

      assert.ok(
        initialShares.eq(await getUserStakingPoolShareAmount(user)),
        "user's shares in pool should return to same value"
      );

      assert.ok(
        initialVaultBalance === (await getTokenBalance(vaultPubkey)),
        "vault's token balance should return to same value"
      );
    });

    context("when program is frozen", () => {
      before(async () => {
        // Let the user stake some before we freeze the program so we can test unstake
        await stake(user, new anchor.BN(500 * TOKEN_FACTOR));
        await program.methods
          .toggleFreezeProgram(stakingBump, true)
          .accounts({ stakingAccount: stakingPubkey })
          .rpc();
        assert.strictEqual((await stakingAccount()).freezeProgram, true);
      });

      after(async () => {
        await program.methods
          .toggleFreezeProgram(stakingBump, false)
          .accounts({ stakingAccount: stakingPubkey })
          .rpc();
        assert.strictEqual((await stakingAccount()).freezeProgram, false);
      });

      specify("user cannot stake", async () => {
        const amount = new anchor.BN(500 * TOKEN_FACTOR);

        await assert.rejects(
          stake(user, amount),
          (result: anchor.AnchorError): boolean => {
            const errorCode = result.error.errorCode;
            assert.strictEqual(errorCode.number, 6002);
            assert.strictEqual(errorCode.code, "ProgramIsFrozen");
            return true;
          }
        );
      });

      specify("user cannot unstake", async () => {
        const amount = new anchor.BN(500 * TOKEN_FACTOR);
        let userStakingAccount;
        userStakingAccount = await getUserStakingAccount(
          user.userStakingPubkey
        );

        await assert.rejects(
          unstake(user, userStakingAccount.poolSharesAmount),
          (result: anchor.AnchorError): boolean => {
            const errorCode = result.error.errorCode;
            assert.strictEqual(errorCode.number, 6002);
            assert.strictEqual(errorCode.code, "ProgramIsFrozen");
            return true;
          }
        );
      });
    });

    context("before lock_end_date", () => {
      before(async () => {
        //set lock end date to 5 minutes from now
        let newLockEndDate = new anchor.BN(
          Math.floor(Date.now() / 1000) + 5 * 60
        );
        await updateLockEndDate(newLockEndDate);
      });

      specify("user can stake", async () => {
        const amount = new anchor.BN(500 * TOKEN_FACTOR);
        await stake(user, amount);
      });

      specify("user cannot unstake", async () => {
        const amount = new anchor.BN(500 * TOKEN_FACTOR);
        let userStakingAccount;
        userStakingAccount = await getUserStakingAccount(
          user.userStakingPubkey
        );

        await assert.rejects(
          unstake(user, userStakingAccount.poolSharesAmount),
          (result: anchor.AnchorError): boolean => {
            const errorCode = result.error.errorCode;
            assert.strictEqual(errorCode.number, 6000);
            assert.strictEqual(errorCode.code, "NotExceedLockEndDate");
            return true;
          }
        );
      });
    });
  });

  async function stakingAccount() {
    return program.account.stakingAccount.fetch(stakingPubkey);
  }

  async function getUserStakingAccount(address: anchor.Address) {
    return program.account.userStakingAccount.fetch(address);
  }

  async function currentLockEndDate() {
    return (await stakingAccount()).lockEndDate.toNumber();
  }

  async function getUserStakingPoolShareAmount(
    user: Awaited<ReturnType<typeof createUser>>
  ): Promise<anchor.BN> {
    return (await getUserStakingAccount(user.userStakingPubkey))
      .poolSharesAmount;
  }

  async function getUserStakingAmount(
    user: Awaited<ReturnType<typeof createUser>>
  ): Promise<anchor.BN> {
    return (await getUserStakingAccount(user.userStakingPubkey)).amount;
  }

  async function updateLockEndDate(newLockEndDate: anchor.BN) {
    return program.methods
      .updateLockEndDate(stakingBump, newLockEndDate)
      .accounts({
        stakingAccount: stakingPubkey,
      })
      .rpc();
  }

  async function stake(
    user: Awaited<ReturnType<typeof createUser>>,
    amount: anchor.BN
  ) {
    return user.program.methods
      .stake(stakingBump, user.userStakingBump, amount)
      .accounts({
        tokenMint: mintPubkey,
        tokenFrom: user.tokenAccount,
        tokenFromAuthority: user.keypair.publicKey,
        tokenVault: vaultPubkey,
        stakingAccount: stakingPubkey,
        userStakingAccount: user.userStakingPubkey,
      })
      .signers([user.keypair])
      .rpc();
  }

  async function unstake(
    user: Awaited<ReturnType<typeof createUser>>,
    amount: anchor.BN
  ) {
    return user.program.methods
      .unstake(stakingBump, user.userStakingBump, amount)
      .accounts({
        tokenMint: mintPubkey,
        tokenTo: user.tokenAccount,
        tokenVault: vaultPubkey,
        stakingAccount: stakingPubkey,
        userStakingAccount: user.userStakingPubkey,
      })
      .signers([user.keypair])
      .rpc();
  }
});
