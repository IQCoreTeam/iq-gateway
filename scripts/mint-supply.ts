import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mintV1, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { readFileSync } from "fs";
import { homedir } from "os";

const RPC = process.env.SOLANA_RPC_ENDPOINT;
const MINT = process.env.MINT_ADDRESS;
const AMOUNT = BigInt(process.env.MINT_AMOUNT || "0");

if (!RPC) {
  console.error("SOLANA_RPC_ENDPOINT required");
  process.exit(1);
}
if (!MINT) {
  console.error("MINT_ADDRESS required");
  process.exit(1);
}
if (!AMOUNT || AMOUNT === 0n) {
  console.error("MINT_AMOUNT required (raw amount with decimals, e.g. 1000000000000000 for 1M tokens with 9 decimals)");
  process.exit(1);
}

async function main() {
  const umi = createUmi(RPC).use(mplTokenMetadata());

  const keypairPath = process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`;
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
