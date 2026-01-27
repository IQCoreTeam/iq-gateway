import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { readFileSync } from "fs";

const { writer } = iqlabs;

const RPC = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";

async function main() {
  const keypairPath = process.env.KEYPAIR_PATH || "/home/linbox/.config/solana/id.json";
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(RPC, "confirmed");

  console.log("Wallet:", keypair.publicKey.toString());
  console.log("RPC:", RPC);

  const filePath = process.argv[2] || "test.svg";
  const fileData = readFileSync(filePath);
  const fileStr = fileData.toString("base64");

  console.log("Uploading:", filePath, `(${fileData.length} bytes)`);

  // Split into chunks (single chunk for small files)
  const chunks = [fileStr];

  const result = await writer.codeIn(
    { connection, signer: keypair },
    chunks,
    undefined, // mode (default)
    filePath.split("/").pop() || "test.svg",
    0, // method
    "image/svg+xml",
    (percent) => console.log(`Progress: ${percent}%`)
  );

  console.log("\nDone!");
  console.log("TX Signature:", result);
  console.log("\nTest with:");
  console.log(`curl https://pi.nubs.site/iq/meta/${result}.json`);
}

main().catch(console.error);
