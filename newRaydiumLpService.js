const { Connection, PublicKey } = require("@solana/web3.js");
const { MongoClient } = require("mongodb");
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"; // Solana System Program ID
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // Token Program ID
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA"; // Associated Token Program ID

let db;

async function connectToDatabase() {
    const mongoUri = process.env.MONGO_URI;
    const client = new MongoClient(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    try {
        if (!db) {
            throw new Error("Database connection is not initialized");
        }
        const collection = db.collection("raydium_lp_transactions");
        const result = await collection.insertOne(tokenData);

        if (result.acknowledged) {
            console.log("Token data saved to MongoDB:", result.insertedId);
        } else {
            console.error("Failed to save token data to MongoDB.");
        }
    } catch (error) {
        console.error("Error saving token data to MongoDB:", error.message);
    }
}

function invertCoinAndPcMint(tokenData) {
    const SPECIAL_COIN_MINT = "So11111111111111111111111111111111111111112";
    if (tokenData.coinMint === SPECIAL_COIN_MINT) {
        [tokenData.coinMint, tokenData.pcMint] = [tokenData.pcMint, tokenData.coinMint];
    }
    return tokenData;
}

async function fetchTokenAmount(tokenAccountPubkey) {
    const tokenAccountInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAccountPubkey));
    const tokenAmount = tokenAccountInfo.value.data.parsed.info.tokenAmount.uiAmount;
    return tokenAmount;
}

async function processRaydiumLpTransaction(connection, signature) {
    try {
        const transactionDetails = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!transactionDetails) {
            console.error("No transaction details found for signature:", signature);
            return;
        }

        const message = transactionDetails.transaction.message;
        const accounts = message.staticAccountKeys
            ? message.staticAccountKeys.map((key) => key.toString())
            : message.accountKeys.map((key) => key.toString());

        const instructions = message.compiledInstructions || message.instructions;

        if (!instructions) {
            console.error("No instructions found in transaction");
            return;
        }

        console.log("Transaction Message:", message);
        console.log("Accounts:", accounts);

        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];

            if (programId === RAYDIUM_AMM_PROGRAM_ID.toString() && ix.data.length > 0) {
                const accountIndices = ix.accounts || ix.accountKeyIndexes;

                if (!accountIndices) {
                    console.error("No account indices found in instruction");
                    continue;
                }

                const mint0 = accounts[accountIndices[8]]; // Base token mint
                const mint1 = accounts[accountIndices[9]]; // Quote token mint
                const lpTokenMint = accounts[accountIndices[7]]; // LP token mint
                const deployer = accounts[accountIndices[17]]; // Deployer's address
                const poolId = accounts[accountIndices[4]]; // AMM pool ID
                const baseVault = accounts[accountIndices[10]]; // Base token vault
                const quoteVault = accounts[accountIndices[11]]; // Quote token vault
                const ammAuthority = accounts[accountIndices[5]]; // AMM authority
                const ammTarget = accounts[accountIndices[13]]; // AMM target orders
                const ammOpenOrder = accounts[accountIndices[6]]; // AMM open orders

                const baseAmount = await fetchTokenAmount(baseVault);
                const quoteAmount = await fetchTokenAmount(quoteVault);

                const K = baseAmount * quoteAmount; // Calculate K
                const V = Math.min(baseAmount, quoteAmount) / Math.max(baseAmount, quoteAmount); // Calculate V

                let tokenData = {
                    programId: new PublicKey(accounts[accountIndices[0]]).toString(), // Raydium AMM Program ID
                    ammId: new PublicKey(poolId).toString(), // AMM Pool Account
                    ammAuthority: new PublicKey(ammAuthority).toString(), // AMM Authority Account
                    ammOpenOrders: new PublicKey(ammOpenOrder).toString(),
                    lpMint: new PublicKey(lpTokenMint).toString(), // LP Token Mint
                    coinMint: new PublicKey(mint0).toString(), // Base Token Mint
                    pcMint: new PublicKey(mint1).toString(), // Quote Token Mint
                    coinVault: new PublicKey(baseVault).toString(), // Base Token Vault
                    pcVault: new PublicKey(quoteVault).toString(), // Quote Token Vault
                    ammTargetOrders: new PublicKey(ammTarget).toString(),
                    deployer: new PublicKey(deployer).toString(), // Deployer's Address
                    systemProgramId: SYSTEM_PROGRAM_ID, // System Program ID
                    tokenProgramId: TOKEN_PROGRAM_ID_STR, // Token Program ID
                    associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR, // Associated Token Program ID
                    baseAmount: baseAmount, // Base Token Amount
                    quoteAmount: quoteAmount, // Quote Token Amount
                    K: K, // Product of Base and Quote Token Amounts ; Ratio for price calculation (LP system of re-balancing)
                    V: V, // Division of Smaller Amount by Larger Amount ; Price of 1 token at launch
                };

                tokenData = invertCoinAndPcMint(tokenData);

                await saveToMongo(tokenData);
                return tokenData;
            }
        }
    } catch (error) {
        if (error.message.includes("Cannot read properties of undefined (reading '_bn')")) {
            console.log("Encountered '_bn' error, ignoring transaction:", signature);
        } else {
            console.error("Error fetching/processing transaction:", error.message);
        }
    }
}

module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
};
