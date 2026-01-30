import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createNft, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { generateSigner, keypairIdentity, percentAmount } from "@metaplex-foundation/umi";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

const RPC = process.env.SOLANA_RPC_ENDPOINT;
const GATEWAY_URL = process.env.GATEWAY_URL;
const ASSET_SIG = process.env.ASSET_SIG;

if (!RPC) {
  console.error("SOLANA_RPC_ENDPOINT required");
  process.exit(1);
}
if (!GATEWAY_URL) {
  console.error("GATEWAY_URL required (e.g. https://pi.nubs.site/iq)");
  process.exit(1);
}
if (!ASSET_SIG) {
  console.error("ASSET_SIG required - run upload-test.ts first");
  process.exit(1);
}

async function main() {
  const umi = createUmi(RPC).use(mplTokenMetadata());

  const keypairPath = process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
  const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey));
  umi.use(keypairIdentity(keypair));

  console.log("Wallet:", keypair.publicKey.toString());
  const balance = await umi.rpc.getBalance(keypair.publicKey);
  console.log("Balance:", Number(balance.basisPoints) / 1e9, "SOL\n");

  const mint = generateSigner(umi);
  const metadataUri = `${GATEWAY_URL}/meta/${ASSET_SIG}.json`;

  console.log("Mint:", mint.publicKey.toString());
  console.log("URI:", metadataUri, "\n");

  const tx = await createNft(umi, {
    mint,
    name: "IQTEST NFT",
    symbol: "IQNFT",
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(5), // 5% royalty
    creators: [{ address: keypair.publicKey, verified: true, share: 100 }],
  }).sendAndConfirm(umi);

  console.log("Done! Tx:", Buffer.from(tx.signature).toString("base64"));
  console.log("\nExplorer: https://explorer.solana.com/address/" + mint.publicKey + "?cluster=devnet");
}

main().catch(console.error);
