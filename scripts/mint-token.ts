import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createFungible, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { generateSigner, keypairIdentity, percentAmount } from "@metaplex-foundation/umi";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const RPC = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000";
const ASSET_SIG = process.env.ASSET_SIG || "52WXtc2TvQbYU3hsTVYLxqSYVCtK6sd3bHUfKZL5LXqR5vfKhCqbSeQpRmzciUpbmgqUxuphvJmX4zWp2a5oJdPp";

async function main() {
  console.log("Creating token on devnet...\n");

  const umi = createUmi(RPC).use(mplTokenMetadata());

  // Load keypair from default Solana CLI path
  const keypairPath = process.env.KEYPAIR_PATH || join(homedir(), ".config/solana/id.json");
  if (!existsSync(keypairPath)) {
    console.error("No keypair found at:", keypairPath);
    console.error("Run: solana-keygen new");
    process.exit(1);
  }

  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
  const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey));
  umi.use(keypairIdentity(keypair));

  console.log("Wallet:", keypair.publicKey.toString());
  const balance = await umi.rpc.getBalance(keypair.publicKey);
  console.log("Balance:", Number(balance.basisPoints) / 1e9, "SOL\n");

  if (Number(balance.basisPoints) < 0.01e9) {
    console.error("Need SOL! Run: solana airdrop 2 --url devnet");
    process.exit(1);
  }

  const mint = generateSigner(umi);
  const metadataUri = `${GATEWAY_URL}/meta/${ASSET_SIG}.json`;

  console.log("Mint:", mint.publicKey.toString());
  console.log("URI:", metadataUri, "\n");

  const tx = await createFungible(umi, {
    mint,
    name: "IQ Test Token",
    symbol: "IQTEST",
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: 9,
  }).sendAndConfirm(umi);

  console.log("Done! Tx:", Buffer.from(tx.signature).toString("base64"));
  console.log("\nExplorer: https://explorer.solana.com/address/" + mint.publicKey + "?cluster=devnet");
}

main().catch(console.error);
