import "dotenv/config";
import { Connection, Keypair } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { readFileSync } from "fs";
import { homedir } from "os";

const { writer } = iqlabs;

const RPC = process.env.SOLANA_RPC_ENDPOINT;
if (!RPC) {
  console.error("SOLANA_RPC_ENDPOINT required");
  process.exit(1);
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  json: "application/json",
  txt: "text/plain",
};

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: bun run scripts/upload-test.ts <file-path>");
    process.exit(1);
  }

  const keypairPath = process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(RPC, "confirmed");

  console.log("Wallet:", keypair.publicKey.toString());

  const fileData = readFileSync(filePath);
  const fileStr = fileData.toString("base64");
  const fileName = filePath.split("/").pop() || "file";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  console.log("Uploading:", filePath, `(${fileData.length} bytes, ${mimeType})`);

  const result = await writer.codeIn(
    { connection, signer: keypair },
    fileStr,
    undefined,
    fileName,
    0,
    mimeType,
    (percent) => console.log(`Progress: ${percent}%`)
  );

  console.log("\nDone!");
  console.log("TX Signature:", result);
}

main().catch(console.error);
