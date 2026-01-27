import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mintV1, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { readFileSync } from "fs";

const RPC = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";
const MINT = "2d9sJRPJrgCFrD6qmu2hjitSAhestdYsNDEiPEE8EMuG";
const AMOUNT = 1_000_000_000n * 1_000_000n; // 1 million tokens (9 decimals)

async function main() {
  const umi = createUmi(RPC).use(mplTokenMetadata());

  const keypairPath = process.env.KEYPAIR_PATH || "" + require("os").homedir() + "/.config/solana/id.json";
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
  const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey));
  umi.use(keypairIdentity(keypair));

  console.log("Minting tokens...");
  console.log("Mint:", MINT);
  console.log("To:", keypair.publicKey.toString());
  console.log("Amount: 1,000,000 IQTEST\n");

  const tx = await mintV1(umi, {
    mint: publicKey(MINT),
    amount: AMOUNT,
    tokenOwner: keypair.publicKey,
    tokenStandard: { __kind: "Fungible" },
  }).sendAndConfirm(umi);

  console.log("Done! Tx:", Buffer.from(tx.signature).toString("base64"));
}

main().catch(console.error);
